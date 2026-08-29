// Wave M — the ledger becomes a workbench (owner ask, 2026-08-28): the
// per-job materials ledger used to be ?job=<projectId>-only, so a WAITING
// job (pending_job_name, no project row yet) could never be shown at all —
// even though the owner's whole live inventory is waiting-job material.
// This covers the two things that changed: the ledger now shows a waiting
// job's material, and the hub's tally card links a waiting-job row out to
// it.
//
// Wave R: the set-level "Edit…" used to open the shared set editor inline
// (#433) — it now navigates to /storage/rewrite-set instead (one editor,
// reachable from both doors). That flow's own coverage lives in
// rewrite-set.spec.ts; this file only asserts the navigation itself.
import { expect, test, type Route } from "@playwright/test";
import { useSupabaseFixtures } from "./support/supabaseFixtures";

const JOB_NAME = "Sunset Ridge 4";
const D = "00000000-0000-4000-8000-00000000de22";

function pkg(over: Record<string, unknown>) {
  return {
    id: "pkg-x",
    status: "received",
    project_id: null,
    pending_job_name: JOB_NAME,
    mfr_mark: "5050",
    part_index: 1,
    part_total: 2,
    part_type: null as string | null,
    piece_count: null as number | null,
    container_id: null,
    delivery_id: null as string | null,
    category: "windows",
    serial: "PKG-000X",
    short_code: "X1",
    bound_at: "2026-08-25T12:00:00Z",
    bound_by: "e2e",
    created_at: "2026-08-25T12:00:00Z",
    package_marks: [] as { mark_code: string }[],
    ...over,
  };
}

function json(route: Route, body: unknown, rows = 0) {
  return route.fulfill({
    status: 200,
    contentType: "application/json",
    headers: { "content-range": `0-${Math.max(0, rows - 1)}/${rows}` },
    body: JSON.stringify(body),
  });
}

test("the ledger shows a waiting job's material, and set-level Edit… navigates to Rewrite this set", async ({
  page,
}) => {
  await useSupabaseFixtures(page, { role: "foreman" });

  const rows = [
    pkg({ id: "p1", status: "received", part_index: 1 }),
    // Still on the truck — this is the "N still coming" half of the story.
    pkg({ id: "p2", status: "minted", part_index: 2, delivery_id: D }),
  ];
  await page.route(
    (url) => url.pathname.includes("/rest/v1/packages"),
    (route) => json(route, rows, rows.length),
  );
  await page.route("**/rest/v1/package_deliveries**", (route) =>
    json(
      route,
      [{ id: D, label: "Aug 25 truck", arrived_on: "2026-08-25" }],
      1,
    ),
  );
  await page.route("**/rest/v1/storage_containers**", (route) => json(route, [], 0));

  await page.goto(`/warehouse/materials?pending=${encodeURIComponent(JOB_NAME)}`);

  // The waiting job's material renders under its quoted name — the picker
  // reads it as one of the union scope's two halves.
  await expect(page.getByText(`“${JOB_NAME}” #5050`)).toBeVisible();
  await expect(page.getByText("1 still coming", { exact: false })).toBeVisible();
  await expect(page.getByRole("link", { name: "Aug 25 truck" })).toHaveAttribute(
    "href",
    `/storage/d/${D}`,
  );

  // Wave R: set-level Edit… navigates to Rewrite this set — one editor,
  // reachable from both doors — instead of opening an inline editor here.
  await expect(page.getByRole("link", { name: "Edit set #5050" })).toHaveAttribute(
    "href",
    `/storage/rewrite-set?pending=${encodeURIComponent(JOB_NAME)}&mark=5050`,
  );
});

test("the hub's tally card links a waiting job's row to ?pending=", async ({ page }) => {
  await useSupabaseFixtures(page, { role: "foreman" });

  const rows = [pkg({ id: "p1", status: "received" })];
  await page.route(
    (url) => url.pathname.includes("/rest/v1/packages"),
    (route) => json(route, rows, rows.length),
  );
  await page.route("**/rest/v1/storage_containers**", (route) => json(route, [], 0));
  await page.route("**/rest/v1/package_deliveries**", (route) => json(route, [], 0));

  await page.goto("/warehouse");

  await expect(page.getByText("Jobs with material")).toBeVisible();
  const link = page.getByRole("link", { name: `“${JOB_NAME}”` });
  await expect(link).toHaveAttribute(
    "href",
    `/warehouse/materials?pending=${encodeURIComponent(JOB_NAME)}`,
  );
});
