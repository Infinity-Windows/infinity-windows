import { expect, test, type Locator, type Page } from "@playwright/test";
import { TEST_USER, useSupabaseFixtures as replaySupabase } from "./support/supabaseFixtures";

const job = { id: "11111111-1111-4111-8111-111111111111", job_code: "zztest", name: "TEST sandbox", is_test: true };
const opening = { id: "22222222-2222-4222-8222-222222222222", project_id: job.id, opening_code: "12", window_type_id: null, window_types: null, assigned_window_id: null, status: "planned", confirmed: true, created_at: "2026-11-03T15:00:00Z", page_number: 1, pin_x: 0.5, pin_y: 0.5 };
async function setup(page: Page, isTest = true, sandbox = true, projectAvailable = true, role: "owner" | "foreman" = "owner") {
  let language = "en";
  await replaySupabase(page, { role, profileOverrides: () => ({ is_test: isTest, language }) });
  const units: Record<string, any>[] = [], sessions: Record<string, any>[] = [], commands: Record<string, any>[] = [];
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
    if (table === "time_shifts") return reply(single ? shift : [shift]);
    if (table === "project_openings") return reply([opening, { ...opening, id: "22222222-2222-4222-8222-222222222223", opening_code: "13" }]);
    if (table === "project_mark_specs" || table === "studio_units" || table === "unit_sessions" || table === "opening_phases" || table === "custom_work_types") return reply(single ? null : []);
    if (table === "custom_work_units") return reply(units);
    if (table === "custom_work_sessions") return reply(sessions);
    if (["rpc/record_crew_work", "rpc/custom_work_command"].includes(table)) commands.push({ command: table });
    return route.fallback();
  });
  return { commands, sessions, units };
}



async function choosePlannerActivity(scope: Page | Locator, name: string) {
  if (!await scope.getByLabel("Activities", { exact: true }).isVisible()) {
    await scope.getByRole("button", { name: /^(Choose an activity|Change activity:)/ }).click();
  }
  await scope.getByRole("button", { name, exact: true }).click();
}

test("planner keeps completed units visible and saves dragged priority", async ({ page }) => {
  const { units, sessions } = await setup(page);
  const second = { ...opening, id: "22222222-2222-4222-8222-222222222223", opening_code: "13" };
  const complete = { ...opening, id: "22222222-2222-4222-8222-222222222224", opening_code: "14" };
  await page.route("**/rest/v1/project_openings?*", route => route.fulfill({ json: [opening, second, complete] }));
  units.push({ id: complete.id, opening_id: complete.id });
  sessions.push({ id: complete.id, unit_id: complete.id, stage: "Flashing", outcome: "finished", ended_at: "2026-11-09T16:00:00Z" });
  await page.goto(`/projects/${job.id}/planner`);
  const builder = page.getByRole("region", { name: "Plan an activity" });
  await page.getByRole("button", { name: "Activity", exact: true }).click();
  await choosePlannerActivity(builder, "Flashing");
  const completed = builder.getByRole("button", { name: "14 \u00b7 Complete", exact: true });
  await expect(completed).toBeVisible();
  await expect(completed).toHaveAttribute("aria-pressed", "false");
  for (const code of ["14 \u00b7 Complete", "12", "13"]) {
    await builder.locator(".jp-unit-options").getByRole("button", { name: code, exact: true }).click();
  }
  await builder.getByRole("button", { name: "Schedule", exact: true }).click();
  await page.locator(".jp-event-body").click();
  await page.getByRole("button", { name: "Edit Flashing", exact: true }).click();
  const editor = page.getByRole("region", { name: "Edit activity" });
  const queue = editor.getByLabel("Unit priority");
  await expect(queue.getByRole("button")).toHaveText(["12", "13", "14"]);
  const source = await queue.getByRole("button", { name: "13", exact: true }).boundingBox();
  const target = queue.getByRole("button", { name: "12", exact: true });
  const destination = await target.boundingBox();
  await page.mouse.move(source!.x + source!.width / 2, source!.y + source!.height / 2);
  await page.mouse.down();
  await page.mouse.move(destination!.x + destination!.width / 2, destination!.y + destination!.height / 2);
  await expect(queue.getByRole("button", { name: "13", exact: true })).toHaveAttribute("data-drop-position", "before");
  await expect.poll(async () => (await target.boundingBox())!.x).toBeGreaterThan(destination!.x + 5);
  await page.mouse.up();
  await expect(queue.locator("[data-drop-position]")).toHaveCount(0);
  await expect(queue.getByRole("button")).toHaveText(["13", "12", "14"]);
  await editor.getByRole("button", { name: "Save changes" }).click();
  expect(await page.evaluate(() => {
    const key = Object.keys(localStorage).find(key => key.startsWith("forge:job-plan:"))!;
    return JSON.parse(localStorage.getItem(key)!)[0].openingIds;
  })).toEqual([second.id, opening.id, complete.id]);
  await expect(page.locator(".jp-event .jp-scope-unit").first()).toContainText("13");
});

