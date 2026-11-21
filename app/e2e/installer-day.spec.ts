import { expect, test, type Page } from "@playwright/test";

async function pickWorkdayActivity(page: import("@playwright/test").Page, choice: string) {
  const planned = page.locator(`.wd-plan [data-choice="${choice}"]`);
  if (await planned.isVisible()) {
    await planned.click();
    return;
  }
  await page.locator(".wd-activity-picker").click();
  await page.locator(`.wd-activity-grid [data-choice="${choice}"]`).click();
}

import { TEST_USER, useSupabaseFixtures as replaySupabase } from "./support/supabaseFixtures";

// Turning machinery on asks "Are you operating machinery?" the first time in a day.
async function confirmMachinery(page: import("@playwright/test").Page) {
  const yes = page.getByRole("button", { name: "Yes, I am", exact: true });
  if (await yes.isVisible().catch(() => false)) await yes.click();
}

const job = { id: "11111111-1111-4111-8111-111111111111", job_code: "zztest", name: "TEST sandbox", is_test: true };
const opening = { id: "22222222-2222-4222-8222-222222222222", project_id: job.id, opening_code: "12", window_type_id: null, window_types: null, assigned_window_id: null, status: "planned", confirmed: true, created_at: "2026-11-03T15:00:00Z", page_number: 1, pin_x: 0.5, pin_y: 0.5 };
async function setup(page: Page, isTest = true, sandbox = true, projectAvailable = true, role: "owner" | "foreman" | "installer" = "owner") {
  let language = "en";
  await replaySupabase(page, { role, profileOverrides: () => ({ is_test: isTest, language }) });
  const units: Record<string, any>[] = [], records: Record<string, any>[] = [], sessions: Record<string, any>[] = [], commands: Record<string, any>[] = [];
  let plan: { revision: number; blocks: unknown[] } = { revision: 0, blocks: [] };
  const date = new Date().toISOString();
  const shift = { id: "33333333-3333-4333-8333-333333333333", profile_id: TEST_USER.id, project_id: job.id, cost_code_id: null, clock_in_at: date, clock_out_at: null, status: "open", break_seconds: 0, break_started_at: null, projects: job };
  await page.route("**/rest/v1/**", async route => {
    const url = new URL(route.request().url()), table = url.pathname.split("/rest/v1/")[1];
    const single = route.request().headers().accept?.includes("object+json");
    const reply = (data: unknown, count = Array.isArray(data) ? data.length : data ? 1 : 0) => route.fulfill({ status: 200, contentType: "application/json", headers: { "content-range": `0-${Math.max(0, count - 1)}/${count}`, "access-control-expose-headers": "content-range" }, body: JSON.stringify(data) });
    if (table === "profiles" && url.searchParams.get("select") === "id,is_test") return reply({ id: TEST_USER.id, is_test: isTest });
    if (table === "profiles" && url.searchParams.has("is_test")) return reply([{ id: TEST_USER.id, display_name: "TEST foreman", role: "foreman", active: true, is_partner: false }]);
    if (table === "projects") return reply(projectAvailable ? single ? job : [job] : single ? null : []);
    if (table === "rpc/set_my_language") { language = route.request().postDataJSON().p_lang; return reply(null); }
    if (table === "rpc/is_sandbox_project") return reply(sandbox);
    // The Plan tab shows an error, not an empty plan, when this read answers nothing.
    if (table === "rpc/get_installer_plan") return reply(plan);
    if (table === "rpc/save_installer_plan") {
      const body = route.request().postDataJSON();
      plan = { revision: plan.revision + 1, blocks: body.p_blocks };
      return reply(plan);
    }
    if (table === "time_shifts") return reply(single ? shift : [shift]);
    if (table === "project_openings") return reply([opening, { ...opening, id: "22222222-2222-4222-8222-222222222223", opening_code: "13" }]);
    if (table === "project_mark_specs" || table === "studio_units" || table === "unit_sessions" || table === "opening_phases" || table === "custom_work_types") return reply(single ? null : []);
    if (table === "custom_work_units") return reply(units);
    if (table === "custom_work_sessions") return reply(sessions);
    if (table === "rpc/get_workday_unit_schedule") return reply([
      { kind: "unit", activity: "Flashing", start: "2026-11-16", end: "2026-11-16",
        openingIds: [opening.id, "22222222-2222-4222-8222-222222222223"] },
    ]);
    if (table === "crew_work_records") return reply(records);
    if (table === "rpc/record_crew_work") {
      const body = route.request().postDataJSON(); commands.push({ action: "assigned", ...body.p_data });
      const u = { ...body.p_data.unit, revision: 1, created_by: TEST_USER.id, created_at: date, updated_at: date };
      if (!units.some(unit => unit.id === u.id)) units.push(u);
      records.push({ id: body.p_id, ...body.p_data, project_id: job.id, unit_id: u.id, people: body.p_data.people.map((profile_id: string) => ({ profile_id })), filed_by: TEST_USER.id, created_at: date });
      return reply(u.id);
    }
    if (table === "rpc/save_workday_activity") {
      const data = route.request().postDataJSON().p_data;
      commands.push({ action: "workday_activity", ...data });
      const session = sessions.find(s => s.id === data.id);
      if (!session) return route.fulfill({ status: 400, json: { message: "Session not found" } });
      if (data.done) session.workday_done_at = data.at;
      if (typeof data.machinery_running === "boolean") {
        session.workday_machinery_ms = data.machinery_ms;
        session.workday_machinery_started_at = data.machinery_running ? data.at : null;
      }
      return reply(session.id);
    }
    if (table === "rpc/custom_work_command") {
      const body = route.request().postDataJSON(), data = body.p_data; commands.push({ action: body.p_action, ...data });
      if (body.p_action === "unit") {
        const index = units.findIndex(unit => unit.id === data.id);
        const unit = { ...units[index], ...data, created_by: TEST_USER.id, revision: data.revision + 1 };
        if (index < 0) units.push(unit);
        else units[index] = unit;
        return reply(data.id);
      }
      const active = sessions.find(s => !s.ended_at);
      if (active) {
        expect(data.expected_session_id).toBe(active.id);
        active.ended_at = data.at;
        active.outcome = active.workday_done_at ? "finished" : data.outcome;
        if (active.workday_machinery_started_at) {
          active.workday_machinery_ms = (active.workday_machinery_ms ?? 0)
            + Math.max(0, Date.parse(data.at) - Date.parse(active.workday_machinery_started_at));
          active.workday_machinery_started_at = null;
        }
      }
      if (body.p_action === "start") {
        const unit = units.find(unit => unit.id === data.unit_id);
        if (unit?.facts.installation_complete === "Yes" && !data.preserve_unit_completion) {
          unit.facts = { ...unit.facts, installation_complete: "No" };
          unit.revision++;
        }
        sessions.push({ ...data, profile_id: TEST_USER.id, kind: data.unit_id ? "unit" : "idle", started_at: data.at, ended_at: null, end_reason: null, outcome: null, revision: 1 });
      }
      return reply(data.id ?? data.expected_session_id);
    }
    return route.fallback();
  });
  return { commands, sessions, units };
}



