import { readFile } from "node:fs/promises";
import JSZip from "jszip";
import { expect, test, type Page } from "@playwright/test";
import { useSupabaseFixtures as loadSupabaseFixtures, TEST_USER } from "./support/supabaseFixtures";
import { hideWrongProjectBanner, json } from "./support/specHelpers";

test.use({ timezoneId: "America/Denver" });
test.setTimeout(60_000);
const id = (n: number) => `bbbbbbbb-bbbb-4bbb-8bbb-${String(n).padStart(12, "0")}`;
async function fixtures(page: Page, language: "en" | "es" = "en", role: "owner" | "installer" = "owner") {
  await page.clock.install({ time: new Date("2026-09-16T16:00:00Z") });
  await loadSupabaseFixtures(page, { role, language });
  await hideWrongProjectBanner(page);
  const people = [{ id: TEST_USER.id, display_name: "Fixture Manager", role, active: true },
    { id: id(1), display_name: "Historical Crew Member", role: "installer", active: false }].map(p => ({ ...p, language }));
  const projects = [{ id: id(10), job_code: "JOB-A", name: "A long project name for a mobile hours report", status: "active" },
    { id: id(11), job_code: "JOB-B", name: "Finished job", status: "completed" },
    { id: id(12), job_code: "JOB-C", name: "No hours yet", status: "active" }].map(p => ({ ...p, is_test: false, allowed_modes: ["tracking"], job_kind: "residential" }));
  let rows = [
    { id: id(100), profile_id: TEST_USER.id, project_id: id(10), clock_in_at: "2026-09-14T12:00:00Z", clock_out_at: "2026-09-14T20:00:00Z", status: "approved" },
    { id: id(101), profile_id: id(1), project_id: id(10), clock_in_at: "2026-09-15T12:00:00Z", clock_out_at: "2026-09-15T16:00:00Z", status: "submitted" },
    { id: id(102), profile_id: id(1), project_id: id(11), clock_in_at: "2026-09-01T12:00:00Z", clock_out_at: "2026-09-01T18:00:00Z", status: "approved" },
    { id: id(103), profile_id: TEST_USER.id, project_id: id(10), clock_in_at: "2026-09-16T12:00:00Z", clock_out_at: null, status: "open" },
  ].map(s => ({ ...s, project_id: s.project_id as string | null, break_seconds: s.id === id(100) ? 1800 : 0, break_started_at: null, cost_code_id: id(20),
    profiles: { display_name: people.find(p => p.id === s.profile_id)!.display_name },
    projects: projects.find(p => p.id === s.project_id) ?? null, cost_codes: { code: "1", label: "Installation" }, created_at: s.clock_in_at }));
  await page.route("**/rest/v1/profiles**", r => { const who = new URL(r.request().url()).searchParams.get("id")?.slice(3); return json(r, who ? people.find(p => p.id === who) : people, people.length); });
  await page.route("**/rest/v1/projects**", r => json(r, projects, projects.length));
  await page.route("**/rest/v1/time_shifts**", r => {
    const p = new URL(r.request().url()).searchParams;
    const data = rows.filter(s => {
      if (p.get("clock_out_at") === "is.null" && s.clock_out_at) return false;
      if (p.get("profile_id")?.startsWith("eq.") && s.profile_id !== p.get("profile_id")!.slice(3)) return false;
      return p.getAll("clock_in_at").every(d => d.startsWith("gte.") ? s.clock_in_at >= d.slice(4) : !d.startsWith("lt.") || s.clock_in_at < d.slice(3));
    });
    const offset = Number(p.get("offset") ?? 0);
    return json(r, r.request().headers().accept?.includes("object") ? data[0] ?? null : data.slice(offset, offset + 2), data.length);
  });
  return {
    closeRunning: () => { rows = rows.map(s => s.status === "open" ? { ...s, status: "submitted", clock_out_at: "2026-09-16T16:00:00Z" } : s); },
    addShift: (projectId: string | null, start: string, end: string) => rows.push({
      ...rows[0], id: id(200 + rows.length), project_id: projectId, projects: projects.find(p => p.id === projectId) ?? null,
      clock_in_at: start, clock_out_at: end, created_at: start,
    }),
  };
}