test("planner priority wraps, scrolls vertically, and reorders across rows", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await setup(page);
  await page.route("**/rest/v1/project_openings?*", route => route.fulfill({
    json: Array.from({ length: 30 }, (_, index) => ({
      ...opening, id: opening.id.slice(0, -2) + String(index).padStart(2, "0"), opening_code: String(100 + index),
    })),
  }));
  await page.goto(`/projects/${job.id}?tab=planner`);
  const builder = page.getByRole("region", { name: "Plan an activity" });
  await builder.getByRole("button", { name: "Unit", exact: true }).click();
  const selectAll = builder.getByRole("button", { name: "Select all on Unspecified floor" });
  await selectAll.click();
  await expect(selectAll).toBeDisabled();
  const list = builder.locator(".jp-priority-list");
  await expect.poll(() => list.evaluate(el => el.scrollHeight > el.clientHeight && el.scrollWidth === el.clientWidth)).toBe(true);
  const source = list.getByRole("button", { name: "100", exact: true });
  await source.scrollIntoViewIfNeeded();
  const row = await source.evaluate(el => el.offsetTop);
  const target = list.locator("button").nth(await list.locator("button").evaluateAll(
    (chips, top) => chips.findIndex(chip => (chip as HTMLElement).offsetTop > top), row,
  ));
  const name = await target.innerText();
  const from = (await source.boundingBox())!;
  const to = (await target.boundingBox())!;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 8 });
  await expect(source).toHaveAttribute("data-drop-position", "after");
  await page.mouse.up();
  const labels = await list.locator("button").allTextContents();
  expect(labels.indexOf("100")).toBe(labels.indexOf(name) + 1);
  await list.hover();
  await page.mouse.wheel(0, 500);
  await expect.poll(() => list.evaluate(el => el.scrollTop)).toBeGreaterThan(0);
});

