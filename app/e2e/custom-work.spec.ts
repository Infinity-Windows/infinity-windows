import { test, expect, type Page } from "@playwright/test";
import {
  useSupabaseFixtures as installFixtures,
  jobFixtures,
  openingsFor,
  TEST_USER,
} from "./support/supabaseFixtures";
import { hideWrongProjectBanner, json } from "./support/specHelpers";
import {
  previewCommands,
  type WorkUnit,
  type WorkSession,
  type WorkType,
} from "../src/lib/customWork/model";

async function setupWork(
  page: Page,
  role: "installer" | "foreman" | "supervisor" | "owner" = "installer",
) {
  await installFixtures(page, { role });
  await hideWrongProjectBanner(page);
  const projectId = jobFixtures()[0].projectId;
  const data = {
    units: [] as WorkUnit[],
    sessions: [] as WorkSession[],
    offline: false,
    refuse: false,
  };
  const types: WorkType[] = [
    { id: "fixed", label: "Fixed window", revision: 1, archived: false },
  ];
  const counted = (rows: unknown[]) => ({
    status: 200,
    contentType: "application/json",
    headers: {
      "content-range": `0-${Math.max(0, rows.length - 1)}/${rows.length}`,
      "access-control-expose-headers": "content-range",
    },
    body: JSON.stringify(rows),
  });
  const shift = {
    id: "11111111-1111-4111-8111-111111111111",
    profile_id: TEST_USER.id,
    project_id: projectId,
    clock_in_at: new Date(Date.now() - 3600000).toISOString(),
    clock_out_at: null,
    status: "open",
    break_started_at: null,
    break_seconds: 0,
  };
  await page.route("**/rest/v1/time_shifts**", (route) =>
    json(
      route,
      route.request().headers().accept?.includes("object") ? shift : [shift],
    ),
  );
  await page.route("**/rest/v1/custom_work_units**", (route) =>
    route.fulfill(counted(data.units)),
  );
  await page.route("**/rest/v1/custom_work_sessions**", (route) =>
    route.fulfill(counted(data.sessions)),
  );
  await page.route("**/rest/v1/custom_work_types**", (route) =>
    route.fulfill(counted(types)),
  );
  await page.route("**/rest/v1/custom_work_history**", (route) =>
    route.fulfill(counted([])),
  );
  await page.route("**/rest/v1/rpc/custom_work_command", async (route) => {
    if (data.offline) return route.abort("internetdisconnected");
    if (data.refuse)
      return route.fulfill({
        status: 400,
        contentType: "application/json",
        body: JSON.stringify({
          code: "P0001",
          message:
            "Your current work changed. Sync and review before retrying.",
        }),
      });
    const b = route.request().postDataJSON();
    const result = previewCommands(data.units, data.sessions, [
      { id: b.p_id, userId: TEST_USER.id, action: b.p_action, data: b.p_data },
    ]);
    data.units = result.units;
    data.sessions = result.sessions;
    await json(route, b.p_data.id ?? b.p_data.expected_session_id);
  });
  return { projectId, data };
}

