import { shiftPlanDate } from "../src/lib/installerWorkflow/jobPlan";
import { expect, test } from "@playwright/test";

async function pickWorkdayActivity(page: import("@playwright/test").Page, choice: string) {
  const planned = page.locator(`.wd-plan [data-choice="${choice}"]`);
  if (await planned.isVisible()) {
    await planned.click();
    return;
  }
  await page.locator(".wd-activity-picker").click();
  await page.locator(`.wd-activity-grid [data-choice="${choice}"]`).click();
}

import { TEST_USER, useSupabaseFixtures } from "./support/supabaseFixtures";

test("Building 3 shared plan reaches the installer's Work tab and Workday in unit priority order", async ({ page }) => {
  page.setDefaultTimeout(12_000);
  let role: "installer" | "foreman" = "installer";
  await useSupabaseFixtures(page, { role, uiDesign: "new", profileOverrides: () => ({ is_test: true, role }) });
  const projectId = "c8bf4d94-5086-40ed-9d8c-b3c88add2229";
  const job = { id: projectId, job_code: "FORGE-TRAIN-1103", name: "Building 3 test job", is_test: true };
  const ids = ["22222222-2222-4222-8222-222222222223", "22222222-2222-4222-8222-222222222222"];
  const labels = { [ids[0]]: "1-17", [ids[1]]: "1-12" };
  const day = new Date();
  const today = [day.getFullYear(), String(day.getMonth() + 1).padStart(2, "0"), String(day.getDate()).padStart(2, "0")].join("-");
  const block = {
    id: "flashing", activity: "Flashing", kind: "unit", start: today, end: today,
    startMinute: 420, endMinute: 1020, unitCrewOnly: true, installerIds: [TEST_USER.id],
    openingIds: ids, openingCrew: { [ids[0]]: { leadId: TEST_USER.id, crewIds: [] }, [ids[1]]: { crewIds: [TEST_USER.id] } },
  };
  const previous = { ...block, id: "previous-flashing", unitCrewOnly: false, start: shiftPlanDate(today, -1), end: shiftPlanDate(today, -1),
    startMinute: 780, endMinute: 1020,
    openingIds: ["22222222-2222-4222-8222-222222222225", ids[0], "22222222-2222-4222-8222-222222222224"] };
  await page.route(/\/rest\/v1\/custom_work_(units|sessions|types)(\?|$)/, route => {
    const sessions = previous.openingIds.slice(1).map((id, index) => ({
      id, unit_id: id, profile_id: TEST_USER.id, project_id: projectId,
      stage: "Flashing", started_at: previous.start + "T12:00:00", ended_at: previous.start + "T13:00:00",
      outcome: index === 1 ? "finished" : "partial",
      workday_done_at: index === 0 ? previous.start + "T13:00:00" : null,
    }));
    const url = new URL(route.request().url());
    const rows = url.pathname.endsWith("custom_work_sessions")
      ? url.searchParams.get("unit_id") === "eq." + ids[0] ? [sessions[0]] : sessions
      : url.pathname.endsWith("custom_work_units") && (!url.searchParams.has("opening_id") || url.searchParams.get("opening_id") === "eq." + ids[0])
        ? [{ id: ids[0], opening_id: ids[0], project_id: projectId, label: labels[ids[0]], facts: { installation_complete: "Yes" } }] : [];
    return route.fulfill({ json: rows, headers: {
      "content-range": rows.length ? `0-${rows.length - 1}/${rows.length}` : "*/0",
      "access-control-expose-headers": "content-range",
    } });
  });
  await page.route("**/rest/v1/schedule_assignment_members?*", route => route.fulfill({ json: [{ assignment_id: "training-assignment" }] }));
  await page.route("**/rest/v1/schedule_assignments?*", route => route.fulfill({ json: [{
    id: "training-assignment", project_id: job.id, kind: "install", status: "published",
    start_date: today, end_date: today, start_time: "07:00:00", projects: job,
    schedule_assignment_members: [{ profile_id: TEST_USER.id, role: "installer" }],
  }] }));
  await page.route("**/rest/v1/rpc/get_my_installer_plan_window", route => route.fulfill({
    json: [
      { projectId: "22222222-2222-4222-8222-222222222220", jobCode: "AFTERNOON", jobName: "Later job",
        blocks: [{ ...block, startMinute: 780 }], unitLabels: labels },
      { projectId, jobCode: job.job_code, jobName: job.name, blocks: [block], unitLabels: labels },
    ],
  }));
  await page.route("**/rest/v1/rpc/get_published_installer_plan", route => {
    expect(route.request().postDataJSON()).toEqual({ p_project_id: projectId, p_installer_id: null });
    return route.fulfill({ json: [block, previous] });
  });
  await page.route("**/rest/v1/rpc/is_sandbox_project", route => route.fulfill({ json: true }));
  await page.route("**/rest/v1/projects?*", route => {
    const id = new URL(route.request().url()).searchParams.get("id");
    if (id && id !== "eq." + projectId) return route.fallback();
    return route.fulfill({ json: [job] });
  });
  await page.route("**/rest/v1/profiles?*", route => {
    if (new URL(route.request().url()).searchParams.get("select") !== "id,is_test") return route.fallback();
    return route.fulfill({ json: { id: TEST_USER.id, is_test: true } });
  });
  const openings = [...ids].reverse().map(id => ({
    id, project_id: projectId, opening_code: labels[id], confirmed: true,
    unit_details: {} as Record<string, unknown>,
  }));
  openings.push(
    { id: "22222222-2222-4222-8222-222222222224", project_id: projectId, opening_code: "1-18", confirmed: true, unit_details: {} },
    { id: "22222222-2222-4222-8222-222222222225", project_id: projectId, opening_code: "1-19", confirmed: true, unit_details: {} },
  );
  await page.route("**/rest/v1/project_openings?*", route => {
    const filters = new URL(route.request().url()).searchParams;
    if (filters.has("id")) return route.fulfill({ json: openings.filter(row => "eq." + row.id === filters.get("id")) });
    if (filters.get("project_id") !== "eq." + projectId) return route.fallback();
    return route.fulfill({ json: openings });
  });
  const writes: Record<string, unknown>[] = [];
  await page.route("**/rest/v1/rpc/save_unit_details", route => {
    const write = route.request().postDataJSON();
    expect(write.p_project).toBe(projectId);
    writes.push(write);
    const opening = openings.find(row => row.id === write.p_opening);
    if (opening) {
      expect(opening.unit_details).toEqual(write.p_previous_details);
      expect(opening.opening_code).toBe(write.p_previous_code);
      opening.unit_details = write.p_details;
      opening.opening_code = write.p_code;
      labels[opening.id] = write.p_code;
    } else {
      expect(write.p_create).toBe(true);
      openings.push({ id: write.p_opening, project_id: projectId, opening_code: write.p_code,
        confirmed: false, unit_details: write.p_details });
    }
    return route.fulfill({ status: 204 });
  });
  await page.goto("/");
  const assigned = page.getByRole("region", { name: "Upcoming work" });
  const flashing = assigned.getByRole("region", { name: "FORGE-TRAIN-1103", exact: true }).getByRole("article").filter({ hasText: "Flashing" });
  await expect(flashing).toContainText(/2 units.*Lead 1.*Crew 1/);
  await expect(flashing.getByText("1-17", { exact: true })).toBeHidden();
  await flashing.locator("summary").click();
  await expect(flashing.getByText("1-17", { exact: true })).toBeVisible();
  await expect(flashing.locator(".ws-plan-role")).toHaveText([/Lead.*1-17/, /Crew.*1-12/]);
  await flashing.getByRole("button", { name: "1-17", exact: true }).click();
  const details = page.getByRole("dialog", { name: "1-17" });
  await expect(details).toBeVisible();
  await expect(details).toContainText("Flashing");
  await expect(details.getByRole("status")).toHaveText(["Unit complete", "Complete"]);
  await expect(details).toContainText("You");
  await expect(details.getByRole("link", { name: "Opening sheet" })).toBeVisible();
  await expect(details.getByRole("link", { name: "Catalog", exact: true })).toHaveCount(0);
  await expect(details).toContainText("Drawing size");
  await details.getByRole("button", { name: "Edit unit", exact: true }).click();
  await details.getByLabel("Inset/outset").selectOption("outset");
  await details.getByRole("button", { name: "Save unit", exact: true }).click();
  await expect(details.getByRole("button", { name: "Edit unit", exact: true })).toBeVisible();
  await expect(details.getByText("Outset", { exact: true })).toBeVisible();
  expect(writes).toHaveLength(1);
  await page.keyboard.press("Escape");
  await expect(details).toHaveCount(0);

  const todayJobs = page.getByRole("region", { name: "Start Your Work Day" });
  await expect(todayJobs.getByRole("button")).toHaveText([/FORGE-TRAIN-1103/, /AFTERNOON/, "Find Job"]);
  await todayJobs.getByRole("button", { name: /FORGE-TRAIN-1103/ }).click();
  const switcher = page.getByRole("button", { name: /^Switch job/ });
  await switcher.click();
  const jobs = page.getByRole("region", { name: "Available jobs" });
  await expect(jobs.getByRole("button", { name: /AFTERNOON.*Planned today/ })).toBeVisible();
  await switcher.click();
  await expect(flashing.getByRole("link")).toHaveCount(0);
  const activityPicker = page.getByRole("button", { name: "Activity: Flashing", exact: true });
  await activityPicker.click();
  const toolbox = page.getByRole("region", { name: "Choose activity" });
  // Planned activities are in the list with the rest, marked as planned.
  await expect(toolbox.getByRole("button", { name: "Flashing", exact: true })).toHaveAttribute("data-planned", "true");
  await expect(toolbox.getByRole("button", { name: "Travel", exact: true })).toBeVisible();
  await activityPicker.click();
  const units = page.getByRole("region", { name: "Units", exact: true });
  const unitNames = units.locator(".wd-units .jp-unit-caption > strong");
  // In the Plan's order for today; a unit the person adds goes after the planned ones.
  await expect(unitNames).toHaveText(["1-12", "1-19", "1-17"]);
  await expect(units.getByRole("button", { name: "Start unit 1-19 Flashing" })).toContainText("Planned");
  await units.getByRole("button", { name: "+ Add unit", exact: true }).click();
  await units.getByRole("button", { name: "Add unit 1-18", exact: true }).click();
  await units.getByRole("button", { name: "Add 1 unit", exact: true }).click();
  await expect(unitNames).toHaveText(["1-12", "1-19", "1-17", "1-18"]);
  await units.getByRole("button", { name: "Details for unit 1-17", exact: true }).click();
  const workdayDetails = page.getByRole("region", { name: "Activity details" });
  await expect(workdayDetails.getByText("Outset", { exact: true })).toBeVisible();
  await expect(workdayDetails.getByText("Unit complete", { exact: true })).toBeVisible();
  await page.context().setOffline(true);
  await workdayDetails.getByRole("button", { name: "Edit unit", exact: true }).click();
  await workdayDetails.getByLabel("Material").fill("Fiberglass");
  await workdayDetails.getByLabel("Reason (optional)").fill("Verified on site");
  await workdayDetails.getByRole("button", { name: "Save unit", exact: true }).click();
  await expect(workdayDetails.getByText("Unit changes waiting to sync")).toBeVisible();
  await expect(workdayDetails.getByText("Fiberglass", { exact: true })).toBeVisible();
  expect(writes).toHaveLength(1);
  await page.context().setOffline(false);
  await expect.poll(() => writes.length).toBe(2);
  expect(writes[1]).toMatchObject({ p_edit_id: expect.any(String), p_reason: "Verified on site" });
  expect(writes[1].p_edit_id).not.toBe(writes[0].p_edit_id);
  expect(writes[0].p_reason).toBeNull();
  await expect(workdayDetails.getByText("Unit changes waiting to sync")).toBeHidden();
  await expect(workdayDetails.getByText("Fiberglass", { exact: true })).toBeVisible();

  await units.getByRole("button", { name: "+ Add unit", exact: true }).click();
  await units.getByRole("button", { name: "Create unit", exact: true }).click();
  const create = page.getByRole("dialog", { name: "Create unit" });
  const unitNumber = create.getByLabel("Unit number");
  await expect(unitNumber).toHaveAttribute("inputmode", "numeric");
  await unitNumber.fill("1");
  await create.getByRole("button", { name: "Insert dash" }).click();
  await expect(unitNumber).toHaveValue("1-");
  await create.getByRole("button", { name: "Use letter keyboard" }).click();
  await expect(unitNumber).toHaveAttribute("inputmode", "text");
  await unitNumber.fill("PH-301");
  await create.getByLabel("Type", { exact: true }).selectOption("window");
  await create.getByLabel("Floor number").fill("3");
  await create.getByRole("button", { name: "Save unit", exact: true }).click();
  await expect(create).toBeHidden();
  await expect(units.getByRole("button", { name: "Start unit PH-301 Flashing" })).toBeVisible();
  await expect(workdayDetails.getByText("PH-301 · Placeholder", { exact: true })).toBeVisible();
  expect(writes[2].p_details).toEqual({ placeholder: true, kind: "window", floor: "3" });
  const placeholderId = String(writes[2].p_opening);

  await page.goto("/projects/" + projectId + "?tab=map");
  const unitList = page.locator("ul.unit-list").filter({ has: page.getByRole("button", { name: /PH-301/ }) });
  await unitList.getByRole("button", { name: /PH-301/ }).click();
  await unitList.getByRole("button", { name: "Unit details", exact: true }).click();
  const listed = page.getByRole("dialog", { name: "PH-301" });
  await expect(listed.getByText("Window", { exact: true })).toBeVisible();

  role = "foreman";
  const crewId = "22222222-2222-4222-8222-222222222226";
  const leadId = "22222222-2222-4222-8222-222222222227";
  await page.route("**/rest/v1/profiles?*", route => {
    if (new URL(route.request().url()).searchParams.has("is_test")) {
      return route.fulfill({ json: [
        { id: leadId, display_name: "Assigned lead", role: "installer", active: true },
        { id: crewId, display_name: "Assigned installer", role: "installer", active: true },
      ], headers: { "content-range": "0-1/2", "access-control-expose-headers": "content-range" } });
    }
    return route.fallback();
  });
  const marks: { opening_id: string; activity: string; done_at: string }[] = [];
  await page.route("**/rest/v1/rpc/get_plan_activity_done", route => route.fulfill({ json: marks }));
  await page.route("**/rest/v1/rpc/mark_plan_activity_done", route => {
    const { p_id, p_data } = route.request().postDataJSON();
    expect(p_data).toEqual({ project_id: projectId, opening_id: previous.openingIds[0], activity: "Flashing" });
    marks.push({ opening_id: p_data.opening_id, activity: p_data.activity, done_at: new Date().toISOString() });
    return route.fulfill({ json: p_id });
  });
  let savedBlocks = [block, previous], revision = 1;
  await page.route("**/rest/v1/rpc/get_installer_plan", route => route.fulfill({ json: { revision, blocks: savedBlocks } }));
  await page.route("**/rest/v1/rpc/save_installer_plan", route => {
    const body = route.request().postDataJSON();
    expect(body.p_project_id).toBe(projectId);
    savedBlocks = body.p_blocks;
    return route.fulfill({ json: { revision: ++revision, blocks: savedBlocks } });
  });
  await page.goto("/projects/" + projectId + "?tab=planner");
  const plan = page.getByRole("region", { name: "Plan an activity" });
  await plan.getByRole("button", { name: "Unit", exact: true }).click();
  await plan.getByRole("button", { name: "PH-301", exact: true }).click();
  await plan.getByRole("button", { name: "Lead", exact: true }).click();
  await plan.getByRole("group", { name: "Lead installer" }).getByRole("button", { name: "Assigned lead", exact: true }).click();
  await plan.getByRole("button", { name: "Choose crew", exact: true }).click();
  await plan.getByRole("group", { name: "Crew members" }).getByRole("checkbox", { name: "Assigned installer" }).check();
  await page.keyboard.press("Escape");
  await plan.getByRole("button", { name: "Details for PH-301", exact: true }).click();
  const planned = page.getByRole("dialog", { name: "PH-301" });
  await planned.getByRole("button", { name: "Edit unit", exact: true }).click();
  await planned.getByLabel("Unit number").fill("PH-302");
  await planned.getByRole("button", { name: "Save unit", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "PH-302" })).toBeVisible();
  expect(writes[3].p_opening).toBe(placeholderId);
  await page.keyboard.press("Escape");
  await expect(plan.getByRole("button", { name: /PH-302/ }).first()).toBeVisible();
  await plan.getByRole("button", { name: "Sealing", exact: true }).click();
  await plan.getByRole("button", { name: "Schedule", exact: true }).click();
  await expect.poll(() => savedBlocks.find(value => value.activity === "Sealing")).toMatchObject({
    openingIds: [placeholderId],
    openingCrew: { [placeholderId]: { leadId, crewIds: [crewId] } },
  });
  const pastCard = page.locator('[data-plan-block="previous-flashing"]');
  await expect(pastCard).toBeVisible();
  await expect(pastCard).toContainText("1-19");
  await expect(pastCard).toContainText("1-18");
  await pastCard.locator(".jp-event-body").click();
  await pastCard.getByRole("button", { name: "Edit Flashing" }).click();
  const edit = page.getByRole("region", { name: "Edit activity" });
  await expect(edit.getByLabel("Start", { exact: true })).toHaveValue(today + "T13:00"); // carried work keeps its planned hours
  await edit.getByRole("button", { name: "Details for 1-19", exact: true }).click();
  const overdueUnit = page.getByRole("dialog", { name: "1-19" });
  await page.context().setOffline(true);
  await overdueUnit.getByRole("button", { name: "Mark activity done" }).click();
  await expect(overdueUnit.getByText("Waiting to sync", { exact: true })).toBeVisible();
  expect(marks).toHaveLength(0);
  await page.context().setOffline(false);
  await expect(overdueUnit.getByText("Complete", { exact: true })).toBeVisible();
  expect(marks).toHaveLength(1);
  await page.keyboard.press("Escape");
  await expect(pastCard).toHaveCount(0);
  await edit.getByRole("button", { name: "Cancel", exact: true }).click();
  const sealing = savedBlocks.find(value => value.activity === "Sealing")!;
  const sealingCard = page.locator("[data-plan-block=" + JSON.stringify(sealing.id) + "]");
  await sealingCard.locator(".jp-event-body").click();
  await sealingCard.getByRole("button", { name: "Edit Sealing" }).click();
  let rescheduledDay = shiftPlanDate(today, 1);
  if (new Date(rescheduledDay + "T12:00:00").getDay() === 0) rescheduledDay = shiftPlanDate(rescheduledDay, 1);
  await edit.getByLabel("Start", { exact: true }).fill(rescheduledDay + "T09:00");
  await edit.getByLabel("End", { exact: true }).fill(rescheduledDay + "T11:00");
  await edit.getByRole("button", { name: "Save changes" }).click();
  await expect.poll(() => savedBlocks.filter(value => value.activity === "Sealing").map(value => [value.id, value.start, value.startMinute]))
    .toEqual([[sealing.id, rescheduledDay, 540]]);
  await expect(sealingCard).toHaveCount(1);
  const remove = sealingCard.getByRole("button", { name: "Delete Sealing" });
  if (!await remove.isVisible()) await sealingCard.locator(".jp-event-body").click();
  await remove.click();
  await page.getByRole("alertdialog", { name: "Delete from the plan" }).getByRole("button", { name: "Delete", exact: true }).click();
  await expect(sealingCard).toHaveCount(0);
  expect(savedBlocks.some(value => value.id === sealing.id)).toBe(false);

  role = "installer";
  await page.goto("/");
  const training = page.getByRole("region", { name: "Start Your Work Day" });
  await training.getByRole("button", { name: /FORGE-TRAIN-1103/ }).click();
  const workdayUnits = page.getByRole("region", { name: "Units", exact: true });
  await expect(workdayUnits.getByRole("button", { name: /Start unit 1-19 Flashing/ })).toHaveCount(0);
});