test("fresh planner places activities, edits their specs, and supports mobile placement", async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 1100 });
  const { commands } = await setup(page);
  const helperId = "55555555-5555-4555-8555-555555555555";
  await page.route("**/rest/v1/profiles?*", async route => {
    if (!new URL(route.request().url()).searchParams.has("is_test")) return route.fallback();
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify([
      { id: TEST_USER.id, display_name: "Test Installer", role: "installer", active: true, is_partner: false },
      { id: helperId, display_name: "Eli Parker · Demo", role: "installer", active: true, is_partner: false },
    ]) });
  });
  await page.goto(`/projects/${job.id}/planner`);
  await expect(page.getByRole("region", { name: "Work calendar" })).toBeVisible();
  const composer = page.getByRole("region", { name: "Plan an activity" });
  await page.getByRole("button", { name: "Activity", exact: true }).click();
  await expect(page.locator(".job-plan-axis, .job-plan-composer-steps")).toHaveCount(0);
  await choosePlannerActivity(composer, "Flashing");
  await expect(composer.getByRole("button", { name: "Lead", exact: true })).toHaveCount(0);
  await composer.locator(".jp-unit-options").getByRole("button", { name: "12", exact: true }).click();
  await expect(composer.getByRole("button", { name: "Lead", exact: true })).toBeVisible();
  await expect(composer.getByRole("button", { name: "Choose crew", exact: true })).toBeVisible();
  await composer.getByRole("button", { name: "Schedule", exact: true }).click();
  const assignment = page.locator("[data-plan-block] .job-plan-assignment");
  await expect(assignment).toHaveCount(1);
  await expect(assignment).toContainText("Flashing");
  const color = await page.locator("[data-plan-block]").evaluate(element => getComputedStyle(element).backgroundColor);
  const editButton = page.getByRole("button", { name: "Edit Flashing", exact: true });
  await expect(editButton).toHaveCount(0);
  await assignment.click();
  await editButton.click();
  const details = page.getByRole("region", { name: "Edit activity" });
  await details.getByRole("button", { name: "Lead", exact: true }).click();
  await details.getByRole("group", { name: "Lead installer" }).getByRole("button", { name: "Test Installer", exact: true }).click();
  await details.getByRole("button", { name: "Choose crew", exact: true }).click();
  await details.getByRole("checkbox", { name: "Eli Parker", exact: true }).check();
  await details.getByRole("button", { name: /Crew · 1/ }).click();
  await details.getByRole("button", { name: "12 · in activity", exact: true }).click();
  await expect(details.locator(".jp-unit-member-summary")).toHaveAttribute("aria-label", "Lead: Test, 1 crew");
  const end = details.getByLabel("End", { exact: true });
  const endDate = (await end.inputValue()).split("T")[0];
  await end.fill(`${endDate}T15:00`);
  await details.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(details).toHaveCount(0);
  await expect(assignment).toContainText("Test Installer");
  await expect(assignment).toContainText("Eli Parker");
  expect(await page.locator("[data-plan-block]").evaluate(element => getComputedStyle(element).backgroundColor)).toBe(color);
  const saved = await page.evaluate(() => {
    const key = Object.keys(localStorage).find(key => key.startsWith("forge:job-plan:"))!;
    return JSON.parse(localStorage.getItem(key)!);
  });
  expect(saved).toHaveLength(1);
  expect(saved[0]).toMatchObject({ activity: "Flashing", kind: "unit", openingIds: [opening.id], installerIds: [TEST_USER.id, helperId], startMinute: 420, endMinute: 900 });
  expect(commands).toEqual([]);
  await page.screenshot({ path: ".test-temp/planner-fresh-calendar.png", fullPage: true });
  await page.locator("button.jp-date[data-today=true]").click();
  const bounds = (await assignment.boundingBox())!;
  const drag = async (x: number, y: number) => {
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + 21, y, { steps: 5 });
    await page.mouse.up();
  };
  await drag(bounds.x + 30, bounds.y + 20);
  const moved = (await assignment.boundingBox())!;
  expect(moved.x).toBeGreaterThan(bounds.x + 10);
  const edge = (await page.locator(".jp-resize-end").boundingBox())!;
  await drag(edge.x + edge.width / 2, edge.y + 20);
  await expect.poll(async () => (await assignment.boundingBox())!.width).toBeGreaterThan(moved.width + 10);
  await expect(editButton).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Edit activity" })).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const visibleMember = (await assignment.locator(".jp-members > span").first().boundingBox())!;
  expect(visibleMember.x).toBeGreaterThanOrEqual(16);
  expect(visibleMember.x).toBeLessThan(360);
  await page.screenshot({ path: ".test-temp/planner-fresh-mobile.png", fullPage: true });
  await composer.getByRole("button", { name: "Activity", exact: true }).click();
  await choosePlannerActivity(composer, "Travel");
  const start = (await composer.getByLabel("Start", { exact: true }).boundingBox())!;
  const endField = (await composer.getByLabel("End", { exact: true }).boundingBox())!;
  const scheduleButton = (await composer.locator(".jp-create-actions").boundingBox())!;
  expect(endField.y).toBeGreaterThan(start.y + start.height);
  expect(scheduleButton.y).toBeGreaterThan(endField.y + endField.height);
  expect(scheduleButton.height).toBe(endField.height);
  expect(Math.abs((scheduleButton.x + scheduleButton.width / 2) - (endField.x + endField.width / 2))).toBeLessThan(2);

  await composer.getByRole("button", { name: "Schedule", exact: true }).click();
  await expect(assignment).toHaveCount(2);
  const allWork = await page.evaluate(() => {
    const key = Object.keys(localStorage).find(key => key.startsWith("forge:job-plan:"))!;
    return JSON.parse(localStorage.getItem(key)!);
  });
  expect(allWork.find((block: any) => block.activity === "Travel")).toMatchObject({
    kind: "general", installerIds: [], openingIds: [],
  });
  expect(commands).toHaveLength(0);
});

