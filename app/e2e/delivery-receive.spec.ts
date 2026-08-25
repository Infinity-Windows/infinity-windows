// The tailgate screen (owner, 2026-08-25): the truck gets checked AGAINST
// the standby list — arrive taps, count-based split storing of identical
// twins, and a missing report. No job required for any of it.
import { test, expect } from "@playwright/test";
import { useSupabaseFixtures } from "./support/supabaseFixtures";

const D = "00000000-0000-4000-8000-00000000de11";
const twin = (id: string, status: string) => ({
  id,
  status,
  project_id: null,
  pending_job_name: "Sunset Ridge 4",
  mfr_mark: "5050",
  part_index: 1,
  part_total: 3,
  part_type: null,
  piece_count: null,
  container_id: null,
  delivery_id: D,
  serial: `PKG-${id}`,
  short_code: id,
  bound_at: "2026-08-25T12:00:00Z",
  package_marks: [],
});

test("arrive and split identical twins across conexes by count", async ({
  page,
}) => {
  await useSupabaseFixtures(page, { role: "foreman" });

  const rows = [
    twin("a1", "minted"),
    twin("a2", "minted"),
    twin("a3", "minted"),
    twin("a4", "minted"),
    twin("a5", "minted"),
    twin("a6", "minted"),
  ];
  await page.route(
    (url) =>
      url.pathname.includes("/rest/v1/packages") &&
      (url.searchParams.get("delivery_id") ?? "").startsWith("eq."),
    (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(rows),
      }),
  );
  await page.route("**/rest/v1/storage_containers**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([
        { id: "00000000-0000-4000-8000-00000000c001", name: "Conex 1", kind: "conex", active: true },
        { id: "00000000-0000-4000-8000-00000000c002", name: "Conex 2", kind: "conex", active: true },
      ]),
    }),
  );
  await page.route("**/rest/v1/package_deliveries**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([{ id: D, label: "Test truck", arrived_on: "2026-08-25" }]),
    }),
  );
  const received: string[][] = [];
  await page.route("**/rest/v1/rpc/receive_minted_packages", async (route) => {
    const body = route.request().postDataJSON() as { p_packages: string[] };
    received.push(body.p_packages);
    for (const r of rows) if (body.p_packages.includes(r.id)) r.status = "received";
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: String(body.p_packages.length),
    });
  });
  const stored: Array<{ ids: string[]; container: string }> = [];
  await page.route("**/rest/v1/rpc/store_packages", async (route) => {
    const body = route.request().postDataJSON() as {
      p_packages: string[];
      p_container: string;
    };
    stored.push({ ids: body.p_packages, container: body.p_container });
    for (const r of rows) if (body.p_packages.includes(r.id)) r.status = "stored";
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: String(body.p_packages.length),
    });
  });

  await page.goto(`/storage/d/${D}`);
  await expect(
    page.getByText("Sunset Ridge 4 · #5050 — 1/3", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("0 of 6 arrived")).toBeVisible();
  await expect(page.getByText(/Job not built yet/)).toBeVisible();

  // All six come off the truck in one tap.
  await page.getByRole("button", { name: /✓ all 6/ }).click();
  await expect(page.getByText("6 of 6 arrived")).toBeVisible();
  expect(received[0]).toHaveLength(6);

  // A thumb slip: undo one arrival, then bring it back in.
  const undone: string[][] = [];
  await page.route("**/rest/v1/rpc/unreceive_packages", async (route) => {
    const body = route.request().postDataJSON() as { p_packages: string[] };
    undone.push(body.p_packages);
    for (const r of rows) if (body.p_packages.includes(r.id)) r.status = "minted";
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: String(body.p_packages.length),
    });
  });
  await page.getByRole("button", { name: /Undo an arrival of Sunset Ridge 4/ }).click();
  await expect(page.getByText("5 of 6 arrived")).toBeVisible();
  expect(undone[0]).toHaveLength(1);
  await page.getByRole("button", { name: /✓ 1 arrived/ }).click();
  await expect(page.getByText("6 of 6 arrived")).toBeVisible();

  // Rapid split: 4 into the first conex…
  await page
    .getByLabel("How many of Sunset Ridge 4 · #5050 — 1/3 to store")
    .selectOption("4");
  const where = page.getByLabel("Where to store Sunset Ridge 4 · #5050 — 1/3");
  const first = await where.locator("option").nth(1).getAttribute("value");
  await where.selectOption(first!);
  await page.getByRole("button", { name: "Store 4" }).click();
  expect(stored[0].ids).toHaveLength(4);

  // …and the remaining 2 into another. Which twins went where never mattered.
  await expect(page.getByText("6 of 6 arrived", { exact: false }).first()).toBeVisible();
  const where2 = page.getByLabel("Where to store Sunset Ridge 4 · #5050 — 1/3");
  const second = await where2.locator("option").nth(2).getAttribute("value");
  await where2.selectOption(second!);
  await page.getByRole("button", { name: /Store 2/ }).click();
  expect(stored[1].ids).toHaveLength(2);
  expect(new Set([...stored[0].ids, ...stored[1].ids]).size).toBe(6);
});

