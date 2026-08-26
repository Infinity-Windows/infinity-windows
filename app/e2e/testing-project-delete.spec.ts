// The owner-only delete flow (ProjectDetail.tsx:1070-1164, TestingProjectPanel):
// permanent, and reachable only once a job is already flagged `is_test` — a
// separate, reversible step that stands between "real job" and "gone". Same
// fixture idiom as testing-projects.spec.ts: override `projects` to mix a
// testing project into the fetch, registered after useSupabaseFixtures so it
// wins.
import { expect, test, type Page, type Route } from "@playwright/test";
import { jobFixtures, useSupabaseFixtures } from "./support/supabaseFixtures";

const BLACK22 = jobFixtures().find((j) => j.jobCode === "BLACK22")!;

const PROJECT = {
  id: BLACK22.projectId,
  job_code: "BLACK22",
  name: "Black Desert",
  address: null,
  status: "active",
  is_test: true,
};

function json(route: Route, body: unknown, rows = 0) {
  return route.fulfill({
    status: 200,
    contentType: "application/json",
    headers: { "content-range": `0-${Math.max(0, rows - 1)}/${rows}` },
    body: JSON.stringify(body),
  });
}

async function useTestingProjectFixture(page: Page) {
  await page.route("**/rest/v1/projects**", (r) => json(r, [PROJECT], 1));
}

test("an owner permanently deletes a flagged testing project", async ({
  page,
}) => {
  await useSupabaseFixtures(page, { role: "owner" });
  await useTestingProjectFixture(page);

  const deleteCalls: string[] = [];
  await page.route("**/rest/v1/rpc/delete_test_project", async (route) => {
    const body = route.request().postDataJSON() as { p_project: string };
    deleteCalls.push(body.p_project);
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: "null",
    });
  });
  page.on("dialog", (d) => void d.accept());

  await page.goto(`/projects/${BLACK22.projectId}`);
  // canDeleteTesting is isOwner(effectiveRole); canFlagTesting (which the
  // whole panel is gated on) is isSupervisorPlus — an owner clears both.
  await expect(page.getByRole("heading", { name: "Testing" })).toBeVisible();
  await expect(
    page.getByRole("button", { name: /Delete this testing project/ }),
  ).toBeVisible();

  await page
    .getByRole("button", { name: /Delete this testing project/ })
    .click();

  await expect.poll(() => deleteCalls.length).toBe(1);
  expect(deleteCalls[0]).toBe(BLACK22.projectId);

  // Navigate-away: delete's onSuccess sends the owner back to the job list —
  // there is no "still looking at the job that no longer exists" state.
  await expect(page).toHaveURL(/\/projects$/);
});

test("a supervisor sees the testing flag but never a delete button", async ({
  page,
}) => {
  // canFlagTesting is isSupervisorPlus (shows the panel and the checkbox);
  // canDeleteTesting is isOwner only — a supervisor is exactly the role that
  // proves those are two different gates, not one.
  await useSupabaseFixtures(page, { role: "supervisor" });
  await useTestingProjectFixture(page);

  await page.goto(`/projects/${BLACK22.projectId}`);
  await expect(page.getByRole("heading", { name: "Testing" })).toBeVisible();
  await expect(
    page.getByRole("button", { name: /Delete this testing project/ }),
  ).toHaveCount(0);
});