test("opens an explicitly selected practice project without requiring the old ZZTEST code", async ({ page }) => {
  const { commands } = await setup(page, false, true);
  await page.goto(`/installer-day?project=${job.id}`);
  await expect(page.locator("html")).toHaveAttribute("data-design", "new");
  await expect(page.locator(".steel-header")).toBeVisible();
  await expect(page.getByRole("button", { name: "Start unit 12 RO checked", exact: true })).toBeVisible();
  await expect(page.locator(".installer-task-board")).toHaveCSS("background-color", "rgb(25, 31, 36)");
  await expect(page.getByRole("button", { name: "Open job clock", exact: true })).toHaveCount(0);
  expect(commands).toEqual([]);
});

test("missing project explains the lookup failure and offers retry", async ({ page }) => {
  const { commands } = await setup(page, false, false, false);
  await page.goto("/installer-day");
  await expect(page.getByText("No accessible zztest project was found. Check that the project is available to your account, then retry.", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Retry project lookup", exact: true })).toBeEnabled();
  expect(commands).toEqual([]);
});

for (const [name, isTest, isSandbox] of [["unregistered job", true, false]] as const) {
  test(`refuses ${name} before any work controls mount`, async ({ page }) => {
    const { commands } = await setup(page, isTest, isSandbox);
    await page.goto("/installer-day");
    await expect(page.getByText(isTest ? "This project is not registered as a sandbox. Nothing can be changed here." : "This walkthrough requires a TEST login so its time stays out of real payroll and learning reports.", { exact: true })).toBeVisible();
    await expect(page.getByRole("complementary", { name: "General activities" })).toHaveCount(0);
    expect(commands).toEqual([]);
  });
}

test("activity-first live timers hand off between units and keep the activity", async ({ page }) => {
 const { commands, sessions } = await setup(page);
 await page.goto(`/installer-day?project=${job.id}`);
 await pickWorkdayActivity(page, "unit:Flashing");
 await page.getByRole("button", { name: "+ Add unit", exact: true }).click();
 await page.getByRole("button", { name: "Add unit 12", exact: true }).click();
 await page.getByRole("button", { name: "Add unit 13", exact: true }).click();
 await page.getByRole("button", { name: "Add 2 units", exact: true }).click();
 await page.getByRole("button", { name: "Start unit 12 Flashing", exact: true }).click();
 await expect(page.getByRole("button", { name: "Running unit 12 Flashing", exact: true })).toBeEnabled();
 const machinery = page.getByRole("switch", { name: "Operating machinery", checked: false });
 await machinery.click();
 await confirmMachinery(page);
 const stopMachinery = page.getByRole("switch", { name: "Operating machinery", checked: true });
 // The switch shows only that the machine is on; its time is tracked, not shown.
 await expect(stopMachinery).toBeVisible();
 await page.waitForTimeout(1100); // let the machine clock run for a counted second
 await stopMachinery.click();
 await expect(machinery).toBeVisible();
 await page.getByRole("button", { name: "Mark activity done for unit 12", exact: true }).click();
 await expect(page.getByRole("button", { name: "Running unit 12 Flashing", exact: true })).toContainText("Complete");
 expect(sessions[0].ended_at).toBeNull();

 await page.getByRole("button", { name: "Start unit 13 Flashing", exact: true }).click();
 await expect(page.getByRole("button", { name: "Running unit 13 Flashing", exact: true })).toBeEnabled();
 await expect(page.locator(".wd-activity-picker")).toHaveAttribute("data-activity", "unit:Flashing");
 await expect.poll(() => commands.filter(c => c.action === "start").length).toBe(2);
 expect(sessions.filter(s => !s.ended_at)).toHaveLength(1);
 const starts = commands.filter(c => c.action === "start");
 expect(starts).toHaveLength(2);
 expect(starts[1].expected_session_id).toBe(starts[0].id);
 expect(sessions[0].workday_machinery_ms).toBeGreaterThanOrEqual(1000);
 expect(sessions[0].ended_at).toBe(sessions[1].started_at);
 expect(sessions[0].outcome).toBe("finished");

 const complete = page.getByRole("button", { name: "Mark unit complete", exact: true });
 await page.getByRole("button", { name: "Details for unit 12", exact: true }).click();
 await complete.click();
 await page.getByRole("button", { name: "Confirm completion", exact: true }).click();
 await expect(page.getByText("Unit complete", { exact: true })).toBeVisible();
 expect(sessions[1].ended_at).toBeNull();
 await page.getByRole("button", { name: "Close details", exact: true }).click();

 await page.getByRole("button", { name: "Details for unit 13", exact: true }).click();
 await complete.click();
 await page.getByRole("button", { name: "Confirm completion", exact: true }).click();
 await expect(page.getByText("Unit complete", { exact: true })).toBeVisible();
 await expect.poll(() => sessions[1].ended_at).not.toBeNull();
 expect(sessions[1].outcome).toBe("finished");
 await expect.poll(() => commands.filter(c => c.action === "unit" && c.facts?.installation_complete === "Yes").length)
   .toBe(2);
 await pickWorkdayActivity(page, "unit:Sealing");
 await page.getByRole("button", { name: "+ Add unit", exact: true }).click();
 await page.getByRole("button", { name: "Add unit 13", exact: true }).click();
 await page.getByRole("button", { name: "Add 1 unit", exact: true }).click();
 const sealing = page.getByRole("button", { name: "Start unit 13 Sealing", exact: true });
 await expect(sealing.getByTitle("Unit complete")).toBeVisible();
 await sealing.click();
 await expect(page.getByRole("button", { name: "Running unit 13 Sealing", exact: true }).getByTitle("Unit complete")).toBeVisible();
 await expect.poll(() => commands.filter(c => c.action === "start").at(-1)?.preserve_unit_completion).toBe(true);
 await pickWorkdayActivity(page, "unit:Flashing");
 await expect(page.getByRole("button", { name: "Start unit 13 Flashing", exact: true })).toContainText("Complete");
 await expect(page.getByRole("button", { name: "Start unit 13 Flashing", exact: true }).getByTitle("Unit complete")).toBeVisible();
 await page.screenshot({ path: ".test-temp/workday-activity-first.png", fullPage: true });
});

test("a refused activity update still lets the installer stop and complete the unit", async ({ page }) => {
 const { commands, sessions } = await setup(page);
 const attempts: unknown[] = [];
 await page.route("**/rest/v1/rpc/save_workday_activity", route => {
   attempts.push(route.request().postDataJSON());
   return route.fulfill({ status: 404, json: { code: "PGRST202", message: "Could not find the function public.save_workday_activity" } });
 });
 await page.goto(`/installer-day?project=${job.id}`);
 await pickWorkdayActivity(page, "unit:Flashing");
 await page.getByRole("button", { name: "+ Add unit", exact: true }).click();
 await page.getByRole("button", { name: "Add unit 12", exact: true }).click();
 await page.getByRole("button", { name: "Add 1 unit", exact: true }).click();
 await page.getByRole("button", { name: "Start unit 12 Flashing", exact: true }).click();
 await page.getByRole("button", { name: "Mark activity done for unit 12", exact: true }).click();
 await expect(page.getByRole("link", { name: "Review update", exact: true })).toHaveCount(0);
 await expect(page.getByRole("button", { name: "Running unit 12 Flashing", exact: true })).toBeEnabled();
 await page.getByRole("button", { name: "Details for unit 12", exact: true }).click();
 await page.getByRole("button", { name: "Mark unit complete", exact: true }).click();
 await page.getByRole("button", { name: "Confirm completion", exact: true }).click();
 await expect(page.getByText("Unit complete", { exact: true })).toBeVisible();
 await expect.poll(() => sessions[0].outcome, { timeout: 12000 }).toBe("finished");
 await expect.poll(() => commands.some(command => command.facts?.installation_complete === "Yes")).toBe(true);
 // Workday no longer repeats the review notice; the pill at the top of the page carries it.
 await expect(page.getByRole("link", { name: "Review update", exact: true })).toHaveCount(0);
 expect(attempts).toHaveLength(4);
 expect(attempts.every(attempt => JSON.stringify(attempt) === JSON.stringify(attempts[0]))).toBe(true);
});

for (const role of ["installer", "foreman"] as const) {
  test(`unit completion uses the whole opening schedule for a ${role}`, async ({ page }) => {
    await setup(page, true, true, true, role);
    await page.route("**/rest/v1/rpc/get_workday_unit_schedule", route => route.fulfill({ json: [
      { kind: "unit", activity: "Flashing", start: "2026-11-16", end: "2026-11-16", openingIds: [opening.id] },
      { kind: "unit", activity: "Sealing", start: "2026-11-17", end: "2026-11-17", openingIds: [opening.id] },
      { kind: "unit", activity: "Setting frame", start: "2026-11-18", end: "2026-11-18", openingIds: ["22222222-2222-4222-8222-222222222223"] },
    ] }));
    await page.goto(`/installer-day?project=${job.id}`);
    const details = page.getByRole("button", { name: "Details for unit 12", exact: true });
    const addUnit = async () => {
      await page.getByRole("button", { name: "+ Add unit", exact: true }).click();
      await page.getByRole("button", { name: "Add unit 12", exact: true }).click();
      await page.getByRole("button", { name: "Add 1 unit", exact: true }).click();
      await details.click();
    };
    await pickWorkdayActivity(page, "unit:Flashing");
    await addUnit();
    await expect(page.getByRole("button", { name: "Mark unit complete", exact: true })).toHaveCount(0);
    const override = page.getByRole("button", { name: "Override unit completion", exact: true });
    if (role === "foreman") {
      await override.click();
      await expect(page.getByText("Still planned: Sealing", { exact: true })).toBeVisible();
      await page.getByRole("button", { name: "Cancel", exact: true }).click();
    } else {
      await expect(override).toHaveCount(0);
    }
    await pickWorkdayActivity(page, "unit:Sealing");
    await addUnit();
    await expect(page.getByRole("button", { name: "Mark unit complete", exact: true })).toBeVisible();
  });
}

test("activity-first preview simulates unit and company work without writes", async ({ page }) => {
 const { commands } = await setup(page, false);
 await page.goto(`/installer-day?project=${job.id}`);
 await pickWorkdayActivity(page, "unit:Flashing");
 await page.getByRole("button", { name: "Start unit 12 Flashing", exact: true }).click();
 await expect(page.getByRole("button", { name: "Running unit 12 Flashing", exact: true })).toBeVisible();
 await page.getByRole("link", { name: "Jobs", exact: true }).first().click();
 await expect(page).toHaveURL(/\/projects$/);
 await page.goBack();
 await expect(page.locator(".wd-activity-picker")).toHaveAttribute("data-activity", "unit:Flashing");
 const firstUnit = page.getByRole("button", { name: "Running unit 12 Flashing", exact: true });
 await expect(firstUnit).not.toContainText("0:00:00");
 const clock = page.getByRole("region", { name: "Preview clock" });
 await clock.getByRole("button", { name: "Break", exact: true }).click();
 await expect(page.getByRole("button", { name: "Start unit 12 Flashing", exact: true })).toBeDisabled();
 await clock.getByRole("button", { name: "Resume", exact: true }).click();
 await page.getByRole("button", { name: "Start unit 13 Flashing", exact: true }).click();
 const secondUnit = page.getByRole("button", { name: "Running unit 13 Flashing", exact: true });
 await expect(secondUnit).not.toContainText("0:00:00");
 await secondUnit.click();
 const timer = page.getByRole("region", { name: "Current activity" }).locator(".wd-timer strong");
 const fromClock = (label: string) => label.split(":").reduce((sum, part) => sum * 60 + Number(part), 0);
 const unitClocks = await page.locator(".wd-unit-clock").allTextContents();
 const total = unitClocks.reduce((sum, label) => sum + fromClock(label.match(/\d+:\d{2}:\d{2}/)![0]), 0);
 expect(total).toBeGreaterThanOrEqual(2);
 const activityTotal = fromClock(await timer.innerText());
 expect(activityTotal).toBeGreaterThanOrEqual(total);
 expect(activityTotal).toBeLessThanOrEqual(total + 1);
 await pickWorkdayActivity(page, "unit:Setting frame");
 await expect(timer).toHaveText("0:00:00");
 await pickWorkdayActivity(page, "unit:Flashing");
 expect(fromClock(await timer.innerText())).toBeGreaterThanOrEqual(activityTotal);

 await pickWorkdayActivity(page, "company:Company delivery");
 await expect(page.getByRole("region", { name: "Current activity" }).getByText("Running", { exact: true })).toBeVisible();
 await expect(page.locator(".wd-unit")).toHaveCount(0);
 await clock.getByRole("button", { name: "Clock out", exact: true }).click();
 await expect(clock).toHaveCount(0);
 await expect(page.getByRole("button", { name: "Start Company delivery", exact: true })).toBeVisible();
 expect(commands).toHaveLength(0);
});

test("switching preview jobs keeps paid time running and closes unit and machinery timers", async ({ page }) => {
 const { commands } = await setup(page, false);
 const other = { ...job, id: "11111111-1111-4111-8111-111111111112", job_code: "OTHER", name: "Second test job" };
 await page.route("**/rest/v1/profiles?*", route =>
   new URL(route.request().url()).searchParams.get("select") === "is_test"
     ? route.fulfill({ json: { is_test: false } }) : route.fallback());
 await page.route("**/rest/v1/projects?*", route => {
   const id = new URL(route.request().url()).searchParams.get("id");
   return route.fulfill({ json: id ? [id === "eq." + other.id ? other : job] : [job, other] });
 });
 await page.goto(`/installer-day?project=${job.id}&planAs=${TEST_USER.id}`);
 await pickWorkdayActivity(page, "unit:Flashing");
 await page.getByRole("button", { name: "+ Add unit", exact: true }).click();
 await page.getByRole("button", { name: "Add unit 12", exact: true }).click();
 await page.getByRole("button", { name: "Add 1 unit", exact: true }).click();
 await page.getByRole("button", { name: "Start unit 12 Flashing", exact: true }).click();
 await page.getByRole("switch", { name: "Operating machinery", checked: false }).click();
 await confirmMachinery(page);
 await expect(page.getByRole("switch", { name: "Operating machinery", checked: true })).toBeVisible();
 await page.getByRole("button", { name: /^Switch job/ }).click();
 await page.getByRole("link", { name: /OTHER.*Second test job/ }).click();
 await expect(page).toHaveURL(new RegExp(other.id));
 await expect(page.getByRole("region", { name: "Preview clock" }).getByRole("button", { name: "Break" })).toBeEnabled();
 await expect(page.getByRole("region", { name: "Preview clock" }).getByRole("status")).toHaveText("Clocked in · preview");
 await expect(page.getByRole("switch", { name: "Operating machinery", checked: true })).toHaveCount(0);
 await expect(page.getByText(/Still running/)).toHaveCount(0);
 expect(commands).toHaveLength(0);
});

test("Workday keeps the running unit until the next tap and switches to the training job offline", async ({ page, context }) => {
 const { commands, sessions } = await setup(page, true, true, true, "installer");
 const training = { ...job, id: "c8bf4d94-5086-40ed-9d8c-b3c88add2229", job_code: "FORGE-TRAIN-1103", name: "Building 3 test job" };
 let shift = { id: "33333333-3333-4333-8333-333333333333", profile_id: TEST_USER.id, project_id: job.id,
   clock_in_at: new Date(Date.now() - 60_000).toISOString(), clock_out_at: null, status: "open", break_started_at: null, break_seconds: 0 };
 const switches: { p_project_id: string; p_tapped_at: string }[] = [];
 await page.route("**/rest/v1/time_shifts?*", route => route.fulfill({
   json: route.request().headers().accept?.includes("object+json") ? shift : [shift],
 }));
 await page.route("**/rest/v1/profiles?*", route => {
   if (new URL(route.request().url()).searchParams.get("select") === "is_test")
     return route.fulfill({ json: { is_test: true } });
   return route.fallback();
 });
 await page.route("**/rest/v1/projects?*", route => {
   const id = new URL(route.request().url()).searchParams.get("id");
   return route.fulfill({ json: id ? id === "eq." + training.id ? [training] : [job] : [training, job] });
 });
 await page.route("**/rest/v1/cost_codes?*", route => route.fulfill({
   json: [{ id: opening.id, code: "000", label: "General", is_general: true, active: true }],
 }));
 await page.route("**/rest/v1/rpc/get_published_installer_plan", route => route.fulfill({ json: [] }));
 await page.route("**/rest/v1/rpc/clock_in", route => {
   const data = route.request().postDataJSON();
   switches.push(data);
   expect(sessions.at(-1)?.ended_at).toBe(data.p_tapped_at);
   shift = { ...shift, id: "33333333-3333-4333-8333-333333333334", project_id: data.p_project_id, clock_in_at: data.p_tapped_at };
   return route.fulfill({ json: shift });
 });
 await page.goto("/installer-day?project=" + job.id + "&work=1");
 const add = async (number: string) => {
   await page.getByRole("button", { name: "+ Add unit", exact: true }).click();
   await page.getByRole("button", { name: "Add unit " + number, exact: true }).click();
   await page.getByRole("button", { name: "Add 1 unit", exact: true }).click();
 };
 await pickWorkdayActivity(page, "unit:Flashing");
 await add("12");
 await page.getByRole("button", { name: "Start unit 12 Flashing" }).click();
 const machinery = page.getByRole("switch", { name: "Operating machinery" });
 await machinery.click();
 await confirmMachinery(page);
 await expect(machinery).toHaveAttribute("aria-checked", "true");
 await pickWorkdayActivity(page, "unit:Sealing");
 await expect(page.getByText(/Still running: Flashing.*12/)).toBeVisible();
 expect(sessions[0].ended_at).toBeNull();
 await add("13");
 await page.getByRole("button", { name: "Start unit 13 Sealing" }).click();
 await expect.poll(() => sessions[1]?.workday_machinery_started_at).toBeTruthy();
 expect(sessions[0].ended_at).toBe(sessions[1].started_at);
 expect(sessions[0].workday_machinery_started_at).toBeNull();
 expect(sessions[1].workday_machinery_started_at).toBe(sessions[1].started_at);
 await page.getByRole("button", { name: "Running unit 13 Sealing" }).click();
 await expect(page.getByRole("region", { name: "Activity details" })).toBeVisible();
 expect(sessions[1].ended_at).toBeNull();

 await pickWorkdayActivity(page, "job:Setup");
 await expect.poll(() => sessions[2]?.description).toBe("Setup");
 expect(sessions[1].ended_at).toBe(sessions[2].started_at);
 expect(sessions[1].workday_machinery_started_at).toBeNull();
 const sheet = page.locator(".clock-sheet");
 const pickTraining = async () => {
   await page.getByRole("button", { name: /^Switch job/ }).click();
   await page.getByRole("button", { name: /FORGE-TRAIN-1103.*Building 3/ }).click();
   await expect(sheet.locator(".clock-pick-summary")).toBeVisible();
 };
 await pickTraining();
 await expect(sheet.getByRole("searchbox")).toHaveCount(0);
 await sheet.getByRole("button", { name: "Cancel", exact: true }).click();
 expect(switches).toHaveLength(0);
 expect(sessions[2].ended_at).toBeNull();

 await context.setOffline(true);
 await pickTraining();
 await sheet.getByRole("button", { name: "Switch project", exact: true }).click();
 await expect(page).toHaveURL(new RegExp(training.id));
 await expect(page.locator(".wd-activity-picker")).toBeVisible();
 await expect(page.getByText(/Still running/)).toHaveCount(0);
 expect(switches).toHaveLength(0);
 await context.setOffline(false);
 await expect.poll(() => switches.length).toBe(1);
 expect(switches[0].p_project_id).toBe(training.id);
 expect(sessions[2].ended_at).toBe(switches[0].p_tapped_at);
 expect(commands.filter(command => command.action === "start")).toHaveLength(3);
});

test("company work asks to switch paid-clock scope before recording labor", async ({ page }) => {
 const { commands } = await setup(page);
 await page.goto(`/installer-day?project=${job.id}`);
 await page.evaluate(() => { window.addEventListener("infinity:open-clock", e => { (window as any).requestedClock = (e as CustomEvent).detail; }); });
 await pickWorkdayActivity(page, "company:Company delivery");
 await expect.poll(() => page.evaluate(() => (window as any).requestedClock)).toMatchObject({ projectId: null, companyWork: true, switchToProject: true, stayOnPage: true });
 expect(commands).toHaveLength(0);
});

test("Travel starts even if the installer leaves Workday before clock-in returns", async ({ page }) => {
 const { sessions } = await setup(page, true, true, true, "installer");
 let shift: Record<string, unknown> | null = null;
 const clockIns: unknown[] = [];
 let finishClockIn = () => {};
 const clockInResponse = new Promise<void>(resolve => { finishClockIn = resolve; });
 await page.route("**/rest/v1/safety_talks?*", route => route.fulfill({
   json: { id: job.id, title: "Test Toolbox Talk", body: "Check your PPE." },
 }));
 await page.route("**/rest/v1/toolbox_completions?*", route => route.fulfill({
   json: { id: opening.id, profile_id: TEST_USER.id, signed_at: new Date().toISOString(), talk_id: job.id },
 }));
 await page.route("**/rest/v1/cost_codes?*", route => route.fulfill({
   json: [{ id: opening.id, code: "100", label: "General", is_general: true }],
 }));
 await page.route("**/rest/v1/time_shifts?*", route =>
   route.fulfill({ json: route.request().headers().accept?.includes("object+json") ? shift : shift ? [shift] : [] }));
 await page.route("**/rest/v1/rpc/clock_in", async route => {
   const punch = route.request().postDataJSON();
   clockIns.push(punch);
   await clockInResponse;
   shift = { id: "33333333-3333-4333-8333-333333333333", profile_id: TEST_USER.id,
     project_id: job.id, status: "open", clock_in_at: punch.p_tapped_at.replace("Z", "123Z"), break_started_at: null };
   return route.fulfill({ json: shift });
 });
 await page.addInitScript(user => localStorage.setItem("forge-custom-work-v1:" + user, JSON.stringify([{
   id: "old-refused-work", userId: user, action: "start",
   error: "Clock in or resume your job clock before starting work.",
   data: { id: "old-session", at: "2026-09-15T10:00:00Z", description: "Travel" },
 }])), TEST_USER.id);
 await page.goto(`/installer-day?project=${job.id}`);
 await pickWorkdayActivity(page, "job:Travel");
 await expect.poll(() => clockIns.length).toBe(1);
 expect(clockIns[0]).toMatchObject({ p_project_id: job.id, p_cost_code_id: opening.id });
 await expect(page.getByRole("dialog", { name: "Time clock" })).toHaveCount(0);
 await page.getByRole("link", { name: "Settings", exact: true }).first().click();
 await expect(page).toHaveURL(/\/settings$/);
 finishClockIn();
 await expect.poll(() => sessions[0]?.description).toBe("Travel");
 expect(sessions[0].started_at).toBe((shift as { clock_in_at?: string } | null)?.clock_in_at);
 await page.getByRole("link", { name: "Work", exact: true }).first().click();
 const current = page.getByRole("region", { name: "Current activity" });
 await expect(current.locator(".wd-activity-picker")).toHaveAttribute("data-activity", "job:Travel");
 await expect(current.getByRole("status")).toContainText("Running");
 await expect(current.locator(".wd-timer strong")).not.toHaveText("0:00:00");
 expect(sessions).toHaveLength(1);
 expect(clockIns).toHaveLength(1);
});

test("paid Toolbox Talk starts the shift before the selected unit timer", async ({ page }) => {
 const { commands, sessions } = await setup(page);
 const costCode = { id: opening.id, code: "100", label: "General", is_general: true };
 let shift: Record<string, unknown> | null = null;
 let signature: Record<string, unknown> | null = null;
 await page.route("**/rest/v1/company_settings?*", route => route.fulfill({ json: { id: 1, paid_time_from_start_day_on: "2020-01-01" } }));
 await page.route("**/rest/v1/safety_talks?*", route => route.fulfill({ json: { id: job.id, title: "Test Toolbox Talk", body: "Check your PPE." } }));
 await page.route("**/rest/v1/toolbox_completions?*", route => route.fulfill({ json: signature }));
 await page.route("**/storage/v1/object/**", route => route.fulfill({ json: {} }));
 await page.route("**/rest/v1/rpc/sign_toolbox_talk", route => {
   expect(shift).not.toBeNull();
   expect(commands.filter(command => command.action === "start")).toHaveLength(0);
   signature = { id: opening.id, profile_id: TEST_USER.id, signed_at: new Date().toISOString(), talk_id: job.id };
   return route.fulfill({ json: signature });
 });
 await page.route("**/rest/v1/cost_codes?*", route => route.fulfill({ json: [costCode] }));
 await page.route("**/rest/v1/time_shifts?*", route =>
   route.fulfill({ json: route.request().headers().accept?.includes("object+json") ? shift : shift ? [shift] : [] }));
 await page.route("**/rest/v1/rpc/clock_in", route => {
   expect(route.request().postDataJSON()).toMatchObject({ p_project_id: job.id, p_cost_code_id: costCode.id });
   shift = { id: "33333333-3333-4333-8333-333333333333", profile_id: TEST_USER.id,
     project_id: job.id, status: "open", clock_in_at: new Date().toISOString(), break_started_at: null };
   return route.fulfill({ json: shift });
 });
 await page.goto(`/installer-day?project=${job.id}`);
 await pickWorkdayActivity(page, "unit:Flashing");
 await page.getByRole("button", { name: "+ Add unit", exact: true }).click();
 await page.getByRole("button", { name: "Add unit 12", exact: true }).click();
 await page.getByRole("button", { name: "Add 1 unit", exact: true }).click();
 await page.getByRole("button", { name: "Start unit 12 Flashing", exact: true }).click();
 const clockSheet = page.getByRole("dialog");
 await expect(clockSheet.getByText("Flashing · 12", { exact: true })).toBeVisible();
 await expect(clockSheet.getByText("Start on your assigned window", { exact: false })).toHaveCount(0);
 await expect(clockSheet.getByRole("button", { name: "100 — General" })).toHaveCount(0);
 await clockSheet.getByRole("button", { name: "Start Toolbox Talk", exact: true }).click();
 const talk = page.locator("#work-toolbox-signature");
 await expect(talk.getByText("Test Toolbox Talk")).toBeVisible();
 expect(shift).not.toBeNull();
 expect(commands.filter(command => command.action === "start")).toHaveLength(0);
 await talk.getByRole("checkbox").check();
 await talk.getByRole("textbox").fill("Test Installer");
 const pad = await talk.locator("canvas").boundingBox();
 if (!pad) throw new Error("The toolbox signature pad did not render.");
 await page.mouse.move(pad.x + 12, pad.y + 12);
 await page.mouse.down();
 await page.mouse.move(pad.x + 45, pad.y + 30, { steps: 4 });
 await page.mouse.up();
 await talk.getByRole("button", { name: "Sign today's talk", exact: true }).click();
 await expect.poll(() => commands.filter(command => command.action === "start").length).toBe(1);
 expect(sessions[0]).toMatchObject({ stage: "Flashing", project_id: job.id });
 await expect(page.getByRole("button", { name: "Running unit 12 Flashing", exact: true })).toBeVisible();
});

test("offline Workday reopens, pauses machinery, switches jobs and replays clock-out at the original tap", async ({ page, context }) => {
 const { commands, sessions } = await setup(page, true, true, true, "installer");
 let shift: Record<string, any> | null = null;
 const punches: { name: string; data: Record<string, any> }[] = [];
 let offline = false;
 let disconnectOnFirstPunch = true;
 const shiftId = "33333333-3333-4333-8333-333333333333";
 const companyShiftId = "33333333-3333-4333-8333-333333333334";
 await page.route("**/rest/v1/time_shifts?*", route => route.fulfill({
   json: route.request().headers().accept?.includes("object+json") ? shift : shift ? [shift] : [],
 }));
 await page.route("**/rest/v1/cost_codes?*", route => route.fulfill({
   json: [{ id: opening.id, code: "000", label: "General", is_general: true, active: true }],
 }));
 await page.route("**/rest/v1/rpc/*", async route => {
   const name = new URL(route.request().url()).pathname.split("/").at(-1)!;
   if (!["clock_in", "start_break", "end_break", "clock_out"].includes(name)) return route.fallback();
   if (name === "clock_in" && disconnectOnFirstPunch) {
     disconnectOnFirstPunch = false;
     offline = true;
     await context.setOffline(true);
     return route.abort("internetdisconnected");
   }
   const data = route.request().postDataJSON();
   punches.push({ name, data });
   if (name === "clock_in") {
     if (shift) expect(sessions.at(-1)?.ended_at).toBe(data.p_tapped_at);
     shift = { id: data.p_project_id ? shiftId : companyShiftId, profile_id: TEST_USER.id, project_id: data.p_project_id,
       clock_in_at: data.p_tapped_at, clock_out_at: null, status: "open", break_started_at: null, break_seconds: 0 };
   }
   if (name === "start_break") {
     expect(sessions.at(-1)?.ended_at).toBe(data.p_tapped_at);
     shift = { ...shift, break_started_at: data.p_tapped_at, break_type: data.p_break_type };
   }
   if (name === "end_break") {
     shift = { ...shift, break_started_at: null, break_type: null };
     return route.fulfill({ json: { outcome: "ended", shift } });
   }
   if (name === "clock_out") {
     expect(sessions.at(-1)?.ended_at).toBe(data.p_tapped_at);
     shift = { ...shift, clock_out_at: data.p_tapped_at, status: "submitted" };
   }
   return route.fulfill({ json: shift });
 });
 await page.route("**/*", async route => {
   const url = new URL(route.request().url());
   if (!offline) return route.fallback();
   if (url.hostname === "127.0.0.1") return route.fulfill({ response: await route.fetch() });
   return route.abort("internetdisconnected");
 });
 await page.goto(`/installer-day?project=${job.id}`);
 await pickWorkdayActivity(page, "unit:Flashing");
 await page.getByRole("button", { name: "+ Add unit", exact: true }).click();
 await page.getByRole("button", { name: "Add unit 12", exact: true }).click();
 await page.getByRole("button", { name: "Add 1 unit", exact: true }).click();
 await page.getByRole("button", { name: "Start unit 12 Flashing", exact: true }).click();
 const sheet = page.locator(".clock-sheet");
 const running = page.getByRole("button", { name: "Running unit 12 Flashing", exact: true });
 await expect(running).toBeEnabled();
 expect(punches).toHaveLength(0);
 await page.getByRole("switch", { name: "Operating machinery", checked: false }).click();
 await confirmMachinery(page);
 await expect(page.getByRole("switch", { name: "Operating machinery", checked: true })).toBeVisible();
 await page.reload();
 await expect(running).toBeEnabled();
 await expect(page.getByRole("switch", { name: "Operating machinery", checked: true })).toBeEnabled();
 // Break, resume and clock out are in the timer now, not the clock sheet.
 await page.getByRole("button", { name: "Break", exact: true }).click();
 await page.getByRole("region", { name: "Go on break" }).getByRole("button", { name: "Rest", exact: true }).click();
 await expect(page.getByRole("button", { name: "Start unit 12 Flashing", exact: true })).toBeVisible();
 await expect(page.getByRole("switch", { name: "Operating machinery", checked: true })).toHaveCount(0);
 await page.getByRole("button", { name: "Resume", exact: true }).click();
 await page.getByRole("button", { name: "Start unit 12 Flashing", exact: true }).click();
 await expect(running).toBeEnabled();
 await pickWorkdayActivity(page, "company:Company delivery");
 await sheet.getByRole("button", { name: "Switch project", exact: true }).click();
 await expect(page.getByRole("region", { name: "Current activity" }).getByText("Running", { exact: true })).toBeVisible();
 await page.getByRole("button", { name: "Clock out", exact: true }).click();
 await page.getByRole("region", { name: "Clock out" }).getByRole("button", { name: "Clock out", exact: true }).click();
 await expect(sheet).toBeHidden();
 await expect(running).toHaveCount(0);
 const saved = await page.evaluate(user => JSON.parse(localStorage.getItem("forge-custom-work-v1:" + user) ?? "[]"), TEST_USER.id);
 const stops = saved.filter((command: any) => command.action === "stop");
 expect(stops).toHaveLength(3);
 offline = false;
 await context.setOffline(false);
 await page.evaluate(() => window.dispatchEvent(new Event("online")));
 await expect.poll(() => punches.map(punch => punch.name), { timeout: 20000 }).toEqual(["clock_in", "start_break", "end_break", "clock_in", "clock_out"]);
 await expect.poll(() => sessions.filter(session => !session.ended_at).length).toBe(0);
 expect(sessions).toHaveLength(3);
 expect(sessions[0].workday_machinery_ms).toBeGreaterThan(0);
 expect(punches.find(punch => punch.name === "start_break")?.data.p_tapped_at).toBe(stops[0].data.at);
 expect(punches[3].data.p_tapped_at).toBe(stops[1].data.at);
 expect(punches.find(punch => punch.name === "clock_out")?.data.p_tapped_at).toBe(stops[2].data.at);
 expect(commands.filter(command => command.action === "start").map(command => command.shift_id)).toEqual([shiftId, shiftId, companyShiftId]);
});

test("company work under a company shift records no project or unit", async ({ page }) => {
 const { commands, sessions } = await setup(page);
 const companyShift = { id: "33333333-3333-4333-8333-333333333333", profile_id: TEST_USER.id, project_id: null, clock_in_at: new Date().toISOString(), clock_out_at: null, status: "open", break_seconds: 0, break_started_at: null };
 await page.route("**/rest/v1/time_shifts?*", route => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(route.request().headers().accept?.includes("object+json") ? companyShift : [companyShift]) }));
 await page.goto(`/installer-day?project=${job.id}`);
 await pickWorkdayActivity(page, "company:Company delivery");
 await expect.poll(() => commands.filter(c => c.action === "start").length).toBe(1);
 expect(sessions[0]).toMatchObject({ project_id: null, unit_id: null, description: "Company delivery" });
});

