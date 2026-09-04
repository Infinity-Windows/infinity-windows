// Warehouse actions are crew actions (ADR-0007, owner call 2026-09-04).
//
// Everything here is driven as an INSTALLER, because that is the whole point
// of the decision: the person at the tailgate, the person who carried the
// crate into the conex, the person who drove to the yard for one more tube of
// caulk. The first half proves the doors that opened; the second proves the
// ones that did not, and proves it twice — the button is not on screen, and
// the RPC behind it is never called. That second half includes the two doors
// that end something without an RPC saying so: retiring a rack slot, which is
// a plain table write, and the Undo on a custom check-in, which is
// delete_packages wearing a friendlier name.
//
// Where a rule has two sides, the foreman side is its OWN test rather than a
// second act inside the installer's. Re-seeding the sign-in fixtures mid-test
// registers fresher routes that shadow the warehouse ones, and the page then
// reads an empty warehouse and fails for a reason that has nothing to do with
// the rule under test.
import { expect, test, type Page, type Route } from "@playwright/test";
import { jobFixtures, useSupabaseFixtures } from "./support/supabaseFixtures";

const JOBS = jobFixtures();
const BLACK22 = JOBS.find((j) => j.jobCode === "BLACK22")!;
const PECAN14 = JOBS.find((j) => j.jobCode === "PECAN14")!;

const C1 = "00000000-0000-4000-8000-00000000c001";
const D1 = "00000000-0000-4000-8000-00000000d001";
const SUPPLY = "00000000-0000-4000-8000-0000000005a1";
const SLOT = "00000000-0000-4000-8000-000000005101";

/** Two rack slots, so /labels has something to print and something to retire. */
const SLOTS = [
  {
    id: SLOT,
    zone: "S",
    rack: "03",
    slot: "B",
    address: "S-03-B",
    capacity: 4,
    active: true,
    serial: "LOC-000001",
    display_name: null,
  },
];

const CONTAINERS = [
  {
    id: C1,
    serial: "CTR-000001",
    name: "Conex 7",
    address: "Yard A, 400 S Industrial",
    access_code: "4417",
    notes: null,
    active: true,
    kind: "conex",
    created_at: "2026-08-01T00:00:00Z",
  },
];

function pkg(over: Record<string, unknown>) {
  return {
    id: "pkg-1",
    serial: "PKG-000001",
    short_code: "AB1CDE",
    status: "received",
    project_id: null,
    pending_job_name: null,
    mfr_mark: null,
    category: "windows",
    note: null,
    area: null,
    part_index: null,
    part_total: null,
    part_type: null,
    piece_count: null,
    delivery_id: null,
    container_id: null,
    location_id: null,
    bound_at: "2026-08-10T12:00:00Z",
    bound_by: "e2e",
    created_at: "2026-08-10T12:00:00Z",
    package_marks: [] as { mark_code: string }[],
    ...over,
  };
}

const STORED = pkg({
  id: "pkg-stored",
  serial: "PKG-000003",
  short_code: "CD3EFG",
  status: "stored",
  project_id: PECAN14.projectId,
  container_id: C1,
  package_marks: [{ mark_code: "4" }],
});
const BONEYARD = pkg({ id: "pkg-bone", serial: "PKG-000001", short_code: "AB1CDE" });
const MINTED = pkg({
  id: "pkg-minted",
  serial: "PKG-000009",
  short_code: "IJ9KLM",
  status: "minted",
  project_id: BLACK22.projectId,
  part_index: 1,
  part_total: 4,
});

const ALL = [STORED, BONEYARD, MINTED];

function json(route: Route, body: unknown, rows = 0) {
  return route.fulfill({
    status: 200,
    contentType: "application/json",
    headers: { "content-range": `0-${Math.max(0, rows - 1)}/${rows}` },
    body: JSON.stringify(body),
  });
}

/** The three RPCs ADR-0007 deliberately left foreman+, plus the two it left
 *  supervisor+. Nothing an installer does may reach any of them. */
