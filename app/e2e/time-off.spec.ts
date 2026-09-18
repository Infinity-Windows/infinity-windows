import { expect, test, type Page } from "@playwright/test";
import { useSupabaseFixtures as setupSupabaseFixtures, TEST_USER } from "./support/supabaseFixtures";
import { json, dayISO, hideWrongProjectBanner } from "./support/specHelpers";
import type { TimeOffRequest } from "../src/lib/timeOff/model";
async function fixtures(
  page: Page,
  role: "installer" | "supervisor" = "installer",
  language: "en" | "es" = "en",
) {
  await setupSupabaseFixtures(page, { role, language });
  await hideWrongProjectBanner(page);
  const requests: TimeOffRequest[] = [];
  const row = (
    id: string,
    kind: "sick" | "vacation" | "other",
    start: string,
    end: string,
    status: TimeOffRequest["status"],
  ): TimeOffRequest => ({
    id,
    kind,
    start_date: start,
    end_date: end,
    status,
    profile_id: TEST_USER.id,
    created_at: new Date().toISOString(),
    reviewed_at: null,
    reviewed_by: null,
    profiles: { display_name: "E2E Fixture" },
  });
  await page.route("**/rest/v1/time_off_requests**", (r) =>
    json(r, requests, requests.length),
  );
  await page.route("**/rest/v1/rpc/request_time_off", (r) => {
    const b = r.request().postDataJSON();
    requests.push(
      row(
        b.p_id,
        b.p_kind,
        b.p_start,
        b.p_end,
        b.p_kind === "sick" ? "approved" : "pending",
      ),
    );
    return json(r, b.p_id);
  });
  await page.route("**/rest/v1/rpc/review_time_off", (r) => {
    const b = r.request().postDataJSON();
    const found = requests.find((x) => x.id === b.p_id);
    if (found) found.status = b.p_status;
    return json(r, null);
  });
  await page.route("**/rest/v1/time_shifts**", (r) => json(r, [], 0));
  return { requests, row };
}
test("installer reports sick today, requests a date range, and sees distinct day counts on phone", async ({
  page,
}) => {
  const { requests } = await fixtures(page);
  await page.goto("/my-schedule");
  await page.getByRole("button", { name: "Sick today", exact: true }).click();
  await expect(page.getByLabel("First day")).toHaveValue(dayISO(0));
  await page
    .getByRole("button", { name: "Report sick day(s)", exact: true })
    .click();
  await expect(page.locator(".time-off-success")).toContainText(
    "Sick days recorded",
  );
  expect(requests[0].status).toBe("approved");
  await expect(page.locator(".time-off-counts strong").first()).toHaveText("1");
  await page.getByRole("button", { name: "Add time off", exact: true }).click();
  await page.getByLabel("Reason").selectOption("vacation");
  await page.getByLabel("First day").fill(dayISO(10));
  await page.getByLabel("Last day").fill(dayISO(12));
  await expect(page.locator(".time-off-form")).toContainText("3 calendar days");
  await page
    .getByRole("button", { name: "Request time off", exact: true })
    .click();
  await expect(page.locator(".time-off-success")).toContainText(
    "Waiting for supervisor approval",
  );
  expect(requests[1].status).toBe("pending");
  await expect(page.locator(".time-off-counts strong").nth(1)).toHaveText("0");
  await expect(
    page.getByRole("button", { name: "Approve", exact: true }),
  ).toHaveCount(0);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "e2e/__screenshots__/time-off-phone.png",
    fullPage: true,
  });
});
test("supervisor reviews leave on the desktop schedule and cancellations restore counts", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const { requests, row } = await fixtures(page, "supervisor");
  requests.push(
    row(
      "10000000-0000-4000-8000-000000000001",
      "vacation",
      dayISO(1),
      dayISO(3),
      "pending",
    ),
  );
  await page.goto("/scheduling");
  const panel = page.locator(".time-off");
  await panel
    .getByText("View requests and day counts", { exact: true })
    .click();
  await panel.getByRole("button", { name: "Approve", exact: true }).click();
  await expect(
    panel.getByText("3 future days approved", { exact: true }),
  ).toBeVisible();
  expect(requests[0].status).toBe("approved");
  await panel.getByText("Requests & history", { exact: true }).click();
  await panel.getByRole("button", { name: "Cancel entry" }).click();
  await expect(panel.getByText("Canceled", { exact: true })).toBeVisible();
  await expect(
    panel.getByText("3 future days approved", { exact: true }),
  ).toHaveCount(0);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "e2e/__screenshots__/time-off-desktop.png",
    fullPage: true,
  });
});
test("lunch reminder appears after 30 minutes and opens the existing break controls", async ({
  page,
}) => {
  await fixtures(page);
  const shift = {
    id: "20000000-0000-4000-8000-000000000001",
    profile_id: TEST_USER.id,
    project_id: null,
    cost_code_id: null,
    clock_in_at: new Date(Date.now() - 5 * 3600000).toISOString(),
    clock_out_at: null,
    status: "open",
    created_at: new Date().toISOString(),
    break_seconds: 0,
    break_started_at: new Date(Date.now() - 30 * 60000 - 1000).toISOString(),
    break_type: "lunch",
    injured: null,
    time_confirmed: null,
  };
  await page.route("**/rest/v1/time_shifts**", (r) => json(r, [shift], 1));
  await page.goto("/my-schedule");
  await expect(page.locator(".lunch-reminder")).toContainText(
    "Your 30-minute lunch is up",
  );
  await page
    .getByRole("button", { name: "Open my clock", exact: true })
    .click();
  await expect(page.locator(".clock-sheet")).toBeVisible();
});
test("Spanish time-off form remains usable at phone width", async ({
  page,
}) => {
  await fixtures(page, "installer", "es");
  await page.addInitScript(() =>
    localStorage.setItem("infinity.language", "es"),
  );
  await page.goto("/my-schedule");
  // The app's language switch persists to the same key used by the existing specs.
  const button = page.getByRole("button", { name: "Enfermo hoy", exact: true });
  await expect(button).toBeVisible();
  await button.click();
  await expect(page.getByLabel("Primer día")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Reportar enfermedad", exact: true }),
  ).toBeVisible();
});

