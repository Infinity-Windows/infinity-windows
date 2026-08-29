// Wave R — "Rewrite this set" (owner grill 2026-08-28, the Mad Moose
// story): a manifest said mark #8 was 16 packages; the truck actually had
// 12 pieces of glass in one crate plus 4 frame packages. This covers the
// two doors into the one editor (DeliveryDetail's "Edit set…" navigates
// here) and the marquee flow itself — declaring the Mad Moose truth and
// hitting "Make it match."
import { expect, test, type Route } from "@playwright/test";
import { useSupabaseFixtures } from "./support/supabaseFixtures";

const D = "00000000-0000-4000-8000-00000000de33";
const JOB_NAME = "Mad Moose";

function pkg(over: Record<string, unknown>) {
  return {
    id: "pkg-x",
    status: "minted",
    project_id: null,
    pending_job_name: JOB_NAME,
    mfr_mark: "8",
    part_index: 1,
    part_total: 16,
    part_type: null as string | null,
    piece_count: null as number | null,
    container_id: null,
    delivery_id: D,
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

test("DeliveryDetail's Edit set… navigates to Rewrite this set", async ({ page }) => {
  await useSupabaseFixtures(page, { role: "foreman" });

  const rows = [pkg({ id: "p1" })];
  await page.route(
    (url) =>
      url.pathname.includes("/rest/v1/packages") &&
      (url.searchParams.get("delivery_id") ?? "").startsWith("eq."),
    (route) => json(route, rows, rows.length),
  );
  await page.route("**/rest/v1/storage_containers**", (route) => json(route, [], 0));
  await page.route("**/rest/v1/package_deliveries**", (route) =>
    json(route, [{ id: D, label: "Mad Moose truck", arrived_on: "2026-08-25" }], 1),
  );

  await page.goto(`/storage/d/${D}`);
  await expect(page.getByText("Mad Moose · #8 — 1/16", { exact: true })).toBeVisible();

  const editLink = page.getByRole("link", { name: "Edit set #8" });
  await expect(editLink).toHaveAttribute(
    "href",
    `/storage/rewrite-set?pending=${encodeURIComponent(JOB_NAME)}&mark=8`,
  );
  await editLink.click();
  await expect(page).toHaveURL(new RegExp(`/storage/rewrite-set\\?pending=Mad%20Moose&mark=8`));
  await expect(page.getByRole("heading", { name: "The set, declared" })).toBeVisible();
});

test("Make it match on a seeded set: the manifest's 16 untyped packages become 4 frame + 12 pieces of glass", async ({
  page,
}) => {
  await useSupabaseFixtures(page, { role: "foreman" });

  // The manifest's truth: 16 identical untyped packages, all still on the
  // way — exactly what a hand-logged delivery mints before anyone at the
  // truck has read a single box.
  const rows = Array.from({ length: 16 }, (_, i) =>
    pkg({ id: `p${i + 1}`, part_index: i + 1 }),
  );
  await page.route(
    (url) => url.pathname.includes("/rest/v1/packages"),
    (route) => json(route, rows, rows.length),
  );
  await page.route("**/rest/v1/part_type_options**", (route) => json(route, [], 0));
  await page.route("**/rest/v1/projects**", (route) => json(route, [], 0));

  let rpcBody: { p_project_id: string | null; p_pending_job_name: string | null; p_mark: string; p_lines: unknown[]; p_kind: string } | null =
    null;
  await page.route("**/rest/v1/rpc/rewrite_set", async (route) => {
    rpcBody = route.request().postDataJSON();
    await json(route, { minted: 16, deleted: 16 });
  });

  await page.goto(
    `/storage/rewrite-set?pending=${encodeURIComponent(JOB_NAME)}&mark=8`,
  );

  await expect(page.getByRole("heading", { name: "The set, declared" })).toBeVisible();
  // The declaration seeds from reality: one line, 16, untyped, 0 arrived.
  await expect(page.getByLabel("How many on line 1")).toHaveValue("16");
  await expect(page.getByText("untyped — 0 of 16 arrived")).toBeVisible();

  // Retype line 1 to frame, shrink it to 4 — the truth was 4 frame packages.
  await page.getByLabel("What is line 1").selectOption("frame");
  await page.getByLabel("How many on line 1").fill("4");

  // Add a second line: 12 pieces of glass, riding in the crate.
  await page.getByRole("button", { name: "+ add line" }).click();
  await page.getByLabel("What is line 2").selectOption("glass");
  await page.getByLabel("Pieces in a crate, line 2").click();
  await page.getByLabel("How many on line 2").fill("12");

  await page.getByRole("button", { name: "Make it match" }).click();

  await expect(page.getByText("Matched: 16 minted, 16 released.")).toBeVisible();
  expect(rpcBody).not.toBeNull();
  expect(rpcBody!.p_mark).toBe("8");
  expect(rpcBody!.p_pending_job_name).toBe(JOB_NAME);
  expect(rpcBody!.p_project_id).toBeNull();
  expect(rpcBody!.p_lines).toEqual([
    { part_type: "frame", packaging: "package", count: 4 },
    { part_type: "glass", packaging: "crate_pool", count: 12 },
  ]);
});

test("a shrink below what's arrived refuses client-side, in the server's own words, before any call goes out", async ({
  page,
}) => {
  await useSupabaseFixtures(page, { role: "foreman" });

  const rows = [
    pkg({ id: "a1", status: "received", part_type: "frame", part_total: 6 }),
    pkg({ id: "a2", status: "received", part_index: 2, part_type: "frame", part_total: 6 }),
  ];
  await page.route(
    (url) => url.pathname.includes("/rest/v1/packages"),
    (route) => json(route, rows, rows.length),
  );
  await page.route("**/rest/v1/part_type_options**", (route) => json(route, [], 0));
  await page.route("**/rest/v1/projects**", (route) => json(route, [], 0));

  let rpcCalled = false;
  await page.route("**/rest/v1/rpc/rewrite_set", async (route) => {
    rpcCalled = true;
    await json(route, { minted: 0, deleted: 0 });
  });

  await page.goto(`/storage/rewrite-set?pending=${encodeURIComponent(JOB_NAME)}&mark=8`);
  await expect(page.getByLabel("How many on line 1")).toHaveValue("2");

  await page.getByLabel("How many on line 1").fill("1");
  await page.getByRole("button", { name: "Make it match" }).click();

  await expect(
    page.getByText(
      "2 frame already arrived — the new plan only holds 1. Un-arrive or delete pieces first, so nothing real disappears.",
    ),
  ).toBeVisible();
  expect(rpcCalled).toBe(false);
});
