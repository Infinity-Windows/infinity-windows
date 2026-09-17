import { expect, test, type Page } from "@playwright/test";
import { useSupabaseFixtures as loadSupabaseFixtures, TEST_USER } from "./support/supabaseFixtures";
import { hideWrongProjectBanner, json } from "./support/specHelpers";
const id = (n: number) => `dddddddd-dddd-4ddd-8ddd-${String(n).padStart(12, "0")}`;
const project = { id: id(90), job_code: "NORTH", name: "North storefront" };
const note = "Installed four storefront frames.\nWaiting for the job to be added; moved the remaining glass into storage.";
async function setup(page: Page, role: "owner" | "foreman" = "owner", language: "en" | "es" = "en") {
  await loadSupabaseFixtures(page, { role, language }); await hideWrongProjectBanner(page);
  const people = [{ id: TEST_USER.id, display_name: "Reviewing Manager", role }, { id: id(1), display_name: "Installer Alex", role: "installer" },
    { id: id(2), display_name: "Supervisor Sam", role: "supervisor" }].map(p => ({ active: true, skill_level: 3, language, ...p }));
  const base = { profile_id: id(1), project_id: null, cost_code_id: id(80), clock_in_at: "2025-09-03T13:00:13Z", clock_out_at: "2025-09-03T17:00:42Z",
    break_seconds: 1800, break_started_at: null, injured: false, time_confirmed: true, status: "submitted", created_at: "2025-09-04T18:00:00Z",
    note, projects: null, profiles: { display_name: "Installer Alex" }, cost_codes: { code: "1", label: "Installation" } };
  let rows = [
    { ...base, id: id(12), created_at: "2025-09-06T18:00:00Z", clock_in_at: "2025-08-01T13:00:00Z", clock_out_at: "2025-08-01T17:00:00Z", note: "Later entry for earlier work" },
    { ...base, id: id(10), status: "approved", source_import: { source: "busybusy", file: "fixture.csv", row: 1, timeZone: "America/Denver", original: { Project: "Pending storefront project" } } },
    { ...base, id: id(11), profile_id: id(2), profiles: { display_name: "Supervisor Sam" }, created_at: "2025-09-05T18:00:00Z", note: "Supervisor details" },
    { ...base, id: id(13), status: "voided", note: "Removed punch" },
    { ...base, id: id(14), project_id: project.id, projects: null, note: "Assigned with unavailable job details" },
  ];
  const original = structuredClone(rows);
  const edits: Record<string, unknown>[] = [], settingsWrites: Record<string, unknown>[] = [], backlogQueries: URL[] = [];
  let settings = { id: 1, evening_nudge_local_time: "17:30:00", evening_nudge_enabled: true };
  await page.route("**/rest/v1/profiles**", r => { const pid = new URL(r.request().url()).searchParams.get("id")?.slice(3); return json(r, pid ? people.find(p => p.id === pid) : people, people.length); });
  await page.route("**/rest/v1/projects**", r => json(r, [project], 1));
  await page.route("**/rest/v1/cost_codes**", r => json(r, [{ id: id(80), code: "1", label: "Installation", active: true }], 1));
  await page.route("**/rest/v1/company_settings**", r => json(r, settings));
  await page.route("**/rest/v1/rpc/set_evening_nudge_time", r => { const body = r.request().postDataJSON(); settingsWrites.push(body); settings = { ...settings, evening_nudge_enabled: body.p_enabled, evening_nudge_local_time: body.p_local_time }; return json(r, settings); });
  await page.route("**/rest/v1/time_shifts**", r => {
    const u = new URL(r.request().url()); let filtered = rows;
    if (u.searchParams.get("project_id") === "is.null") backlogQueries.push(u);
    for (const key of ["profile_id", "project_id", "status", "clock_out_at"] as const) for (const q of u.searchParams.getAll(key)) {
      if (q === "is.null") filtered = filtered.filter(s => s[key] === null);
      if (q.startsWith("eq.")) filtered = filtered.filter(s => s[key] === q.slice(3));
      if (q.startsWith("neq.")) filtered = filtered.filter(s => s[key] !== q.slice(4));
      if (q.startsWith("in.")) filtered = filtered.filter(s => q.slice(4, -1).split(",").includes(String(s[key])));
    }
    for (const q of u.searchParams.getAll("clock_in_at")) {
      if (q.startsWith("gte.")) filtered = filtered.filter(s => s.clock_in_at >= q.slice(4));
      if (q.startsWith("lt.")) filtered = filtered.filter(s => s.clock_in_at < q.slice(3));
    }
    return json(r, r.request().headers().accept?.includes("pgrst.object") ? filtered[0] ?? null : filtered, filtered.length);
  });
  await page.route("**/rest/v1/rpc/edit_shift_with_description", r => {
    const body = r.request().postDataJSON(); edits.push(body);
    rows = rows.map(s => s.id === body.p_shift_id ? { ...s, project_id: body.p_project_id, note: body.p_description } : s);
    return json(r, rows.find(s => s.id === body.p_shift_id));
  });
  await page.route("**/functions/v1/send-push", r => json(r, { ok: true }));
  return { original, edits, settingsWrites, backlogQueries };
}
for (const [width, lang] of [[390, "es"], [1280, "en"]] as const) test(`all-date backlog and themed reminder at ${width}px ${lang}`, async ({ page }) => {
  await page.setViewportSize({ width, height: 900 }); await page.emulateMedia({ colorScheme: "dark" });
  const f = await setup(page, "owner", lang); await page.goto("/team-timecards");
  const section = page.locator(".unassigned-time");
  await expect(section.locator(".unassigned-entry")).toHaveCount(3);
  expect(await section.locator(".unassigned-entry").evaluateAll(es => es.map(e => e.getAttribute("data-entry-id")))).toEqual([id(10), id(11), id(12)]);
  await expect(section.getByText("03:30:29", { exact: false }).first()).toBeVisible();
  await expect(section.getByText("Pending storefront project", { exact: false })).toBeVisible();
  await expect(section.locator(".unassigned-description").first()).toHaveText(note);
  const rangeTabs = page.locator(".tcx-tabs").getByRole("tab");
  await rangeTabs.nth(1).click(); await expect(section.locator(".unassigned-entry")).toHaveCount(3);
  await rangeTabs.nth(2).click(); await expect(section.locator(".unassigned-entry")).toHaveCount(3);
  expect(f.backlogQueries.every(u => !u.searchParams.has("clock_in_at"))).toBe(true);
  const reminder = page.locator(".tcx-reminder");
  const toggle = reminder.getByRole("checkbox"); await expect(toggle).toBeChecked();
  await reminder.scrollIntoViewIfNeeded(); await page.screenshot({ path: `e2e/test-results/unassigned-${width}.png` });
  await toggle.focus(); await page.keyboard.press("Space"); await expect(toggle).not.toBeChecked();
  await reminder.getByRole("button", { name: lang === "es" ? "Guardar" : "Save", exact: true }).click();
  await expect.poll(() => f.settingsWrites.length).toBe(1); expect(f.settingsWrites[0]).toEqual({ p_local_time: "17:30", p_enabled: false });
  await expect(reminder.locator(".tcx-reminder-check")).toHaveCSS("width", "20px");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const first = section.locator(`[data-entry-id="${id(10)}"]`);
  await first.scrollIntoViewIfNeeded(); await page.screenshot({ path: `e2e/test-results/unassigned-entry-${width}.png` });
  await first.getByRole("button", { name: lang === "es" ? "Asignar trabajo / editar" : "Assign job / edit" }).click();
  await first.locator(".shift-editor select").first().selectOption(project.id);
  await first.getByPlaceholder("e.g. forgot to clock out").fill("Assigning the reported job");
  await first.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(section.locator(".unassigned-entry")).toHaveCount(2);
  expect(f.edits[0]).toMatchObject({ p_project_id: project.id, p_clock_in_at: f.original[1].clock_in_at, p_clock_out_at: f.original[1].clock_out_at, p_break_seconds: 1800, p_description: note });
});

test("foreman can assign installer time but cannot edit a supervisor entry", async ({ page }) => {
  await setup(page, "foreman"); await page.goto("/team-timecards");
  const section = page.locator(".unassigned-time");
  await expect(section.locator(`[data-entry-id="${id(10)}"]`).getByRole("button", { name: "Assign job / edit" })).toBeVisible();
  await expect(section.locator(`[data-entry-id="${id(11)}"]`).getByRole("button", { name: "Assign job / edit" })).toHaveCount(0);
});

test("a failed backlog read reports an error instead of saying every job is assigned", async ({ page }) => {
  await setup(page);
  await page.route("**/rest/v1/time_shifts**", async r => {
    if (new URL(r.request().url()).searchParams.get("project_id") === "is.null") return r.fulfill({ status: 403, contentType: "application/json", body: JSON.stringify({ message: "Not permitted" }) });
    return r.fallback();
  });
  await page.goto("/team-timecards");
  await expect(page.locator(".unassigned-time").getByRole("alert")).toBeVisible();
  await expect(page.getByText("Every time entry has a job assigned.")).toHaveCount(0);
});