for (const [width, language] of [[375,"en"],[390,"es"],[1280,"en"]] as const) {
  test(`export dates, people, CSV and printable report at ${width}px ${language}`, async ({page}) => {
    await page.setViewportSize({width,height:844}); await fixtures(page,language); await page.goto('/team-timecards');
    const es=language==='es';
    await page.getByRole('button',{name:es?'Exportar registros de tiempo':'Export time entries',exact:true}).click();
    const dialog=page.getByRole('dialog');
    await expect(dialog).toContainText('11:30');
    await expect(dialog).toContainText(es?'1 registros sin terminar':'1 unfinished entries');
    await dialog.getByLabel(es?'Fecha inicial':'From date',{exact:true}).fill('2026-09-01');
    await expect(dialog).toContainText('17:30'); // Server sends just 2 rows per page.
    await dialog.screenshot({path:`/tmp/forge-time-export-${width}-${language}.png`});
    expect(await dialog.evaluate(el=>el.scrollWidth<=el.clientWidth)).toBe(true);
    const dl=page.waitForEvent('download'); await dialog.getByRole('button',{name:es?'Descargar CSV':'Download CSV',exact:true}).click();
    const csv=await readFile((await (await dl).path())!,'utf8');
    expect(csv).toContain('Employee Id,First Name,Last Name,Start,End,Break,Total');
    expect(csv).toContain('2026-09-14 06:00,2026-09-14 14:00,00:30,07:30');
    expect(csv).toContain('Historical,Crew Member'); expect(csv).toContain('Finished job'); expect(csv).not.toContain('2026-09-16 06:00');
    const popup=page.waitForEvent('popup'); await dialog.getByRole('button',{name:es?'Vista Forge / PDF':'Forge preview / PDF'}).click();
    const report=await popup; await expect(report.getByText('Total recorded time: 17:30')).toBeVisible();
    await report.setViewportSize({width:1280,height:900}); await report.screenshot({path:`/tmp/forge-time-export-report-${width}.png`});
    if(width===1280) await report.pdf({path:'/tmp/forge-time-export-report.pdf',landscape:true,printBackground:true});
    await report.close();
    await dialog.locator('summary').click();
    await dialog.getByRole('button',{name:es?'Quitar selección':'Clear selection',exact:true}).click();
    await expect(dialog.getByRole('button',{name:es?'Descargar CSV':'Download CSV',exact:true})).toBeDisabled();
    await dialog.getByRole('checkbox',{name:'Historical Crew Member'}).check(); await expect(dialog).toContainText('10:00');
    await dialog.locator('summary').click();
    const zipDownload=page.waitForEvent('download'); await dialog.getByRole('button',{name:/ZIP/}).click();
    const zip=await JSZip.loadAsync(await readFile((await (await zipDownload).path())!));
    expect(Object.keys(zip.files)).toHaveLength(1);
    const personCsv=await Object.values(zip.files)[0].async('string'); expect(personCsv).toContain('Historical,Crew Member'); expect(personCsv).not.toContain('Fixture,Manager');
    await dialog.getByLabel(es?'Fecha final':'Through date',{exact:true}).fill('2026-08-01');
    await expect(dialog.getByRole('alert')).toBeVisible();
    await expect(dialog.getByRole('button',{name:es?'Descargar CSV':'Download CSV',exact:true})).toBeDisabled();
    await expect(dialog.getByText('10:00',{exact:true})).toHaveCount(0);
  });
}

test('installer export stays scoped to self and can choose dates even if the visible week is empty',async({page})=>{
  await fixtures(page,'en','installer'); await page.goto('/timecard');
  await page.getByRole('button',{name:'Previous',exact:true}).click();
  await page.getByRole('button',{name:'Export',exact:true}).click();
  await page.getByRole('button',{name:'Export time entries',exact:true}).click();
  const dialog=page.getByRole('dialog');
  await dialog.getByLabel('From date',{exact:true}).fill('2026-09-01');
  await dialog.getByLabel('Through date',{exact:true}).fill('2026-09-16');
  await expect(dialog).toContainText('07:30'); await expect(dialog.getByText('Historical Crew Member')).toHaveCount(0);
  await expect(dialog.getByRole('button',{name:/ZIP/})).toHaveCount(0);
  const dl=page.waitForEvent('download'); await dialog.getByRole('button',{name:'Download CSV',exact:true}).click();
  const csv=await readFile((await (await dl).path())!,'utf8'); expect(csv).not.toContain('Historical'); expect(csv).toContain('Fixture,Manager');
});

test('read errors disable export instead of producing incomplete payroll',async({page})=>{
  await fixtures(page); await page.goto('/team-timecards');
  await expect(page.locator('.job-time-report')).toContainText('15.5h');
  await page.route('**/rest/v1/time_shifts**',r=>r.fulfill({status:500,contentType:'application/json',body:JSON.stringify({message:'Records unavailable'})}));
  await page.getByRole('button',{name:'Export time entries',exact:true}).click();
  const dialog=page.getByRole('dialog'); await expect(dialog.getByRole('alert')).toBeVisible();
  await expect(dialog.getByRole('button',{name:'Download CSV',exact:true})).toBeDisabled();
});