for (const role of ["installer", "foreman", "supervisor", "owner"] as const) {
  test(`${role} captures a custom unit, idle time, and job data`, async ({
    page,
  }) => {
    test.setTimeout(60000);
    const { projectId, data } = await setupWork(page, role);
    await page.goto("/");
    await expect(
      page.getByRole("heading", { name: "Current Work", exact: true }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "+ Start unit", exact: true })
      .click();
    await page.getByLabel("Unit number / name").fill("16");
    await page
      .getByLabel("Type", { exact: true })
      .fill("Custom aluminum slider");
    await page
      .getByRole("button", { name: "Start this unit", exact: true })
      .click();
    const active = page.getByRole("region", { name: "Current activity" });
    await expect(
      active.getByRole("heading", { name: "Unit 16" }),
    ).toBeVisible();
    if (role === "foreman")
      await page.screenshot({
        path: "e2e/test-results/current-work-phone.png",
        fullPage: true,
      });
    await active.getByRole("button", { name: "Edit unit details" }).click();
    await page.getByLabel("Frame width (inches)").fill("48");
    await page.getByLabel("Frame height (inches)").fill("60");
    await page.getByLabel("Floor / story").fill("12");
    if (role === "foreman") {
      const editor = page.getByRole("region", {
        name: "Unit details",
        exact: true,
      });
      // Capture the form alone; fixed app chrome would cover a tall element image.
      const formImage = {
        style: ".tabbar, .sync-strip, .ask-fab { visibility: hidden !important; }",
      };
      await editor.getByLabel("Frame material").selectOption("Aluminum");
      await editor.getByLabel("Electrical components").selectOption("No");
      await editor.getByLabel("Machinery needed").selectOption("Yes");
      await editor
        .getByRole("combobox", { name: "Access", exact: true })
        .selectOption("Difficult");
      await editor.getByLabel("Complexity").selectOption("Custom");
      await expect(editor.getByLabel("Machinery use (minutes)")).toBeHidden();
      await editor.getByRole("heading", { name: "Necessary information" }).click();
      await editor.screenshot({ ...formImage, path: "e2e/test-results/unit-form-phone.png" });
      await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
      await editor.screenshot({ ...formImage, path: "e2e/test-results/unit-form-phone-dark.png" });
      await page.setViewportSize({ width: 1280, height: 1000 });
      await editor.screenshot({ ...formImage, path: "e2e/test-results/unit-form-desktop.png" });
      await page.setViewportSize({ width: 375, height: 812 });
      await editor.getByText("Helpful information", { exact: true }).click();
      await editor.getByLabel("Machinery use (minutes)").fill("25");
      await editor.screenshot({ ...formImage, path: "e2e/test-results/unit-form-helpful-phone.png" });
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth),
      ).toBeLessThanOrEqual(375);
      await editor.getByText("Helpful information", { exact: true }).click();
      await page.setViewportSize({ width: 390, height: 844 });
    }
    await page
      .getByRole("button", { name: "Save details", exact: true })
      .click();
    await active.getByText("Outcome and work note", { exact: true }).click();
    await active
      .getByLabel("What did you accomplish?")
      .fill("Set the frame and adjusted the slider.");
    await active
      .getByLabel("Outcome", { exact: true })
      .selectOption("finished");
    await active
      .getByRole("button", { name: "Finish → Idle time", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Moving windows/material", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Start idle time", exact: true })
      .click();
    await expect(
      active.getByRole("heading", { name: "Idle time", exact: true }),
    ).toBeVisible();
    await expect.poll(() => data.sessions.length).toBe(2);
    await expect
      .poll(() => data.sessions.filter((s) => !s.ended_at).length)
      .toBe(1);
    expect(data.sessions[0].ended_at).toBe(data.sessions[1].started_at);
    await page.reload();
    await expect(
      active.getByRole("heading", { name: "Idle time", exact: true }),
    ).toBeVisible();
    await page.goto(`/projects/${projectId}?tab=custom-data`);
    await expect(
      page.getByRole("heading", { name: "Custom Data", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("Custom aluminum slider · 20.0 SQF", { exact: false }),
    ).toBeVisible();
    await expect(
      page.getByText("Set the frame and adjusted the slider.", { exact: true }),
    ).toBeVisible();
    expect(data.units[0].facts.story).toBe("12");
    if (role === "foreman") expect(data.units[0].facts.equipment_minutes).toBe(25);
    if (role === "installer")
      await expect(
        page.getByText("Manage reusable unit types", { exact: true }),
      ).toHaveCount(0);
    if (role === "foreman") {
      await page.screenshot({
        path: "e2e/test-results/custom-data-phone.png",
        fullPage: true,
      });
      await page.setViewportSize({ width: 1440, height: 1000 });
      await page.screenshot({
        path: "e2e/test-results/custom-data-desktop.png",
        fullPage: true,
      });
    }
  });
}