test("a scheduled installer sees a job with no Plan and can pick unplanned work", async ({ page }) => {
  await useSupabaseFixtures(page, { role: "installer", uiDesign: "new" });
  const job = { id: "c8bf4d94-5086-40ed-9d8c-b3c88add2229", job_code: "FORGE-TRAIN-1103", name: "Building 3 test job", is_test: true };
  const day = new Date();
  const today = [day.getFullYear(), String(day.getMonth() + 1).padStart(2, "0"), String(day.getDate()).padStart(2, "0")].join("-");
  await page.route("**/rest/v1/schedule_assignment_members?*", route => route.fulfill({ json: [{ assignment_id: "training-assignment" }] }));
  await page.route("**/rest/v1/schedule_assignments?*", route => route.fulfill({ json: [{
    id: "training-assignment", project_id: job.id, kind: "install", status: "published",
    start_date: today, end_date: today, start_time: "07:00:00", projects: job,
    schedule_assignment_members: [{ profile_id: TEST_USER.id, role: "installer" }],
  }] }));
  await page.route("**/rest/v1/rpc/is_sandbox_project", route => route.fulfill({ json: true }));
  await page.route("**/rest/v1/rpc/get_my_installer_plan_window", route => route.fulfill({ json: [] }));
  await page.route("**/rest/v1/rpc/get_published_installer_plan", route => route.fulfill({ json: [] }));
  await page.route("**/rest/v1/profiles?*", route => {
    const select = new URL(route.request().url()).searchParams.get("select");
    if (select === "is_test") return route.fulfill({ json: { is_test: true } });
    if (select === "id,is_test") return route.fulfill({ json: { id: TEST_USER.id, is_test: true } });
    return route.fallback();
  });
  await page.route("**/rest/v1/projects?*", route => {
    const params = new URL(route.request().url()).searchParams;
    if (params.get("id") === "eq." + job.id) return route.fulfill({ json: [job] });
    if (params.get("select") !== "id,job_code,name") return route.fallback();
    return route.fulfill({ json: params.get("or")?.includes("FORGE-TRAIN-1103") ? [job] : [] });
  });
  await page.route("**/rest/v1/project_openings?*", route => {
    if (new URL(route.request().url()).searchParams.get("project_id") !== "eq." + job.id) return route.fallback();
    return route.fulfill({ json: [{ id: "22222222-2222-4222-8222-222222222224", project_id: job.id, opening_code: "1-18", confirmed: true }] });
  });
  await page.route(/\/rest\/v1\/custom_work_(units|sessions|types)(\?|$)/, route =>
    route.fulfill({ json: [], headers: { "content-range": "*/0", "access-control-expose-headers": "content-range" } }));
  await page.goto("/");
  const todayJobs = page.getByRole("region", { name: "Start Your Work Day" });
  await expect(todayJobs.getByRole("button", { name: /FORGE-TRAIN-1103/ })).toHaveCount(1);
  await expect(todayJobs.getByRole("button", { name: "Find Job" })).toBeVisible();
  await todayJobs.getByRole("button", { name: /FORGE-TRAIN-1103/ }).click();
  await expect(page.getByText("FORGE-TRAIN-1103", { exact: true })).toBeVisible();
  await expect(page.getByTestId("work-screen")).toBeVisible();
  await pickWorkdayActivity(page, "unit:Flashing");
  await page.getByRole("button", { name: "+ Add unit", exact: true }).click();
  await page.getByRole("button", { name: "Add unit 1-18", exact: true }).click();
  await page.getByRole("button", { name: "Add 1 unit", exact: true }).click();
  await expect(page.getByRole("button", { name: "Start unit 1-18 Flashing" })).toContainText("Unplanned");
  await pickWorkdayActivity(page, "job:Setup");
  await expect(page.locator(".clock-sheet").getByText("Setup", { exact: true })).toBeVisible();
  await page.locator(".clock-sheet").getByRole("button", { name: "Close", exact: true }).click();
  await pickWorkdayActivity(page, "company:Warehouse work");
  await expect(page.locator(".clock-sheet").getByText("Warehouse work", { exact: true })).toBeVisible();
});