test("a sick day removes today's assignment but keeps tomorrow's job", async ({
  page,
}) => {
  await fixtures(page);
  const job = "ebf64f94-0413-4434-aeb3-1aff228fb5b3";
  const assignment = "30000000-0000-4000-8000-000000000001";
  await page.route("**/rest/v1/schedule_assignment_members**", (r) =>
    json(r, [{ assignment_id: assignment }], 1),
  );
  await page.route("**/rest/v1/schedule_assignments**", (r) =>
    json(
      r,
      [
        {
          id: assignment,
          project_id: job,
          start_date: dayISO(0),
          end_date: dayISO(1),
          start_time: "07:00",
          status: "published",
          schedule_assignment_members: [
            { profile_id: TEST_USER.id, role: "installer" },
          ],
          projects: {
            id: job,
            job_code: "FIXTURE",
            name: "Morning install",
            address: null,
          },
        },
      ],
      1,
    ),
  );
  await page.goto("/my-schedule");
  await expect(page.locator(".sched-agenda-card")).toHaveCount(2);
  await page.getByRole("button", { name: "Sick today", exact: true }).click();
  await page
    .getByRole("button", { name: "Report sick day(s)", exact: true })
    .click();
  await expect(page.locator(".sched-agenda-card")).toHaveCount(1);
  await expect(page.locator(".time-off-away")).toContainText("Sick");
  await page.getByRole("button", { name: "Cancel entry", exact: true }).click();
  await expect(page.locator(".sched-agenda-card")).toHaveCount(2);
});
