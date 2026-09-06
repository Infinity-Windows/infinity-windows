// The unit card (warehouse redesign wave 1): one editor for a window's
// pieces. Driven through the real UI with fixture data; the asserts capture
// the actual RPC payloads the buttons send, the same way storage.spec.ts does.
import { expect, test, type Route } from "@playwright/test";
import { jobFixtures, useSupabaseFixtures } from "./support/supabaseFixtures";

const JOBS = jobFixtures();
const BLACK22 = JOBS.find((j) => j.jobCode === "BLACK22")!;
const PECAN14 = JOBS.find((j) => j.jobCode === "PECAN14")!;
const C1 = "00000000-0000-4000-8000-00000000c001";
const P = (n: number) => `00000000-0000-4000-8000-00000000a0${String(n).padStart(2, "0")}`;
const M1 = "00000000-0000-4000-8000-00000000f001";

function pkg(n: number, status: string, over: Record<string, unknown> = {}) {
  return {
    id: P(n), serial: `PKG-0000${String(n).padStart(2, "0")}`, short_code: `AB${n}CDE`,
    status, project_id: BLACK22.projectId, category: "windows", note: null, delivery_id: null,
    container_id: status === "stored" ? C1 : null, location_id: null, area: null,
    part_index: n, part_total: 3, part_type: ["frame", "glass", "hardware"][n - 1],
    bound_at: "2026-08-10T12:00:00Z", bound_by: "e2e", created_at: "2026-08-10T12:00:00Z",
    package_marks: [{ mark_code: "16" }],
    ...over,
  };
}

function json(route: Route, body: unknown, rows = 0) {
  return route.fulfill({
    status: 200, contentType: "application/json",
    headers: { "content-range": `0-${Math.max(0, rows - 1)}/${rows}` },
    body: JSON.stringify(body),
  });
}

test("moving one piece to another job sends reassign_package and offers Undo", async ({ page }) => {
  await useSupabaseFixtures(page, { role: "installer" });
  const rows = [pkg(1, "stored"), pkg(2, "received"), pkg(3, "minted")];
  await page.route("**/rest/v1/packages**", (r) => json(r, rows, rows.length));
  await page.route("**/rest/v1/storage_containers**", (r) =>
    json(r, [{ id: C1, serial: "CTR-000001", name: "Conex 7", kind: "conex", active: true, address: null, access_code: null, notes: null, created_at: "2026-08-01T00:00:00Z" }], 1),
  );
  await page.route("**/rest/v1/movements**", (r) =>
    json(r, [{ id: M1, package_id: P(1), event: "stored", reason: "stored in Conex 7", actor: "e2e", created_at: "2026-09-06T10:00:00Z", undoes: null, from_container_id: null, to_container_id: C1 }], 1),
  );
  const calls: { fn: string; body: unknown }[] = [];
  await page.route("**/rest/v1/rpc/reassign_package", (r) => {
    calls.push({ fn: "reassign_package", body: r.request().postDataJSON() });
    return json(r, "00000000-0000-4000-8000-00000000f002");
  });
  await page.route("**/rest/v1/rpc/undo_movement", (r) => {
    calls.push({ fn: "undo_movement", body: r.request().postDataJSON() });
    return json(r, "00000000-0000-4000-8000-00000000f003");
  });

  await page.goto(`/unit/${BLACK22.projectId}/16`);
  await expect(page.getByRole("heading", { name: "Window 16" })).toBeVisible();
  await expect(page.getByText("2 of 3 here")).toBeVisible();

  // Tap piece 2, move it to PECAN14 as window 4.
  await page.getByRole("listitem").filter({ hasText: "2/3" }).click();
  await page.getByRole("button", { name: "To another job…" }).click();
  await page.getByLabel("Job").selectOption(PECAN14.projectId);
  await page.getByLabel("Window number").fill("4");
  await expect(page.getByText(/Moving to a different job/)).toBeVisible();
  await page.getByRole("button", { name: "Move", exact: true }).click();

  await expect.poll(() => calls.length).toBe(1);
  expect(calls[0].body).toEqual({
    p_package: P(2), p_project: PECAN14.projectId, p_mark: "4", p_reason: null,
  });

  // The toast's Undo writes the opposite line.
  await page.getByRole("button", { name: "Undo" }).first().click();
  await expect.poll(() => calls.filter((c) => c.fn === "undo_movement").length).toBe(1);
  expect(calls[1].body).toEqual({ p_movement: "00000000-0000-4000-8000-00000000f002" });
});

test("the history offers Undo on your own line and explains why not on others", async ({ page }) => {
  await useSupabaseFixtures(page, { role: "installer" });
  const rows = [pkg(1, "stored")];
  await page.route("**/rest/v1/packages**", (r) => json(r, rows, 1));
  await page.route("**/rest/v1/storage_containers**", (r) => json(r, [], 0));
  await page.route("**/rest/v1/movements**", (r) =>
    json(r, [
      { id: M1, package_id: P(1), event: "stored", reason: "stored in Conex 7", actor: "somebody-else", created_at: new Date().toISOString(), undoes: null },
    ], 1),
  );
  await page.goto(`/unit/${BLACK22.projectId}/16`);
  await expect(page.getByText("stored in Conex 7")).toBeVisible();
  // An installer cannot undo somebody else's line: no button, a reason on hover.
  await expect(page.getByRole("button", { name: "Undo" })).toHaveCount(0);
  await expect(page.locator(".unit-why[title*='foreman']")).toHaveCount(1);
});
