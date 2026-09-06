// The tailgate, unit first (wave 4): tap a unit and all its expected pieces
// arrive; one button puts everything that arrived into the box used last.
// Fixture-driven; the asserts capture the real RPC payloads.
import { expect, test, type Route } from "@playwright/test";
import { useSupabaseFixtures } from "./support/supabaseFixtures";

const D = "00000000-0000-4000-8000-00000000de11";
const C1 = "00000000-0000-4000-8000-00000000c001";
const C2 = "00000000-0000-4000-8000-00000000c002";

function twin(id: string, status: string, over: Record<string, unknown> = {}) {
  return {
    id, status, project_id: null, pending_job_name: "Sunset Ridge 4", mfr_mark: "5050",
    part_index: 1, part_total: 1, part_type: null as string | null, piece_count: null,
    container_id: null, delivery_id: D, serial: `PKG-${id}`, short_code: id,
    bound_at: "2026-08-25T12:00:00Z", package_marks: [], ...over,
  };
}
function json(route: Route, body: unknown, rows = 0) {
  return route.fulfill({
    status: 200, contentType: "application/json",
    headers: { "content-range": `0-${Math.max(0, rows - 1)}/${rows}` },
    body: JSON.stringify(body),
  });
}

test("tap a unit to arrive its pieces, then put everything away in one tap", async ({ page }) => {
  await useSupabaseFixtures(page, { role: "installer" });
  const rows = [
    twin("a1", "minted"), twin("a2", "minted"), twin("a3", "minted"),
    twin("b1", "minted", { mfr_mark: "8", part_index: 1, part_total: 2, part_type: "frame" }),
    twin("b2", "minted", { mfr_mark: "8", part_index: 2, part_total: 2, part_type: "glass" }),
  ];
  await page.route(
    (url) => url.pathname.includes("/rest/v1/packages") && (url.searchParams.get("delivery_id") ?? "").startsWith("eq."),
    (r) => json(r, rows, rows.length),
  );
  await page.route("**/rest/v1/packages**", (r) => json(r, rows, rows.length));
  await page.route("**/rest/v1/storage_containers**", (r) =>
    json(r, [
      { id: C1, name: "Conex 1", kind: "conex", active: true, serial: "CTR-000001" },
      { id: C2, name: "Conex 2", kind: "conex", active: true, serial: "CTR-000002" },
    ], 2),
  );
  await page.route("**/rest/v1/package_deliveries**", (r) => json(r, [{ id: D, label: "Test truck", arrived_on: "2026-08-25" }], 1));
  const calls: { fn: string; body: unknown }[] = [];
  await page.route("**/rest/v1/rpc/receive_minted_packages", async (r) => {
    const body = r.request().postDataJSON() as { p_packages: string[] };
    calls.push({ fn: "receive_minted_packages", body });
    for (const x of rows) if (body.p_packages.includes(x.id)) x.status = "received";
    await json(r, body.p_packages.length);
  });
  await page.route("**/rest/v1/rpc/store_packages", async (r) => {
    const body = r.request().postDataJSON() as { p_packages: string[]; p_container: string };
    calls.push({ fn: "store_packages", body });
    for (const x of rows) if (body.p_packages.includes(x.id)) { x.status = "stored"; x.container_id = body.p_container; }
    await json(r, body.p_packages.length);
  });

  await page.goto(`/storage/d/${D}`);
  await expect(page.getByText("0 of 5 arrived · 5 still missing")).toBeVisible();

  // One row for the three identical 5050s, one for #8's two pieces.
  await expect(page.getByRole("button", { name: /Arrive Sunset Ridge 4 · #5050, 3 expected/ })).toBeVisible();
  await page.getByRole("button", { name: /Arrive Sunset Ridge 4 · #8, 2 expected/ }).click();
  await expect.poll(() => calls.length).toBe(1);
  expect(new Set((calls[0].body as { p_packages: string[] }).p_packages)).toEqual(new Set(["b1", "b2"]));

  // Now two are loose: the bar asks which box the first time.
  await expect(page.getByText("Which box do the 2 go in?")).toBeVisible();
  await page.getByRole("button", { name: /Conex 2/ }).first().click();
  await expect.poll(() => calls.filter((c) => c.fn === "store_packages").length).toBe(1);
  const stored = calls.find((c) => c.fn === "store_packages")!.body as { p_packages: string[]; p_container: string };
  expect(stored.p_container).toBe(C2);
  expect(new Set(stored.p_packages)).toEqual(new Set(["b1", "b2"]));

  // Arrive the twins: the bar now remembers Conex 2.
  await page.getByRole("button", { name: /Arrive Sunset Ridge 4 · #5050, 3 expected/ }).click();
  await expect.poll(() => calls.filter((c) => c.fn === "receive_minted_packages").length).toBe(2);
  await expect(page.getByRole("button", { name: "Put 3 away → Conex 2" })).toBeVisible();
});
