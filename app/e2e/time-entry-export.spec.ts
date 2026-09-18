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
  await page.route("**/rest/v1/rpc/set_project_status", async r => {
    const { p_project, p_status } = r.request().postDataJSON();
    const project = projects.find(p => p.id === p_project);
    if (project) project.status = p_status;
    return json(r, null);
  });
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
    await page.getByRole('button',{name:es?'Exportar fechas personalizadas':'Export custom dates',exact:true}).click();
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
  await page.getByRole('button',{name:'Export custom dates',exact:true}).click();
  const dialog=page.getByRole('dialog'); await expect(dialog.getByRole('alert')).toBeVisible();
  await expect(dialog.getByRole('button',{name:'Download CSV',exact:true})).toBeDisabled();
});

for (const [width, language] of [[375, 'en'], [390, 'es'], [1280, 'en']] as const) {
  test(`multiple job exports retain completed jobs and intersect custom dates at ${width}px ${language}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await page.emulateMedia({ colorScheme: width === 375 ? 'dark' : 'light' });
    const f = await fixtures(page, language);
    f.addShift(id(12), '2026-08-24T12:00:00Z', '2026-08-24T16:00:00Z');
    const es = language === 'es';
    await page.goto('/team-timecards');
    await page.getByRole('button', { name: es ? 'Exportar horas por trabajo' : 'Export job timecards', exact: true }).click();
    const dialog = page.getByRole('dialog');
    const csvButton = dialog.getByRole('button', { name: es ? 'Descargar CSV' : 'Download CSV', exact: true });
    const picker = dialog.locator('.job-filter-picker');
    await picker.locator('summary').click();
    await picker.getByRole('button', { name: es ? 'Quitar selección' : 'Clear selection', exact: true }).click();
    await expect(csvButton).toBeDisabled();
    await picker.getByRole('checkbox', { name: /JOB-B/ }).check();
    await picker.getByRole('checkbox', { name: /JOB-A/ }).check();
    await picker.locator('summary').click();
    await expect(dialog.locator('.detail-card > strong')).toHaveText('17:30');
    await expect(dialog.locator('.time-export-job-totals')).toContainText('Finished job');
    await expect(dialog.locator('.time-export-job-totals')).not.toContainText('JOB-C');
    const zipDownload = page.waitForEvent('download');
    await dialog.getByRole('button', { name: /ZIP/ }).click();
    const zip = await JSZip.loadAsync(await readFile((await (await zipDownload).path())!));
    expect(Object.keys(zip.files)).toHaveLength(2);
    const a = Object.values(zip.files).find(file => file.name.startsWith('JOB-A'))!;
    const b = Object.values(zip.files).find(file => file.name.startsWith('JOB-B'))!;
    const aCsv = await a.async('string'); const bCsv = await b.async('string');
    expect(aCsv).toContain('Fixture,Manager'); expect(aCsv).toContain('Historical,Crew Member'); expect(aCsv).not.toContain('Finished job');
    expect(bCsv).toContain('Finished job'); expect(bCsv).not.toContain('Fixture,Manager');
    const popup = page.waitForEvent('popup');
    await dialog.getByRole('button', { name: es ? 'Vista Forge / PDF' : 'Forge preview / PDF' }).click();
    const report = await popup;
    await expect(report.getByRole('heading', { name: 'Job timecards', exact: true })).toBeVisible();
    await expect(report.locator('.job-heading')).toHaveCount(2);
    await expect(report.getByText('Total recorded time: 17:30')).toBeVisible();
    if (width === 1280) {
      await report.setViewportSize({ width: 1440, height: 1000 });
      await report.screenshot({ path: '/tmp/forge-job-timecards-print.png', fullPage: true });
    }
    await report.close();
    await dialog.getByRole('button', { name: es ? 'Rango personalizado' : 'Custom range', exact: true }).click();
    await dialog.getByLabel(es ? 'Fecha inicial' : 'From date', { exact: true }).fill('2026-09-14');
    await dialog.getByLabel(es ? 'Fecha final' : 'Through date', { exact: true }).fill('2026-09-15');
    await expect(dialog.locator('.detail-card > strong')).toHaveText('11:30');
    const download = page.waitForEvent('download'); await csvButton.click();
    const csv = await readFile((await (await download).path())!, 'utf8');
    expect(csv).toContain('JOB-A'); expect(csv).not.toContain('JOB-B'); expect(csv).not.toContain('JOB-C');
    expect(csv).toContain('00:30,07:30');
    await dialog.screenshot({ path: `/tmp/forge-job-timecards-${width}-${language}.png` });
    expect(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    await dialog.getByLabel(es ? 'Fecha inicial' : 'From date', { exact: true }).fill('2026-09-16');
    await expect(csvButton).toBeDisabled();
    await dialog.getByRole('button', { name: es ? 'Historial completo' : 'Full job history', exact: true }).click();
    await expect(dialog.locator('.detail-card > strong')).toHaveText('17:30');
    await expect(csvButton).toBeEnabled();
  });
}

test('completing a job recommends billing and preserves its full-history export after reopening', async ({ page }) => {
  await fixtures(page);
  await page.goto(`/projects/${id(10)}`);
  await expect(page.locator('.job-billing-reminder')).toHaveCount(0);
  page.on('dialog', d => d.accept());
  await page.getByRole('button', { name: 'Finish this job…', exact: true }).click();
  const reminder = page.locator('.job-billing-reminder');
  await expect(reminder.getByRole('heading', { name: 'Job complete · Review billing', exact: true })).toBeVisible();
  await reminder.screenshot({ path: '/tmp/forge-job-billing-reminder.png' });
  await reminder.getByRole('button', { name: 'Export job timecards', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.locator('.detail-card > strong')).toHaveText('11:30');
  await expect(dialog.locator('.time-export-job-totals')).not.toContainText('JOB-B');
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await page.goto('/jobs/history');
  const historyJob = page.locator('.opening-review-row').filter({ has: page.getByRole('link', { name: 'JOB-A', exact: true }) });
  await expect(historyJob).toContainText('Review billing');
  await historyJob.getByRole('button', { name: 'Export job timecards', exact: true }).click();
  await expect(page.getByRole('dialog').locator('.detail-card > strong')).toHaveText('11:30');
  await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click();
  await page.goto(`/projects/${id(10)}`);
  await page.getByRole('button', { name: 'Reopen this job', exact: true }).click();
  await expect(page.locator('.job-billing-reminder')).toHaveCount(0);
  await page.locator('.job-timecard-export').getByRole('button', { name: 'Export job timecards', exact: true }).click();
  await expect(page.getByRole('dialog').locator('.detail-card > strong')).toHaveText('11:30');
});

test('installers cannot open exports for the whole job', async ({ page }) => {
  await fixtures(page, 'en', 'installer');
  await page.goto(`/projects/${id(11)}`);
  await expect(page.getByRole('heading', { name: /JOB-B/ })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Export job timecards', exact: true })).toHaveCount(0);
  await expect(page.locator('.job-billing-reminder')).toHaveCount(0);
});
