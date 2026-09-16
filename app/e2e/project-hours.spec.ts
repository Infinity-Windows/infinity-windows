import { expect, test, type Page } from "@playwright/test";
import { useSupabaseFixtures as loadSupabaseFixtures, TEST_USER } from "./support/supabaseFixtures";
import { hideWrongProjectBanner, json } from "./support/specHelpers";

test.use({ timezoneId: "America/Denver" });
test.setTimeout(60_000);
const id = (n: number) => `bbbbbbbb-bbbb-4bbb-8bbb-${String(n).padStart(12, "0")}`;
async function fixtures(page: Page, language: "en" | "es" = "en") {
  await page.clock.install({ time: new Date("2026-09-16T16:00:00Z") });
  await loadSupabaseFixtures(page, { role: "owner", language });
  await hideWrongProjectBanner(page);
  const people = [{ id: TEST_USER.id, display_name: "Fixture Manager", role: "owner", active: true },
    { id: id(1), display_name: "Historical Crew Member", role: "installer", active: false }].map(p => ({ ...p, language }));
  const projects = [{ id: id(10), job_code: "JOB-A", name: "A long project name for a mobile hours report", status: "active" },
    { id: id(11), job_code: "JOB-B", name: "Finished job", status: "completed" },
    { id: id(12), job_code: "JOB-C", name: "No hours yet", status: "active" }].map(p => ({ ...p, is_test: false, allowed_modes: ["tracking"], job_kind: "residential" }));
  let rows = [
    { id: id(100), profile_id: TEST_USER.id, project_id: id(10), clock_in_at: "2026-09-14T12:00:00Z", clock_out_at: "2026-09-14T20:00:00Z", status: "approved" },
    { id: id(101), profile_id: id(1), project_id: id(10), clock_in_at: "2026-09-15T12:00:00Z", clock_out_at: "2026-09-15T16:00:00Z", status: "submitted" },
    { id: id(102), profile_id: id(1), project_id: id(11), clock_in_at: "2026-09-01T12:00:00Z", clock_out_at: "2026-09-01T18:00:00Z", status: "approved" },
    { id: id(103), profile_id: TEST_USER.id, project_id: id(10), clock_in_at: "2026-09-16T12:00:00Z", clock_out_at: null, status: "open" },
  ].map(s => ({ ...s, break_seconds: 0, break_started_at: null, cost_code_id: id(20),
    profiles: { display_name: people.find(p => p.id === s.profile_id)!.display_name },
    projects: projects.find(p => p.id === s.project_id), cost_codes: { code: "1", label: "Installation" }, created_at: s.clock_in_at }));
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
  return { closeRunning: () => { rows = rows.map(s => s.status === "open" ? { ...s, status: "submitted", clock_out_at: "2026-09-16T16:00:00Z" } : s); } };
}

for (const [width, language] of [[375, "en"], [390, "es"], [1280, "en"]] as const) {
  test(`crew and job totals share dates, all history and running time at ${width}px ${language}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    const f = await fixtures(page, language);
    await page.goto("/team-timecards");
    const report = page.locator(".job-time-report");
    await expect(report).toContainText("16.0h");
    await expect(report).toContainText("12.0h");
    await expect(report).toContainText("4.0h");
    await page.getByRole("tab", { name: language === "es" ? "Periodo de pago" : "Pay period", exact: true }).click();
    await page.getByRole("button", { name: language === "es" ? "Anterior" : "Previous", exact: true }).click();
    await expect(report).toContainText("6.0h");
    await expect(report).not.toContainText("JOB-A");
    await page.getByRole("tab", { name: language === "es" ? "Todo el tiempo" : "All time", exact: true }).click();
    await expect(report).toContainText("22.0h");
    await expect(report).toContainText("18.0h");
    await expect(page.locator(".tcx-row").filter({ hasText: "Historical Crew Member" })).toContainText("10.0h");
    await expect(page.getByRole("button", { name: language === "es" ? "Aprobar semana" : "Approve week", exact: true })).toHaveCount(0);
    f.closeRunning();
    await report.getByRole("button", { name: language === "es" ? "Actualizar horas" : "Refresh hours" }).click();
    await expect(report).toContainText(language === "es" ? "22.0h terminadas + 0.0h en curso" : "22.0h finished + 0.0h running");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await report.screenshot({ path: `/tmp/forge-job-hours-${width}-${language}.png` });
  });
}

test("Data lists every job, including completed and zero-hour jobs, with history preserved", async ({ page }) => {
  await fixtures(page);
  await page.goto("/data");
  const report = page.locator(".job-time-report");
  await expect(report).toContainText("22.0h");
  await expect(report).toContainText("JOB-C");
  await expect(report.locator(".job-time-row").filter({ hasText: "JOB-B" })).toContainText("Finished");
  await expect(page.getByRole("link", { name: "Job history", exact: true }).last()).toHaveAttribute("href", "/jobs/history");
  await page.getByLabel("Job filter").selectOption(id(11));
  await expect(report).toContainText("6.0h");
  await expect(report).not.toContainText("JOB-A");
});

test("failed reads show an error instead of a misleading zero total", async ({ page }) => {
  await fixtures(page);
  await page.route("**/rest/v1/time_shifts**", r => r.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ message: "Time records unavailable" }) }));
  await page.goto("/team-timecards");
  const report = page.locator(".job-time-report");
  await expect(report.getByRole("alert")).toBeVisible();
  await expect(report.getByText("Total", { exact: true })).toHaveCount(0);
});