// 2026-09-24: crews said marking a unit complete "doesn't work or save". The
// form's "Save and start" saved the Yes and then started a visit, which
// reopens completion, so no unit ever stayed complete. Now one tap on the
// running unit finishes it, and the form's Yes is a plain save.
test("an installer marks a unit complete in one tap, and it stays complete", async ({
  page,
}) => {
  test.setTimeout(60000);
  const { data } = await setupWork(page, "installer");
  await page.goto("/");
  await page.getByRole("button", { name: "+ Start unit", exact: true }).click();
  await page.getByLabel("Unit number / name").fill("16");
  await page.getByLabel("Type", { exact: true }).fill("Custom aluminum slider");
  await page.getByRole("button", { name: "Start this unit", exact: true }).click();
  const active = page.getByRole("region", { name: "Current activity" });
  await expect(active.getByRole("heading", { name: "Unit 16" })).toBeVisible();
  // Settled: the start has synced and the form has closed.
  await expect(page.getByRole("region", { name: "Unit details", exact: true })).toHaveCount(0);
  await expect(active.getByRole("button", { name: "Unit complete ✓", exact: true })).toBeEnabled();
  await page.screenshot({ path: "e2e/test-results/unit-running-phone.png" });
  await active.getByRole("button", { name: "Unit complete ✓", exact: true }).click();
  await expect.poll(() => data.units[0]?.facts.installation_complete).toBe("Yes");
  await expect.poll(() => data.sessions.filter((s) => !s.ended_at).length).toBe(0);
  expect(data.sessions[0].outcome).toBe("finished");
  await expect(page.getByText("✓ Install complete", { exact: true })).toBeVisible();
  // Both commands went through: nothing is left refused in the queue, so the
  // screen is usable again (a stuck queue disables every button here).
  await expect(
    page.getByRole("button", { name: "Start again (reopens it)", exact: true }),
  ).toBeEnabled();
  await expect(page.getByText(/saved on this device — pending sync/)).toHaveCount(0);
  await page.screenshot({ path: "e2e/test-results/unit-complete-phone.png", fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
    page.viewportSize()!.width,
  );
  await page.reload();
  await expect(page.getByText("✓ Install complete", { exact: true })).toBeVisible();
  expect(data.units[0].facts.installation_complete).toBe("Yes");
});

test("choosing whole install complete in the unit form saves without starting a visit", async ({
  page,
}) => {
  test.setTimeout(60000);
  const { data } = await setupWork(page, "installer");
  await page.goto("/");
  await page.getByRole("button", { name: "+ Start unit", exact: true }).click();
  await page.getByLabel("Unit number / name").fill("17");
  await page.getByLabel("Type", { exact: true }).fill("Fixed window");
  await page.getByRole("button", { name: "Start this unit", exact: true }).click();
  const active = page.getByRole("region", { name: "Current activity" });
  await expect(active.getByRole("heading", { name: "Unit 17" })).toBeVisible();
  await active.getByRole("button", { name: "Edit unit details" }).click();
  const editor = page.getByRole("region", { name: "Unit details", exact: true });
  await editor.getByLabel("Whole install complete (all visits)").selectOption("Yes");
  await expect(editor.getByRole("button", { name: "Save and start", exact: true })).toHaveCount(0);
  await editor.getByRole("button", { name: "Save — install complete ✓", exact: true }).click();
  await expect.poll(() => data.units[0]?.facts.installation_complete).toBe("Yes");
  // No new visit was started, so nothing reopened it: still one session.
  expect(data.sessions.length).toBe(1);
});

test("a map unit keeps its identity when creating and joining custom work", async ({
  page,
}) => {
  test.setTimeout(60000);
  const { projectId, data } = await setupWork(page);
  const opening = openingsFor(projectId)[0];
  await page.route("**/rest/v1/project_openings**", (route) =>
    json(route, opening),
  );
  await page.goto(`/current-work?job=${projectId}&opening=${opening.id}`);
  await page
    .getByRole("button", { name: "Use this map unit", exact: true })
    .click();
  await expect(page.getByLabel("Unit number / name")).toHaveValue(
    opening.opening_code,
  );
  await page
    .getByRole("button", { name: "Start this unit", exact: true })
    .click();
  await expect.poll(() => data.units.length).toBe(1);
  expect(data.units[0].opening_id).toBe(opening.id);
  // Saving the unit and starting its timer are separate durable commands.
  // A full navigation must wait for the timer, not just the unit response.
  await expect.poll(() => data.sessions.length).toBe(1);
  await expect(
    page.getByRole("region", { name: "Current activity" }).getByRole("heading", {
      name: `Unit ${opening.opening_code}`,
      exact: true,
    }),
  ).toBeVisible();
  await page.goto(`/current-work?job=${projectId}&opening=${opening.id}`);
  await page
    .getByRole("button", { name: "Join as helper", exact: true })
    .click();
  await expect.poll(() => data.sessions.length).toBe(2);
  expect(data.units).toHaveLength(1);
  expect(data.sessions[1].participation).toBe("helper");
  expect(data.sessions[1].unit_id).toBe(data.units[0].id);
});

test("disconnected work survives reload and a refused retry remains recoverable", async ({
  page,
}) => {
  test.setTimeout(60000);
  const { data } = await setupWork(page);
  await page.goto("/current-work");
  await expect(
    page.getByRole("heading", { name: "Current Work", exact: true }),
  ).toBeVisible();
  data.offline = true;
  await page.getByRole("button", { name: "+ Start unit", exact: true }).click();
  await page.getByLabel("Unit number / name").fill("Offline 16");
  await page
    .getByRole("button", { name: "Start this unit", exact: true })
    .click();
  const active = page.getByRole("region", { name: "Current activity" });
  await expect(
    active.getByRole("heading", { name: "Unit Offline 16" }),
  ).toBeVisible();
  await expect(
    page.getByRole("complementary", { name: "Pending work" }),
  ).toContainText("2 work changes");
  await expect(
    page.getByRole("status", { name: /Custom work is saved on this device/ }),
  ).toContainText("queued");
  expect(data.sessions).toHaveLength(0);
  await page.reload();
  await expect(
    active.getByRole("heading", { name: "Unit Offline 16" }),
  ).toBeVisible();
  data.offline = false;
  data.refuse = true;
  await page.getByRole("button", { name: "Retry sync", exact: true }).click();
  await expect(
    page.getByRole("complementary", { name: "Pending work" }),
  ).toContainText("current work changed");
  await expect(
    page.getByRole("button", { name: "+ Start unit", exact: true }),
  ).toBeDisabled();
  const download = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "Export pending work", exact: true })
    .click();
  expect((await download).suggestedFilename()).toBe("forge-pending-work.json");
  data.refuse = false;
  await page.getByRole("button", { name: "Retry sync", exact: true }).click();
  await expect(
    page.getByRole("complementary", { name: "Pending work" }),
  ).toHaveCount(0);
  expect(data.units).toHaveLength(1);
  expect(data.sessions).toHaveLength(1);
});
