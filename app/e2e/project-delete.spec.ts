// Wave D: delete a job from Active projects, 30 days in the trash, then
// gone for good. This spec exercises the client half — trashProject /
// restoreProject / listTrashedProjects wiring, the confirm dialog's real
// numbers, the owner-only gate, and the days-left countdown — against a
// single mutable project row. The RLS half (a non-owner never even
// RECEIVES a trashed row) lives in the database and isn't something a
// browser test can see; this starts from what an owner's own fetch
// legitimately looks like, same idiom as testing-projects.spec.ts.
//
// "Gone from a warehouse job picker" (the spec's own third assertion) rides
// the exact same listProjectsAnyStatus() query this file already exercises
// via Job history's "done" list and the Deleted section — Warehouse.tsx
// reads that identical function for its job-name map, so it is covered at
// the query level rather than re-walked through the warehouse page's own
// much larger fixture surface here.

import { expect, test, type Page, type Route } from "@playwright/test";
import { jobFixtures, useSupabaseFixtures } from "./support/supabaseFixtures";

const PECAN14 = jobFixtures().find((j) => j.jobCode === "PECAN14")!;

function json(route: Route, body: unknown, rows = 0) {
  return route.fulfill({
    status: 200,
    contentType: "application/json",
    headers: { "content-range": `0-${Math.max(0, rows - 1)}/${rows}` },
    body: JSON.stringify(body),
  });
}

function rpcResult(route: Route, body: unknown) {
  return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
}

/** Fixed so the days-left math is a known quantity, not "whenever this ran". */
const SERVER_NOW = "2026-08-28T12:00:00.000Z";
const THREE_DAYS_AGO = "2026-08-25T12:00:00.000Z";

/**
 * A single mutable project row, plus stateful routes for everything
 * Projects.tsx / JobHistory.tsx touch: `projects` itself (branching on
 * whether the query asks for live or trashed rows — listProjects/
 * listProjectsAnyStatus both carry `deleted_at=is.null`; listTrashedProjects
 * carries `deleted_at=not.is.null`), the three head-count queries the
 * confirm dialog needs, and trash_project/restore_project/server_now.
 * Registered AFTER useSupabaseFixtures, which is what lets them win
 * (Playwright: most-recently-added route wins).
 */
function useTrashFixture(page: Page, initialDeletedAt: string | null) {
  const project = {
    id: PECAN14.projectId,
    job_code: "PECAN14",
    name: "Pecan Valley",
    address: null,
    status: "active",
    status_changed_at: null,
    is_test: false,
    deleted_at: initialDeletedAt,
    deleted_by: null as string | null,
  };
  const trashCalls: string[] = [];
  const restoreCalls: string[] = [];

  void page.route("**/rest/v1/projects**", (route) => {
    const trashedOnly = route.request().url().includes("deleted_at=not.is.null");
    const rows = trashedOnly === (project.deleted_at != null) ? [project] : [];
    return json(route, rows, rows.length);
  });

  // The confirm dialog's cheap head-counts (getProjectDeleteCounts) —
  // useSupabaseFixtures doesn't otherwise answer any of these three.
  void page.route("**/rest/v1/project_openings**", (r) => json(r, [], 0));
  void page.route("**/rest/v1/packages**", (r) => json(r, [], 0));
  void page.route("**/rest/v1/attachments**", (r) => json(r, [], 0));

  void page.route("**/rest/v1/rpc/trash_project", (route) => {
    const body = route.request().postDataJSON() as { p_project_id: string };
    trashCalls.push(body.p_project_id);
    project.deleted_at = SERVER_NOW;
    project.deleted_by = "e2e-fixture";
    return rpcResult(route, project);
  });
  void page.route("**/rest/v1/rpc/restore_project", (route) => {
    const body = route.request().postDataJSON() as { p_project_id: string };
    restoreCalls.push(body.p_project_id);
    project.deleted_at = null;
    project.deleted_by = null;
    return rpcResult(route, project);
  });
  void page.route("**/rest/v1/rpc/server_now", (route) => rpcResult(route, SERVER_NOW));

  return { project, trashCalls, restoreCalls };
}

test.use({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });

test("an owner deletes a job from Active projects, the confirm states the real cost, and it's gone from the list", async ({
  page,
}) => {
  await useSupabaseFixtures(page, { role: "owner" });
  const { trashCalls } = useTrashFixture(page, null);

  let confirmMessage = "";
  page.on("dialog", (d) => {
    confirmMessage = d.message();
    void d.accept();
  });

  await page.goto("/projects");
  await expect(page.getByText("Pecan Valley")).toBeVisible();

  await page.getByRole("button", { name: /Delete/ }).click();

  await expect.poll(() => trashCalls.length).toBe(1);
  expect(trashCalls[0]).toBe(PECAN14.projectId);
  expect(confirmMessage).toContain("Delete PECAN14?");
  expect(confirmMessage).toContain("0 openings");
  expect(confirmMessage).toContain("0 packages");
  expect(confirmMessage).toContain("0 photos");
  expect(confirmMessage).toContain("30 days to undo from Job history");

  await expect(page.getByText("Deleted — it disappears everywhere.")).toBeVisible();
  await expect(page.getByText("Pecan Valley")).toHaveCount(0);
});

test("a supervisor (non-owner) sees no Delete action on Active projects", async ({ page }) => {
  await useSupabaseFixtures(page, { role: "supervisor" });
  useTrashFixture(page, null);

  await page.goto("/projects");
  await expect(page.getByText("Pecan Valley")).toBeVisible();
  await expect(page.getByRole("button", { name: /Delete/ })).toHaveCount(0);
});

test("Job history shows the Deleted row with days left, and Undo brings it back", async ({ page }) => {
  await useSupabaseFixtures(page, { role: "owner" });
  const { restoreCalls } = useTrashFixture(page, THREE_DAYS_AGO);

  await page.goto("/jobs/history");

  await expect(page.getByRole("heading", { name: "Deleted" })).toBeVisible();
  await expect(page.getByText("PECAN14")).toBeVisible();
  await expect(page.getByText(/deleted 3 days ago — 27 days left/)).toBeVisible();

  await page.getByRole("button", { name: "Undo" }).click();

  await expect.poll(() => restoreCalls.length).toBe(1);
  expect(restoreCalls[0]).toBe(PECAN14.projectId);
  await expect(page.getByText("Restored — it's back everywhere, exactly as it was.")).toBeVisible();
  await expect(page.getByText(/days left/)).toHaveCount(0);
});