test("simple workday keeps details hidden and remembers Spanish", async ({ page }) => {
 const { commands } = await setup(page, false);
 await page.setViewportSize({ width: 390, height: 844 });
 await page.goto(`/installer-day?project=${job.id}`);
 await expect(page.locator(".wd-activity-picker")).toBeVisible();
 await page.getByRole("button", { name: "Start unit 12 RO checked", exact: true }).click();
 await expect(page.locator(".native-day-unit-details")).toHaveCount(0);
 await expect(page.getByRole("button", { name: "Mark activity done", exact: true })).toHaveCount(0);
 await page.getByRole("button", { name: "Details for unit 12", exact: true }).click();
 await expect(page.getByRole("button", { name: "Mark activity done", exact: true })).toBeVisible();
 await page.getByRole("button", { name: "Close details", exact: true }).click();
 await page.getByRole("button", { name: "Cambiar idioma a español", exact: true }).click();
 await expect(page.getByRole("button", { name: /^Actividad: / })).toHaveAttribute("data-activity", "unit:RO checked");
 await page.getByRole("button", { name: "Iniciar unidad 13 Revisar vano", exact: true }).click();
 await expect(page.locator(".wd-unit[data-running=true]")).toHaveCount(1);
 await page.screenshot({ path: ".test-temp/workday-simple-mobile.png", fullPage: true });
 expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
 await page.reload();
 await expect(page.getByRole("button", { name: /^Actividad: / })).toBeVisible();
 expect(commands).toHaveLength(0);
});