const SHUT_RPCS = [
  "burn_packages",
  "delete_packages",
  "delete_delivery",
  "schedule_delivery",
  "save_checkout_reason",
];

/** Warehouse rows + captured RPC payloads. Also arms every shut door with a
 *  403 carrying the server's own sentence, so a button that slipped through
 *  fails loudly instead of looking like it worked. */
async function useWarehouseFixtures(page: Page) {
  const calls: { fn: string; body: unknown }[] = [];

  await page.route("**/rest/v1/storage_containers**", (r) =>
    json(r, CONTAINERS, CONTAINERS.length),
  );
  await page.route("**/rest/v1/packages**", (r) => {
    const url = new URL(r.request().url());
    const serial = url.searchParams.get("serial");
    if (serial?.startsWith("eq.")) {
      const row = ALL.find((p) => p.serial === serial.slice(3)) ?? null;
      return json(r, row, row ? 1 : 0);
    }
    const status = url.searchParams.get("status");
    const rows = status?.startsWith("eq.")
      ? ALL.filter((p) => p.status === status.slice(3))
      : ALL;
    return json(r, rows, rows.length);
  });
  await page.route("**/rest/v1/package_deliveries**", (r) =>
    json(r, [{ id: D1, label: "Tuesday truck", arrived_on: "2026-09-01", expected_at: null }], 1),
  );
  await page.route("**/rest/v1/project_marks**", (r) =>
    json(r, [{ project_id: BLACK22.projectId, mark_code: "16" }], 1),
  );
  await page.route("**/rest/v1/supplies**", (r) =>
    json(r, [{ id: SUPPLY, name: "Caulk", unit: "tube", on_hand: 40 }], 1),
  );

  for (const fn of SHUT_RPCS) {
    await page.route(`**/rest/v1/rpc/${fn}`, (r) => {
      calls.push({ fn, body: r.request().postDataJSON() });
      return r.fulfill({
        status: 403,
        contentType: "application/json",
        body: JSON.stringify({
          code: "42501",
          message: "Only a foreman or above can delete packages.",
        }),
      });
    });
  }
  for (const fn of [
    "set_package_area",
    "assign_package_to_job",
    "create_takeoff",
    "mint_packages",
  ]) {
    await page.route(`**/rest/v1/rpc/${fn}`, (r) => {
      calls.push({ fn, body: r.request().postDataJSON() });
      return json(r, fn === "set_package_area" ? STORED : {});
    });
  }
  return calls;
}

/** The package sheet's four rooms are <details> folds; "Fix things" and
 *  "Danger" start closed. Open one the way a person would — by tapping its
 *  summary — so an absent button really is absent and not merely folded. */
async function openGroup(page: Page, title: string) {
  const summary = page.getByText(title, { exact: true });
  const already = await summary.evaluate(
    (el) => (el.parentElement as HTMLDetailsElement).open,
  );
  if (!already) await summary.click();
}

test.use({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });

test("an installer sees the In storage section and the count cards", async ({ page }) => {
  // Both were foreman+ until ADR-0007. The counts ARE the warehouse's health
  // and the containers are where the material is; hiding them from the people
  // moving it is how "12 loose" stayed 12.
  await useSupabaseFixtures(page, { role: "installer" });
  await useWarehouseFixtures(page);
  await page.goto("/warehouse");

  await expect(page.getByRole("heading", { name: "Where is it" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "In storage" })).toBeVisible();
  await expect(page.getByText("Conex 7")).toBeVisible();

  for (const label of ["on hand", "not tagged", "loose", "damaged"]) {
    await expect(
      page.locator(".stat-card").filter({ hasText: label }),
      `an installer should see the "${label}" card`,
    ).toHaveCount(1);
  }

  // And the tools that came with the section.
  await expect(page.getByRole("button", { name: "New container" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Print blank stickers" })).toBeVisible();
});

test("an installer says where in the box a package sits", async ({ page }) => {
  await useSupabaseFixtures(page, { role: "installer" });
  const calls = await useWarehouseFixtures(page);
  await page.goto("/pkg/PKG-000003");

  await expect(page.getByText("Where in Conex 7")).toBeVisible();
  // A conex travels, so it offers the door-relative three and never a compass.
  await expect(page.getByRole("button", { name: "North" })).toHaveCount(0);
  // Scoped to the area row: the page header carries its own "Back" chip.
  const areas = page.locator(".row-gap").filter({
    has: page.getByRole("button", { name: "Front (door end)" }),
  });
  await areas.getByRole("button", { name: "Back", exact: true }).click();

  await expect.poll(() => calls.filter((c) => c.fn === "set_package_area").length).toBe(1);
  const body = calls.find((c) => c.fn === "set_package_area")!.body as {
    p_package: string;
    p_area: string;
  };
  expect(body.p_package).toBe(STORED.id);
  expect(body.p_area).toBe("back");
});

test("an installer assigns Boneyard stock to a job", async ({ page }) => {
  await useSupabaseFixtures(page, { role: "installer" });
  const calls = await useWarehouseFixtures(page);
  await page.goto("/pkg/PKG-000001");

  await openGroup(page, "Fix things");
  await page.getByRole("button", { name: "Assign to job…" }).click();

  const card = page.locator(".detail-card.wh-card").filter({
    hasText: "Out of the Boneyard",
  });
  await expect(card).toBeVisible();
  await card.locator("select").first().selectOption(BLACK22.projectId);
  await card.locator("select").nth(1).selectOption("16");
  await card.getByRole("button", { name: "Assign", exact: true }).click();

  await expect.poll(() => calls.filter((c) => c.fn === "assign_package_to_job").length).toBe(1);
  const body = calls.find((c) => c.fn === "assign_package_to_job")!.body as {
    p_package: string;
    p_project: string;
    p_mark: string;
  };
  expect(body.p_package).toBe(BONEYARD.id);
  expect(body.p_project).toBe(BLACK22.projectId);
  expect(body.p_mark).toBe("16");
});

test("an installer files a takeoff", async ({ page }) => {
  await useSupabaseFixtures(page, { role: "installer" });
  const calls = await useWarehouseFixtures(page);
  await page.goto("/takeoffs");

  await page.getByRole("button", { name: "New takeoff" }).click();
  const modal = page.locator(".modal-card");
  await expect(modal).toBeVisible();
  // Job, For, then the supply picker — the dialog's three selects, in order.
  await modal.locator("select").nth(0).selectOption(BLACK22.projectId);
  await modal.locator("select").nth(2).selectOption(SUPPLY);
  await modal.getByLabel("How many").fill("3");
  await modal.getByRole("button", { name: "Add", exact: true }).click();
  await expect(modal.getByText("Caulk ×3")).toBeVisible();
  await modal.getByRole("button", { name: "Request it" }).click();

  await expect.poll(() => calls.filter((c) => c.fn === "create_takeoff").length).toBe(1);
  const body = calls.find((c) => c.fn === "create_takeoff")!.body as {
    p_project: string;
    p_items: { supply_id: string; qty: number }[];
    p_ready: boolean;
  };
  expect(body.p_project).toBe(BLACK22.projectId);
  expect(body.p_items).toEqual([{ supply_id: SUPPLY, qty: 3 }]);
  expect(body.p_ready).toBe(false);
});

test("an installer still cannot burn a label or delete a package", async ({ page }) => {
  await useSupabaseFixtures(page, { role: "installer" });
  const calls = await useWarehouseFixtures(page);
  await page.goto("/pkg/PKG-000009");

  // Opened, so the absence is real and not the fold being shut.
  await openGroup(page, "Danger");
  await expect(page.getByRole("button", { name: "Burn this label…" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Delete this package…" })).toHaveCount(0);
  expect(calls.filter((c) => SHUT_RPCS.includes(c.fn))).toEqual([]);
});

test("a foreman on the same sheet still gets both — the split is real, not a bug", async ({
  page,
}) => {
  await useSupabaseFixtures(page, { role: "foreman" });
  await useWarehouseFixtures(page);
  await page.goto("/pkg/PKG-000009");

  await openGroup(page, "Danger");
  await expect(page.getByRole("button", { name: "Burn this label…" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Delete this package…" })).toBeVisible();
});

test("an installer renames a truck but cannot delete one", async ({ page }) => {
  await useSupabaseFixtures(page, { role: "installer" });
  const calls = await useWarehouseFixtures(page);
  await page.goto("/storage/deliveries");

  await page.getByRole("button", { name: "Edit…" }).click();
  // Renaming opened with ADR-0007…
  await expect(page.getByRole("button", { name: "Rename" })).toBeVisible();
  // …deleting did not, and neither did putting it on the schedule.
  await expect(page.getByRole("button", { name: "Delete delivery…" })).toHaveCount(0);
  await expect(page.getByText("When does the truck come?")).toHaveCount(0);
  expect(calls.filter((c) => SHUT_RPCS.includes(c.fn))).toEqual([]);
});

test("an installer rewrites a set but cannot start one over", async ({ page }) => {
  await useSupabaseFixtures(page, { role: "installer" });
  const calls = await useWarehouseFixtures(page);
  await page.route("**/rest/v1/part_type_options**", (r) => json(r, [], 0));
  await page.goto("/storage/rewrite-set?pending=Mad%20Moose&mark=8");

  await expect(page.getByRole("heading", { name: "The set, declared" })).toBeVisible();
  // Every control on the declaration is theirs now.
  await expect(page.getByRole("button", { name: "Make it match" })).toBeEnabled();
  await expect(page.getByRole("button", { name: "+ add line" })).toBeEnabled();
  // The factory reset is not: it is delete_packages wearing a friendlier name.
  await expect(page.getByRole("heading", { name: "Start this set over" })).toHaveCount(0);
  await expect(
    page.getByText("Only a foreman or above can start a set over."),
  ).toBeVisible();
  expect(calls.filter((c) => SHUT_RPCS.includes(c.fn))).toEqual([]);
});

/** The rack-slot rows /labels prints from, plus a note of every write that
 *  reached the table. `locations` has no RPC in front of it — the only policy
 *  on it is the partner wall — so "did an installer write" is the question,
 *  and the page is the only place that can answer no. */
async function useSlotFixtures(page: Page) {
  const writes: string[] = [];
  await page.route("**/rest/v1/locations**", (r) => {
    const m = r.request().method();
    if (m !== "GET" && m !== "HEAD") writes.push(m);
    return json(r, SLOTS, SLOTS.length);
  });
  return writes;
}

test("an installer prints rack labels but cannot retire or rename a slot", async ({
  page,
}) => {
  // /labels dropped to the installer floor with ADR-0007 because printing a
  // rack label is warehouse work. Retiring a slot is not — and there is no
  // server rank to fall back on, so this screen IS the wall.
  await useSupabaseFixtures(page, { role: "installer" });
  const calls = await useWarehouseFixtures(page);
  const writes = await useSlotFixtures(page);
  await page.goto("/labels");

  await expect(page.getByRole("button", { name: "Print 1 labels" })).toBeVisible();
  await page.getByLabel("Select S-03-B").check();
  // The row is genuinely ticked — so the missing Delete is the rule, not an
  // empty selection.
  await expect(page.getByRole("button", { name: "Print 1 selected" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Delete 1 selected" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Edit", exact: true })).toHaveCount(0);
  expect(writes, "an installer wrote to locations").toEqual([]);
  expect(calls.filter((c) => SHUT_RPCS.includes(c.fn))).toEqual([]);
});

test("a foreman on the same slot list gets Delete and Edit", async ({ page }) => {
  await useSupabaseFixtures(page, { role: "foreman" });
  await useWarehouseFixtures(page);
  await useSlotFixtures(page);
  await page.goto("/labels");

  await page.getByLabel("Select S-03-B").check();
  await expect(page.getByRole("button", { name: "Delete 1 selected" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Edit", exact: true })).toBeVisible();
});

const FRESH = pkg({
  id: "pkg-fresh",
  serial: "PKG-000044",
  short_code: "NN4OPQ",
  status: "stored",
  container_id: C1,
});

/** A container whose custom check-in really does create a row. The check-in
 *  reads the package list before and after itself to work out what it made,
 *  so without a list that GROWS there would be nothing to undo and a test
 *  about the undo would prove nothing. Registered after the warehouse
 *  fixtures so this list wins. */
async function useCheckinFixtures(page: Page, calls: { fn: string; body: unknown }[]) {
  let checkedIn = false;
  await page.route("**/rest/v1/packages**", (r) => {
    const rows = checkedIn ? [...ALL, FRESH] : ALL;
    return json(r, rows, rows.length);
  });
  await page.route("**/rest/v1/rpc/custom_checkin", (r) => {
    checkedIn = true;
    calls.push({ fn: "custom_checkin", body: r.request().postDataJSON() });
    return json(r, 1);
  });
}

test("an installer's custom check-in is not offered an undo the server refuses", async ({
  page,
}) => {
  // Checking something in has always been open to everybody. Undoing it is
  // delete_packages, which ADR-0007 kept at foreman+ — so the installer gets
  // the plain confirmation, and the Undo button is simply not there.
  await useSupabaseFixtures(page, { role: "installer" });
  const calls = await useWarehouseFixtures(page);
  await useCheckinFixtures(page, calls);
  await page.goto(`/storage/c/${C1}`);

  await page.getByRole("button", { name: "Custom check-in…" }).click();
  await page.getByRole("button", { name: "Check 1 in here" }).click();

  await expect(page.getByText("Checked 1 in.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Undo" })).toHaveCount(0);
  expect(calls.filter((c) => c.fn === "custom_checkin")).toHaveLength(1);
  expect(calls.filter((c) => SHUT_RPCS.includes(c.fn))).toEqual([]);
});

test("a foreman's same check-in does get the undo", async ({ page }) => {
  // This is what keeps the test above honest: the same fixtures, the same
  // tap, and the undo appears — so its absence for an installer is the rule
  // and not a fixture with nothing to offer.
  await useSupabaseFixtures(page, { role: "foreman" });
  const calls = await useWarehouseFixtures(page);
  await useCheckinFixtures(page, calls);
  await page.goto(`/storage/c/${C1}`);

  await page.getByRole("button", { name: "Custom check-in…" }).click();
  await page.getByRole("button", { name: "Check 1 in here" }).click();
  await expect(page.getByRole("button", { name: "Undo" })).toBeVisible();
});

test("the materials ledger's crate-delete button matches the door behind it", async ({
  page,
}) => {
  // This one was the mismatch, not a gate: "− crate" is delete_packages and
  // never asked about rank, so an installer got a server refusal that read
  // like the app was broken. It asks now.
  await useSupabaseFixtures(page, { role: "installer" });
  const calls = await useWarehouseFixtures(page);
  await page.goto(`/warehouse/materials?job=${BLACK22.projectId}`);

  await expect(page.getByRole("button", { name: "+ crate" })).toBeVisible();
  await expect(page.getByRole("button", { name: "− crate" })).toHaveCount(0);
  expect(calls.filter((c) => SHUT_RPCS.includes(c.fn))).toEqual([]);

  await useSupabaseFixtures(page, { role: "foreman" });
  await page.goto(`/warehouse/materials?job=${BLACK22.projectId}`);
  await expect(page.getByRole("button", { name: "− crate" })).toBeVisible();
});