test("search filters, and a cross-job bundle stores with one I-Understand", async ({
  page,
}) => {
  await useSupabaseFixtures(page, { role: "foreman" });
  const rows = [
    { ...twin("j1a", "received"), pending_job_name: "Sunset Ridge 4" },
    { ...twin("j1b", "received"), pending_job_name: "Sunset Ridge 4" },
    {
      ...twin("j2a", "received"),
      pending_job_name: "Mad Moose",
      mfr_mark: "7",
      part_index: 2,
      part_total: 5,
    },
  ];
  await page.route(
    (url) =>
      url.pathname.includes("/rest/v1/packages") &&
      (url.searchParams.get("delivery_id") ?? "").startsWith("eq."),
    (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(rows),
      }),
  );
  await page.route("**/rest/v1/storage_containers**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([
        { id: "00000000-0000-4000-8000-00000000c001", name: "Conex 1", kind: "conex", active: true },
      ]),
    }),
  );
  await page.route("**/rest/v1/package_deliveries**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([{ id: D, label: "Mixed truck", arrived_on: "2026-08-25" }]),
    }),
  );
  const stored: Array<{ ids: string[]; container: string }> = [];
  await page.route("**/rest/v1/rpc/store_packages", async (route) => {
    const body = route.request().postDataJSON() as {
      p_packages: string[];
      p_container: string;
    };
    stored.push({ ids: body.p_packages, container: body.p_container });
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: String(body.p_packages.length),
    });
  });

  await page.goto(`/storage/d/${D}`);

  // Search narrows to one job's rows.
  await page.getByLabel("Search this delivery").fill("mad moose");
  await expect(page.getByText("Mad Moose · #7 — 2/5", { exact: true })).toBeVisible();
  await expect(
    page.getByText("Sunset Ridge 4 · #5050 — 1/3", { exact: true }),
  ).toBeHidden();
  await page.getByLabel("Search this delivery").fill("");

  // Bundle two rows from two different jobs into one conex.
  await page.getByRole("button", { name: /Select several/ }).click();
  await page.getByLabel("Select Sunset Ridge 4 · #5050 — 1/3").check();
  await page.getByLabel("Select Mad Moose · #7 — 2/5").check();
  await expect(page.getByText("3 pieces from 2 jobs selected")).toBeVisible();
  await page
    .getByLabel("Where to store the selected pieces")
    .selectOption("00000000-0000-4000-8000-00000000c001");
  await page.getByRole("button", { name: /Store 3 together/ }).click();

  // The quick warning, then through.
  await expect(page.getByText(/2 different jobs/)).toBeVisible();
  expect(stored).toHaveLength(0);
  await page.getByRole("button", { name: /I Understand — store them/ }).click();
  await expect(page.getByText("Stored 3 together.")).toBeVisible();
  expect(stored[0].ids.sort()).toEqual(["j1a", "j1b", "j2a"]);
});