test("planner tab shows current and next job stages", async ({ page }) => {
 const { commands } = await setup(page);
 await page.route("**/rest/v1/projects?*", route => {
   const row = { ...job, status: "active", start_date: "2026-11-16", project_pipeline: { ready_state: "not_ready", materials_eta: "2026-11-12", materials_arrived_at: null } };
   return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(route.request().headers().accept?.includes("object+json") ? row : [row]) });
 });
 await page.route("**/rest/v1/project_stage_progress?*", route => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify([
   { project_id: job.id, stage_key: "material_delivered", completed: true },
   { project_id: job.id, stage_key: "material_onsite", completed: true },
 ]) }));
 await page.goto(`/projects/${job.id}/planner`);
 await expect(page).toHaveURL(/tab=planner/);
 const tabs = page.getByRole("navigation", { name: "Project sections" });
 await expect(tabs.getByRole("button").filter({ hasText: /^(Overview|Plan|Custom Data)$/ })).toHaveText(["Overview", "Plan", "Custom Data"]);
 await expect(tabs.getByRole("button", { name: "Plan", exact: true })).toHaveAttribute("aria-current", "page");
 await expect(page.getByLabel("Job planning status")).toHaveText("Stage: RO's Checked → RO's Flashed");
 expect(commands).toHaveLength(0);
});


test("foreman cannot open the owner-only planner tab", async ({ page }) => {
  await setup(page, true, true, true, "foreman");
  await page.goto(`/projects/${job.id}/planner`);
  await expect(page).toHaveURL(new RegExp(`/projects/${job.id}$`));
  await expect(page.getByRole("button", { name: "Plan", exact: true })).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Work calendar" })).toHaveCount(0);
});

test("planner activity dropdown scrolls through the full list", async ({ page }) => {
  await setup(page);
  await page.goto(`/projects/${job.id}/planner`);
  const composer = page.getByRole("region", { name: "Plan an activity" });
  await composer.getByRole("button", { name: "Activity", exact: true }).click();
  const menu = composer.getByLabel("Activities", { exact: true });
  await expect(menu).toBeVisible();
  await expect(composer.getByRole("button", { name: "Dictate", exact: true })).toHaveCount(0);
  await expect(menu.getByRole("searchbox")).toHaveCount(0);
  await expect(menu.getByRole("region", { name: "General job work" })).toBeVisible();
  const lastActivity = menu.getByRole("button", { name: "Problem-solving", exact: true });
  await expect(lastActivity).not.toBeInViewport();
  await menu.hover();
  await page.mouse.wheel(0, 1400);
  await expect(lastActivity).toBeInViewport();
  await lastActivity.click();
  await expect(menu).toBeHidden();
  await expect(composer.getByRole("button", { name: "Change activity: Problem-solving" })).toBeVisible();
  const start = await composer.getByLabel("Start", { exact: true }).inputValue();
  await composer.getByLabel("End", { exact: true }).fill(start.slice(0, 10) + "T08:00");
  await composer.getByRole("button", { name: "Schedule", exact: true }).click();
  const title = page.locator(".jp-work-title > span:first-of-type");
  await expect.poll(() => title.evaluate(element => element.scrollWidth > element.clientWidth)).toBe(true);
  await title.hover();
  await expect(page.locator(".jp-title-overflow:popover-open")).toHaveText("Problem-solving");
  await composer.getByRole("button", { name: "Activity", exact: true }).hover();
  await expect(page.locator(".jp-title-overflow:popover-open")).toHaveCount(0);
});