test("Ammon pilot options stay in details and never write configuration", async ({ page }) => {
 const { commands } = await setup(page, false);
 await page.goto(`/installer-day?project=${job.id}`);
 await pickWorkdayActivity(page, "job:Waiting / blocked");
 await expect(page.getByLabel("Waiting / blocked reason", { exact: true })).toHaveCount(0);
 await page.getByRole("button", { name: "Details & notes", exact: true }).click();
 await page.getByLabel("Waiting / blocked reason", { exact: true }).fill("Waiting for delivery");
 await page.getByRole("button", { name: "Close details", exact: true }).click();
 await pickWorkdayActivity(page, "job:Travel");
 await page.getByRole("button", { name: "Details & notes", exact: true }).click();
 await page.getByLabel("Travel purpose", { exact: true }).selectOption("other");
 await page.getByLabel("Travel description", { exact: true }).fill("Tool repair pickup");
 await page.getByRole("button", { name: "Close details", exact: true }).click();
 await pickWorkdayActivity(page, "job:Consulting / planning");
 await page.getByRole("button", { name: "Details & notes", exact: true }).click();
 await page.getByLabel("Consulting / planning with", { exact: true }).selectOption("supervisor");
 await page.getByRole("button", { name: "Close details", exact: true }).click();
 await pickWorkdayActivity(page, "unit:Staging");
 await page.getByRole("button", { name: "Details for unit 12", exact: true }).click();
 // The switch is always shown, for every activity, and off until someone turns it on.
 await expect(page.getByRole("switch", { name: "Operating machinery", checked: false })).toBeVisible();
 await page.getByRole("button", { name: "Close details", exact: true }).click();
 await pickWorkdayActivity(page, "job:Waiting / blocked");
 await page.getByRole("button", { name: "Details & notes", exact: true }).click();
 await expect(page.getByLabel("Waiting / blocked reason", { exact: true })).toHaveValue("Waiting for delivery");
 expect(commands).toHaveLength(0);
});

