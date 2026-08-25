// Testing projects (owner-confirmed 2026-08-25): a job flagged is_test is
// fake data for practice or QA. A supervisor can still see it — that's what
// makes flagging and unflagging possible — but its material must never read
// as real inventory on the warehouse page. This is the client half of that
// promise: the RLS half (installers/foremen never receive the row at all)
// lives in the database and isn't something a browser test can see, so this
// spec starts from what a supervisor's `projects` fetch legitimately looks
// like — one testing project mixed in with a real one — and checks the page
// draws the line correctly from there.

import { expect, test, type Page, type Route } from "@playwright/test";
import { jobFixtures, useSupabaseFixtures } from "./support/supabaseFixtures";

const JOBS = jobFixtures();
const BLACK22 = JOBS.find((j) => j.jobCode === "BLACK22")!;
const PECAN14 = JOBS.find((j) => j.jobCode === "PECAN14")!;

const PROJECTS = [
  {
    id: PECAN14.projectId,
    job_code: "PECAN14",
    name: "Pecan Valley",
    address: null,
    status: "active",
    is_test: false,
  },
  {
    id: BLACK22.projectId,
    job_code: "BLACK22",
    name: "Black Desert",
    address: null,
    status: "active",
    is_test: true,
  },
];

function pkg(
  n: number,
  projectId: string,
  status = "received",
) {
  return {
    id: `00000000-0000-4000-8000-00000000b0${String(n).padStart(2, "0")}`,
    serial: `PKG-0001${String(n).padStart(2, "0")}`,
    short_code: null,
    status,
    project_id: projectId,
    category: "windows",
    note: null,
    delivery_id: null,
    container_id: null,
    location_id: null,
    bound_at: "2026-08-20T12:00:00Z",
    bound_by: "e2e",
    created_at: "2026-08-20T12:00:00Z",
    package_marks: [],
  };
}

// Two real PECAN14 packages, three fake BLACK22 ones — different counts on
// purpose, so a test that accidentally compares "real" against "everything"
// instead of against "just PECAN14" fails loudly rather than by coincidence.
const PACKAGES = [
  pkg(1, PECAN14.projectId),
  pkg(2, PECAN14.projectId),
  pkg(3, BLACK22.projectId),
  pkg(4, BLACK22.projectId),
  pkg(5, BLACK22.projectId),
];

function json(route: Route, body: unknown, rows = 0) {
  return route.fulfill({
    status: 200,
    contentType: "application/json",
    headers: { "content-range": `0-${Math.max(0, rows - 1)}/${rows}` },
    body: JSON.stringify(body),
  });
}

/**
 * Overrides `projects` (to mix a testing project into a supervisor's list)
 * and `packages` (which useSupabaseFixtures doesn't otherwise answer).
 * Registered AFTER useSupabaseFixtures, which is what lets them win —
 * Playwright gives priority to the most-recently-added route.
 */
async function useTestingProjectFixtures(page: Page) {
  await page.route("**/rest/v1/projects**", (r) => json(r, PROJECTS, PROJECTS.length));
  await page.route("**/rest/v1/packages**", (r) => json(r, PACKAGES, PACKAGES.length));
}

test.use({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });

test("a supervisor sees testing material set apart from real on-hand counts", async ({
  page,
}) => {
  await useSupabaseFixtures(page, { role: "supervisor" });
  await useTestingProjectFixtures(page);
  await page.goto("/warehouse");

  // The on-hand card counts PECAN14's two packages only — BLACK22's three
  // testing packages never show up as real inventory.
  const onHand = page.locator(".stat-card", { hasText: "on hand" });
  await expect(onHand.locator(".stat-num")).toHaveText("2");

  // The Testing section names the job and its package count, so the
  // material that came out of the count above is still findable somewhere.
  await expect(page.getByRole("heading", { name: "Testing" })).toBeVisible();
  await expect(page.getByText(/BLACK22/)).toBeVisible();
  await expect(page.getByText(/3 packages.*practice material/)).toBeVisible();
});

test("an installer's warehouse page never shows a Testing section", async ({
  page,
}) => {
  // Fixture stand-in for what RLS guarantees for real: an installer's own
  // `projects` fetch would never include a test project in the first place.
  // What this test actually exercises is the CLIENT gate — the section is
  // supervisor+ regardless of what happens to be in `projects.data` — since
  // an installer role reaching this page with a test project already in the
  // response (however that happened) must still never be shown the section.
  await useSupabaseFixtures(page, { role: "installer" });
  await useTestingProjectFixtures(page);
  await page.goto("/warehouse");

  await expect(page.getByText("Where is it")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Testing" })).toHaveCount(0);
});