test("planner swaps the activity toolbox and keeps board position", async ({ page }) => {
 await setup(page);
 await page.route("**/rest/v1/profiles?*", route => {
  if (!new URL(route.request().url()).searchParams.has("is_test")) return route.fallback();
  return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify([{ id: TEST_USER.id, display_name: "E2E Fixture", active: true, role: "installer", is_partner: false }]) });
 });
 await page.goto(`/projects/${job.id}/planner`);
 const composer = page.getByRole("region", { name: "Plan an activity" });
  await page.getByRole("button", { name: "Activity", exact: true }).click();
 await expect(composer.getByRole("button", { name: "Choose an activity", exact: true })).toBeVisible();
 await expect(composer.getByRole("button", { name: "Cancel schedule" })).toBeVisible();
 await choosePlannerActivity(composer, "Flashing");
 await expect(composer.getByRole("button", { name: "Cancel schedule" })).toBeVisible();
 await expect(composer.getByRole("region", { name: "Units", exact: true })).toBeVisible();
 await choosePlannerActivity(composer, "Travel");
 const crew = composer.getByRole("region", { name: "Crew", exact: true });
 await crew.getByRole("button", { name: "E2E Fixture", exact: true }).click();
 await expect(crew.getByRole("button", { name: "E2E Fixture", exact: true })).toHaveAttribute("aria-pressed", "true");
 await expect(composer.getByRole("region", { name: "Units", exact: true })).toHaveCount(0);
 await page.locator(".jp-scroll").evaluate(el => { el.scrollLeft = 650; });
 await page.waitForTimeout(100);
 const date = page.locator("button.jp-date").nth(4);
 await date.scrollIntoViewIfNeeded();
 const before = await page.locator(".jp-scroll").evaluate(el => el.scrollLeft);
 await date.click();
 await page.getByRole("button", { name: "Back to calendar", exact: true }).click();
 await expect.poll(() => page.locator(".jp-scroll").evaluate(el => el.scrollLeft)).toBe(before);
 expect(await page.locator(".jp-scroll").evaluate(el => el.scrollHeight <= el.clientHeight + 1)).toBe(true);
 await page.setViewportSize({ width: 390, height: 844 });
 await expect(crew).toBeVisible();
 await expect(composer.locator(".jp-draft").getByRole("button", { name: "Schedule" })).toBeVisible();
 expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
 await composer.getByRole("button", { name: "Cancel", exact: true }).click();
 await expect(composer.getByRole("button", { name: "Activity", exact: true })).toBeVisible();
});

test("planner moves a bundle, pulls out an activity, and deletes from the card", async ({ page }) => {
  await setup(page);
  await page.goto(`/projects/${job.id}?tab=planner`);
  const builder = page.getByRole("region", { name: "Plan an activity" });
  await builder.getByRole("button", { name: "Unit", exact: true }).click();
  await builder.getByRole("button", { name: "12", exact: true }).click();
  await builder.getByRole("button", { name: "Hide units", exact: true }).click();
  await expect(builder.locator(".jp-floor-browser")).toBeHidden();
  await expect(builder.locator(".jp-priority-list")).toContainText("12");
  await builder.getByRole("button", { name: "Show units", exact: true }).click();
  await expect(builder.locator(".jp-floor-browser")).toBeVisible();
  await builder.getByRole("button", { name: "Flashing", exact: true }).click();
  await builder.getByRole("button", { name: "Sealing", exact: true }).click();
  const date = (await builder.getByLabel("Start", { exact: true }).inputValue()).slice(0, 10);
  await builder.getByLabel("End", { exact: true }).fill(date + "T10:00");
  await builder.getByRole("button", { name: "Schedule", exact: true }).click();
  const bundle = page.getByRole("article", { name: "Bundled activities" });
  await bundle.locator(".jp-stack-title").first().click();
  await bundle.getByRole("button", { name: "Edit bundle", exact: true }).click();
  const editor = page.getByRole("region", { name: "Edit bundle", exact: true });
  await editor.getByLabel("End", { exact: true }).fill(date + "T11:00");
  await editor.getByRole("button", { name: "Save changes", exact: true }).click();
  await page.locator(`button.jp-date[data-date="${date}"]`).click();

  const read = () => page.evaluate(() => {
    const key = Object.keys(localStorage).find(key => key.startsWith("forge:job-plan:"))!;
    return JSON.parse(localStorage.getItem(key)!).sort((a, b) => a.activity.localeCompare(b.activity));
  });
  const drag = async (target: Locator, distance = 84, beforeDrop?: () => Promise<void>) => {
    await target.scrollIntoViewIfNeeded();
    const bounds = (await target.boundingBox())!;
    const x = bounds.x + Math.min(bounds.width / 2, 44);
    const y = bounds.y + bounds.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + distance, y, { steps: 8 });
    await beforeDrop?.();
    await page.mouse.up();
  };
  await bundle.locator(".jp-stack-layer[data-front=true] .jp-stack-title").click();
  await drag(bundle.getByRole("button", { name: "Drag to move bundle", exact: true }));
  await expect.poll(read).toMatchObject([
    { activity: "Flashing", startMinute: 480, endMinute: 720 },
    { activity: "Sealing", startMinute: 480, endMinute: 720 },
  ]);
  await bundle.hover();
  await drag(bundle.getByRole("button", { name: "Flashing", exact: true }));
  await expect.poll(read).toMatchObject([
    { activity: "Flashing", startMinute: 540, endMinute: 780 },
    { activity: "Sealing", startMinute: 480, endMinute: 720 },
  ]);
  await expect(bundle).toHaveCount(0);
  await drag(page.getByRole("button", { name: /^Flashing ·/ }).locator(".jp-work-title"), -84, async () => {
    const preview = page.locator(".jp-drop-preview");
    await expect(preview).toHaveText("Joins 2-activity bundle");
    const sealing = page.getByRole("button", { name: /^Sealing ·/ }).locator("..");
    const lane = await sealing.evaluate(element => (element as HTMLElement).style.gridRow);
    expect(await preview.evaluate(element => (element as HTMLElement).style.gridRow)).toBe(lane);
  });
  await expect(bundle).toBeVisible();
  await bundle.hover();
  await bundle.getByRole("button", { name: "Flashing", exact: true }).click();
  page.once("dialog", dialog => dialog.accept());
  await page.getByRole("button", { name: "Delete Flashing", exact: true }).click();
  await expect.poll(read).toMatchObject([{ activity: "Sealing" }]);
});