test("training activities are corrected through the queue and offered in the clock-out daily log", async ({ page }) => {
  let role: "foreman" | "owner" = "foreman";
  await useSupabaseFixtures(page, { role, uiDesign: "new", profileOverrides: () => ({ role }) });
  const project = { id: "c8bf4d94-5086-40ed-9d8c-b3c88add2229", job_code: "FORGE-TRAIN-1103", name: "Building 3 test job" };
  const unit = { id: "22222222-2222-4222-8222-222222222254", project_id: project.id, label: "PH-54", facts: {} };
  const at = new Date(); at.setHours(10, 0, 0, 0);
  let row = {
    id: "22222222-2222-4222-8222-222222222255", project_id: project.id, profile_id: TEST_USER.id,
    unit_id: unit.id, kind: "unit", stage: "Flashing", started_at: at.toISOString(),
    ended_at: new Date(at.getTime() + 600_000).toISOString(), workday_machinery_ms: 120_000,
    revision: 1, description: "First note", outcome: "partial", delay_reason: "",
  };
  const counted = (rows: unknown[]) => ({ json: rows,
    headers: { "content-range": rows.length ? "0-" + (rows.length - 1) + "/" + rows.length : "*/0",
      "access-control-expose-headers": "content-range" },
  });
  await page.route("**/rest/v1/projects?*", r => r.fulfill({ json: [project] }));
  await page.route("**/rest/v1/custom_work_sessions?*", r => r.fulfill(counted([row])));
  await page.route("**/rest/v1/custom_work_units?*", r => r.fulfill(counted([unit])));
  await page.route("**/rest/v1/custom_work_types?*", r => r.fulfill(counted([])));
  await page.route("**/rest/v1/daily_logs?*", r => r.fulfill({ json: [] }));
  const writes: Record<string, unknown>[] = [];
  await page.route("**/rest/v1/rpc/custom_work_command", r => {
    const body = r.request().postDataJSON();
    expect(body.p_action).toBe("session");
    expect(body.p_data.id).toBe(row.id);
    expect(body.p_data.revision).toBe(row.revision);
    writes.push(body);
    row = { ...row, ...body.p_data, revision: row.revision + 1 };
    return r.fulfill({ json: row.id });
  });
  await page.goto("/activities?job=" + project.id);
  await expect(page.getByRole("heading", { name: "Recent activities" })).toBeVisible();
  // Each activity is a row that opens to show its details.
  const openRow = () => page.getByRole("button", { name: /^Flashing for / }).click();
  await openRow();
  await expect(page.locator(".cw-activity-facts").getByText("Machinery", { exact: true })).toBeVisible();
  const capture = page.getByRole("button", { name: "Quick capture", exact: true });
  await expect(capture).toBeVisible();
  // Desktop keeps Capture in the navbar; it never floats over the page.
  expect(await capture.evaluate(button => button.closest(".app-rail") !== null)).toBe(true);
  await page.setViewportSize({ width: 390, height: 800 });
  // With the navbar hidden, the bottom bar's centre button takes over.
  await expect(capture).toBeVisible();
  expect(await capture.evaluate(button => button.closest(".tabbar") !== null)).toBe(true);
  await capture.click();
  await expect(page.getByRole("dialog", { name: "Quick capture" })).toBeVisible();
  await page.keyboard.press("Escape");

  // The open row already holds the correction form.
  await page.locator(".cw-correction").getByLabel(/^Notes/).fill("Corrected from the crew notes");
  await page.getByLabel("Correction reason").fill("Confirmed with installer");
  const correctedEnd = new Date(at.getTime() + 720_000);
  const localEnd = new Date(correctedEnd.getTime() - correctedEnd.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
  await page.getByLabel("Ended", { exact: true }).fill(localEnd);
  await page.context().setOffline(true);
  await page.getByRole("button", { name: "Save correction" }).click();
  await expect(page.getByRole("complementary", { name: "Pending work" })).toBeVisible();
  expect(writes).toHaveLength(0);
  await page.context().setOffline(false);
  await expect.poll(() => writes.length).toBe(1);
  expect(row.ended_at).toBe(correctedEnd.toISOString());
  // Saving closes the row; the corrected note is in its details.
  await openRow();
  await expect(page.getByText("Corrected from the crew notes", { exact: true })).toBeVisible();
  await page.reload();
  await openRow();
  await expect(page.getByText("Corrected from the crew notes", { exact: true })).toBeVisible();

  await page.context().setOffline(true);
  await page.evaluate(job => window.dispatchEvent(new CustomEvent("infinity:clocked-out", {
    detail: { projectId: job.id, job },
  })), project);
  await page.getByRole("button", { name: "Write it" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByLabel(/notes/i).first()).toHaveValue(/PH-54.*12:00.*Machinery.*Corrected from the crew notes/s);
  await page.context().setOffline(false);
});

// This test used to finish by finding the corrected activity under Data's
// "Proposed" tab, with its machinery time. That tab has been retired (Data now
// has Job Performance and Work Dashboard). Where a corrected activity and its
// machinery show in Data is the open check in the walkthrough's Stop 5; write
// this once that is settled.
test.fixme("a corrected activity shows in Data with its machinery time", async () => {});

test("a foreman corrects a machine timer's out time without touching the rest of the activity", async ({ page }) => {
  await useSupabaseFixtures(page, { role: "foreman", uiDesign: "new", profileOverrides: () => ({ role: "foreman" }) });
  const project = { id: "c8bf4d94-5086-40ed-9d8c-b3c88add2229", job_code: "FORGE-TRAIN-1103", name: "Building 3 test job" };
  const at = new Date(); at.setHours(10, 0, 0, 0);
  const time = (seconds: number) => new Date(at.getTime() + seconds * 1000).toISOString();
  const local = (iso: string) => new Date(Date.parse(iso) - new Date(iso).getTimezoneOffset() * 60_000).toISOString().slice(0, 19);
  let row: Record<string, unknown> = {
    id: "22222222-2222-4222-8222-222222222256", project_id: project.id, profile_id: TEST_USER.id,
    unit_id: null, kind: "idle", stage: "Idle time", started_at: time(0), ended_at: time(600),
    workday_machinery_ms: 120_000, workday_machinery_spans: [{ on: time(60), off: time(180) }],
    revision: 1, description: "Staging", outcome: null, delay_reason: "",
  };
  const counted = (rows: unknown[]) => ({ json: rows,
    headers: { "content-range": rows.length ? "0-" + (rows.length - 1) + "/" + rows.length : "*/0",
      "access-control-expose-headers": "content-range" },
  });
  await page.route("**/rest/v1/projects?*", r => r.fulfill({ json: [project] }));
  await page.route("**/rest/v1/custom_work_sessions?*", r => r.fulfill(counted([row])));
  await page.route("**/rest/v1/custom_work_units?*", r => r.fulfill(counted([])));
  await page.route("**/rest/v1/custom_work_types?*", r => r.fulfill(counted([])));
  const details: unknown[] = [], machinery: { p_data: { id: string; reason: string; spans: { on: string; off: string }[] } }[] = [];
  await page.route("**/rest/v1/rpc/custom_work_command", r => { details.push(r.request().postDataJSON()); return r.fulfill({ json: row.id }); });
  await page.route("**/rest/v1/rpc/correct_workday_machinery", r => {
    const body = r.request().postDataJSON();
    machinery.push(body);
    row = { ...row, workday_machinery_spans: body.p_data.spans, workday_machinery_ms: 185_000 };
    return r.fulfill({ json: row.id });
  });
  await page.goto("/activities?job=" + project.id);
  await page.getByRole("button", { name: /^Staging for / }).click();
  const timers = page.getByRole("group", { name: /Machine timers/ });
  await expect(timers).toContainText("0:02:00");
  // Seconds that are not :00, so the browser keeps them in the field.
  await timers.getByLabel("Out", { exact: true }).fill(local(time(245)));
  await expect(timers).toContainText("0:03:05");
  await page.getByLabel("Correction reason").fill("Left running while unloading");
  await page.getByRole("button", { name: "Save correction" }).click();
  await expect.poll(() => machinery.length).toBe(1);
  expect(machinery[0].p_data).toMatchObject({ id: row.id, reason: "Left running while unloading",
    spans: [{ on: time(60), off: time(245) }] });
  // Only the timer changed, so no second correction is filed for the activity.
  expect(details).toHaveLength(0);
});
