// A whole job to the job site (owner ask 2026-09-06): the review screen
// lists what is here by unit, one untick keeps a unit back, and the move is
// the same check-out every screen uses — proven by the RPC payload.
import { expect, test, type Page } from "@playwright/test";
import { jobFixtures, useSupabaseFixtures } from "./support/supabaseFixtures";
import { json } from "./support/specHelpers";

const JOBS = jobFixtures();
const PECAN14 = JOBS.find((j) => j.jobCode === "PECAN14")!;
const C1 = "00000000-0000-4000-8000-00000000c001";

const CONTAINERS = [
  { id: C1, serial: "CTR-000001", name: "Conex 7", address: null, access_code: null, notes: null, active: true, kind: "conex", created_at: "2026-08-01T00:00:00Z" },
];
function pkg(id: string, serial: string, code: string, mark: string, over: Record<string, unknown> = {}) {
  return {
    id, serial, short_code: code, status: "stored", project_id: PECAN14.projectId, pending_job_name: null,
    mfr_mark: null, category: "windows", note: null, area: null, part_index: null, part_total: null,
    part_type: null, piece_count: null, delivery_id: null, container_id: C1, location_id: null,
    bound_at: "2026-08-10T12:00:00Z", bound_by: "e2e", created_at: "2026-08-10T12:00:00Z",
    package_marks: [{ mark_code: mark }], ...over,
  };
}
const ALL = [
  pkg("pkg-a", "PKG-000003", "CDEFGH", "4"),
  pkg("pkg-b", "PKG-000004", "DEFGHJ", "4"),
  pkg("pkg-c", "PKG-000005", "EFGHJK", "7", { status: "received", container_id: null }),
];

async function useSendFixtures(page: Page) {
  const calls: { fn: string; body: unknown }[] = [];
  await page.route("**/rest/v1/storage_containers**", (r) => json(r, CONTAINERS, CONTAINERS.length));
  await page.route("**/rest/v1/packages**", (r) => json(r, ALL, ALL.length));
  await page.route("**/rest/v1/rpc/checkout_packages", (r) => {
    calls.push({ fn: "checkout_packages", body: r.request().postDataJSON() });
    return json(r, 2);
  });
  return calls;
}

test.use({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });

test("an installer sends a job to site, keeping one unit back", async ({ page }) => {
  await useSupabaseFixtures(page, { role: "installer" });
  const calls = await useSendFixtures(page);
  await page.goto(`/warehouse/send/${PECAN14.projectId}`);
  await expect(page.getByRole("heading", { name: "PECAN14 → job site" })).toBeVisible();
  await expect(page.getByText("Move 2 units (3 pieces) to the job site")).toBeVisible();
  await page.getByLabel("Window 7 goes to the job site").click();
  await expect(page.getByText("Move 1 unit (2 pieces) to the job site · 1 stays")).toBeVisible();
  await page.getByRole("button", { name: "Move to job site" }).click();
  await expect.poll(() => calls.length).toBe(1);
  expect(calls[0].body).toEqual({
    p_packages: ["pkg-a", "pkg-b"],
    p_reason: "Sent to job site",
    p_project: PECAN14.projectId,
  });
  // Finalizing is a lead's tap, and the leftover rule says why it waits.
  const finalize = page.getByRole("button", { name: "Unit Movement Finalized" });
  await expect(finalize).toBeDisabled();
  await expect(page.getByText("A foreman or above finalizes a job.")).toBeVisible();
});