test("planner skips Sunday and moves Saturday work to Monday", async ({ page }) => {
  await page.clock.setFixedTime(new Date("2026-11-08T19:00:00Z"));
  await setup(page);
  await page.goto(`/projects/${job.id}/planner`);
  await expect(page.locator('.jp-date[data-date="2026-11-08"]')).toHaveCount(0);
  await page.getByRole("button", { name: "Activity", exact: true }).click();
  await choosePlannerActivity(page, "Travel");
  await page.getByLabel("Start", { exact: true }).fill("2026-11-07T07:00");
  await page.getByRole("button", { name: "Schedule", exact: true }).click();
  const card = page.getByRole("button", { name: /Travel ·/ });
  const monday = page.locator('.jp-date[data-date="2026-11-09"]');
  const from = (await card.boundingBox())!;
  const to = (await monday.boundingBox())!;
  await page.mouse.move(from.x + 30, from.y + 30);
  await page.mouse.down();
  await page.mouse.move(to.x + 30, from.y + 30, { steps: 8 });
  await page.mouse.up();
  await monday.click();
  await expect(card).toBeVisible();
  await expect(page.locator(".jp-date-picker input")).toHaveValue("2026-11-09");
});

test("Building 3 auto-publishes and merges concurrent planner activity", async ({ browser, page }) => {
  const project = "c8bf4d94-5086-40ed-9d8c-b3c88add2229";
  const installer = "55555555-5555-4555-8555-555555555555";
  const helper = "55555555-5555-4555-8555-555555555556";
  const context = await browser.newContext();
  const second = await context.newPage();
  let revision = 0;
  let published: { id: string; activity: string }[] = [];
  let insertConcurrentDuplicate = false;
  let moveConcurrentActivity = false;
  const snapshot = () => ({ revision, blocks: published });
  for (const tab of [page, second]) {
    await setup(tab);
    await tab.route("**/rest/v1/projects?*", route => {
      const building3 = { ...job, id: project };
      return route.fulfill({ json: route.request().headers().accept?.includes("object+json") ? building3 : [building3] });
    });
    await tab.route("**/rest/v1/project_openings?*", route => route.fulfill({ json: ["1-1", "1-2", "2-1"].map((code, i) => ({
      ...opening, id: i ? installer.slice(0, -1) + i : opening.id, project_id: project, opening_code: code,
    })) }));
    await tab.route("**/rest/v1/profiles?*", route => {
      if (!new URL(route.request().url()).searchParams.has("is_test")) return route.fallback();
      return route.fulfill({ json: [
        { id: installer, display_name: "Test installer", role: "installer", active: true },
        { id: helper, display_name: "Second installer", role: "installer", active: true },
      ] });
    });
    await tab.route("**/rest/v1/rpc/*installer_plan*", async route => {
      const command = new URL(route.request().url()).pathname.split("/").at(-1);
      if (command === "get_installer_plan") return route.fulfill({ json: snapshot() });
      const body = route.request().postDataJSON();
      if (insertConcurrentDuplicate) {
        insertConcurrentDuplicate = false;
        const added = body.p_blocks.find((block: { activity: string }) => block.activity === "Sealing");
        published = [...published, { ...added, id: "concurrent-sealing", installerIds: [], openingCrew: {} }];
        revision++;
      }
      if (moveConcurrentActivity) {
        moveConcurrentActivity = false;
        published = published.map(block => block.activity === "Flashing" ? { ...block, endMinute: 840 } : block);
        revision++;
      }
      if (body.p_revision !== revision) return route.fulfill({ status: 409, json: { code: "40001", message: "Plan changed" } });
      published = body.p_blocks;
      revision++;
      return route.fulfill({ json: snapshot() });
    });
  }
  try {
    const planner = `/projects/${project}/planner?sharedPlan=1`;
    await page.goto(planner);
    await second.goto(planner);
    await expect(second.getByRole("button", { name: "Bundle activities" })).toHaveCount(0);
    await page.getByRole("button", { name: "Activity", exact: true }).click();
    await second.getByRole("button", { name: "Activity", exact: true }).click();
    await choosePlannerActivity(page, "Flashing");
    await page.getByRole("button", { name: "1-1", exact: true }).click();
    await page.getByRole("button", { name: "Lead", exact: true }).click();
    await page.getByRole("button", { name: "Test installer", exact: true }).click();
    const day = (await page.getByLabel("Start", { exact: true }).inputValue()).slice(0, 10);
    await page.getByLabel("End", { exact: true }).fill(day + "T12:00");
    await page.getByRole("button", { name: "Schedule", exact: true }).click();
    await expect(page.getByRole("button", { name: "Flashing · Test installer", exact: true })).toBeVisible();
    const flashingCard = second.getByRole("button", { name: "Flashing · Test installer", exact: true });
    await expect(flashingCard).toBeVisible({ timeout: 15000 });
    await expect(flashingCard.locator(".jp-calendar-label > svg")).toBeVisible();
    await expect(second.getByText("Someone saved a newer plan.", { exact: false })).toHaveCount(0);

    await choosePlannerActivity(second, "Travel");
    await page.getByRole("button", { name: "Activity", exact: true }).click();
    await choosePlannerActivity(page, "Cleanup");
    await page.getByLabel("Start", { exact: true }).fill(day + "T12:00");
    await page.getByRole("button", { name: "Schedule", exact: true }).click();
    await expect(second.getByRole("button", { name: /Cleanup/ })).toBeVisible({ timeout: 15000 });
    await expect(second.getByRole("button", { name: /^Change activity:/ })).toContainText("Travel");
    await second.getByLabel("Start", { exact: true }).fill(day + "T12:00");
    await second.getByRole("button", { name: "Schedule", exact: true }).click();
    await expect(second.getByRole("button", { name: /Travel/ })).toBeVisible();
    await expect(second.getByRole("button", { name: /Cleanup/ })).toBeVisible();

    await second.getByRole("button", { name: "Unit", exact: true }).click();
    await second.getByRole("button", { name: "Cancel schedule", exact: true }).click();
    await second.getByRole("button", { name: "Unit", exact: true }).click();
    const picker = second.locator(".jp-unit-options");
    await picker.getByRole("button", { name: "1-1", exact: true }).click();
    await picker.getByRole("button", { name: "1-2", exact: true }).click();
    await second.getByRole("button", { name: "Lead", exact: true }).click();
    await second.getByRole("button", { name: "Test installer", exact: true }).click();
    await expect(second.getByText("Lead assigned to 2 units")).toBeVisible();
    await picker.getByRole("button", { name: "2-1", exact: true }).click();
    await second.getByRole("button", { name: "Lead", exact: true }).click();
    await second.getByRole("button", { name: "Second installer", exact: true }).click();
    await expect(picker.locator('[aria-label="Lead: Test"]')).toHaveCount(2);
    await second.getByRole("button", { name: "Sealing", exact: true }).click();
    await second.getByRole("button", { name: "Setting frame", exact: true }).click();
    await second.getByLabel("End", { exact: true }).fill(day + "T12:00");
    insertConcurrentDuplicate = true;
    const confirmation = second.waitForEvent("dialog").then(async dialog => {
      const message = dialog.message();
      await dialog.accept();
      return message;
    });
    await second.getByRole("button", { name: "Schedule", exact: true }).click();
    expect(await confirmation).toBe("Sealing was already added to this plan. Add another?");
    const bundle = second.getByRole("article", { name: "Bundled activities" })
      .filter({ has: second.getByRole("button", { name: "Setting frame", exact: true }) });
    await bundle.hover();
    await expect(bundle.getByRole("button", { name: "Sealing", exact: true }).locator("svg")).toBeVisible();
    const frame = bundle.getByRole("button", { name: "Setting frame", exact: true });
    await frame.click();
    const layer = bundle.locator(".jp-stack-layer[data-front=true]");
    await expect(layer.getByRole("button", { name: "Setting frame", exact: true })).toBeVisible();
    const back = (await bundle.locator(".jp-stack-layer[data-front=false]").boundingBox())!;
    const front = (await layer.boundingBox())!;
    expect(front.y).toBeGreaterThan(back.y);
    expect(front.y).toBeLessThan(back.y + back.height);
    await expect(frame).toHaveAttribute("aria-pressed", "true");
    await bundle.getByRole("button", { name: "Edit Setting frame", exact: true }).click();
    await expect(second.getByRole("region", { name: "Edit activity" }).getByRole("button", { name: "Change activity: Setting frame" })).toBeVisible();
    await expect(bundle.getByRole("button", { name: "Edit Setting frame", exact: true })).toBeDisabled();
    await second.getByRole("region", { name: "Edit activity" }).getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(bundle.getByRole("button", { name: "Edit Setting frame", exact: true })).toBeEnabled();

    await second.locator(`button.jp-date[data-date="${day}"]`).click();
    const rightEdge = bundle.locator(".jp-resize-end");
    const handle = (await rightEdge.boundingBox())!;
    await second.mouse.move(handle.x + handle.width / 2, handle.y + 10);
    await second.mouse.down();
    await second.mouse.move(handle.x + handle.width / 2 + 42, handle.y + 10, { steps: 6 });
    await second.mouse.up();
    const frameTime = () => published.find(block => block.activity === "Setting frame");
    const sealingTime = () => published.find(block => block.activity === "Sealing" && block.id !== "concurrent-sealing");
    await expect.poll(frameTime).toMatchObject({ endMinute: 750 });
    expect(sealingTime()).toMatchObject({ endMinute: 750 });
    await frame.click();
    await bundle.getByRole("button", { name: "Edit Setting frame", exact: true }).click();
    await second.getByLabel("Start", { exact: true }).fill(day + "T07:15");
    await second.getByRole("button", { name: "Save changes", exact: true }).click();
    await expect.poll(frameTime).toMatchObject({ startMinute: 435, endMinute: 750 });
    expect(sealingTime()).toMatchObject({ startMinute: 420, endMinute: 750 });
    await expect(bundle).toHaveCount(0);

    await page.getByRole("button", { name: "Flashing · Test installer", exact: true }).locator(".jp-work-title").click();
    await page.getByRole("button", { name: "Edit Flashing", exact: true }).click();
    await page.getByLabel("End", { exact: true }).fill(`${day}T13:00`);
    moveConcurrentActivity = true;
    const moveConfirmation = page.waitForEvent("dialog").then(async dialog => {
      const message = dialog.message();
      await dialog.accept();
      return message;
    });
    await page.getByRole("button", { name: "Save changes", exact: true }).click();
    expect(await moveConfirmation).toContain("2:00 PM");
    await expect.poll(() => published.find(block => block.activity === "Flashing")).toMatchObject({ endMinute: 780 });
  } finally {
    await context.close();
  }
});
