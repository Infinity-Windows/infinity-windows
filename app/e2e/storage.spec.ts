// Storage tracking flows, driven through the real UI with fixture data:
// the hub shows every conex with its contents; check-in is the owner's
// no-camera multi-select (pick the container once, tick packages, one
// submit); checkout demands a reason + destination job and flags packages
// bound to a DIFFERENT job before they leave under the wrong one. The
// asserts capture the actual RPC payloads the buttons send.

import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page, type Route } from "@playwright/test";
import { jobFixtures, useSupabaseFixtures } from "./support/supabaseFixtures";

const SHOTS = join(
  dirname(fileURLToPath(import.meta.url)),
  "__screenshots__",
  "storage",
);

const JOBS = jobFixtures();
const BLACK22 = JOBS.find((j) => j.jobCode === "BLACK22")!;
const PECAN14 = JOBS.find((j) => j.jobCode === "PECAN14")!;

const C1 = "00000000-0000-4000-8000-00000000c001";
const C2 = "00000000-0000-4000-8000-00000000c002";
const P = (n: number) => `00000000-0000-4000-8000-00000000a0${String(n).padStart(2, "0")}`;

const CONTAINERS = [
  {
    id: C1, serial: "CTR-000001", name: "Conex 7",
    address: "Yard A, 400 S Industrial", access_code: "4417", notes: null,
    active: true, created_at: "2026-08-01T00:00:00Z",
  },
  {
    id: C2, serial: "CTR-000002", name: "Main warehouse",
    address: null, access_code: null, notes: null,
    active: true, created_at: "2026-08-01T00:00:00Z",
  },
];

function pkg(
  n: number,
  status: string,
  projectId: string | null,
  containerId: string | null,
  marks: string[] = [],
) {
  return {
    id: P(n),
    serial: `PKG-0000${String(n).padStart(2, "0")}`,
    short_code: `AB${n}CDE`,
    status,
    project_id: projectId,
    category: "windows",
    note: null,
    delivery_id: null,
    container_id: containerId,
    bound_at: "2026-08-10T12:00:00Z",
    bound_by: "e2e",
    created_at: "2026-08-10T12:00:00Z",
    package_marks: marks.map((mark_code) => ({ mark_code })),
  };
}

const PACKAGES = [
  pkg(1, "received", BLACK22.projectId, null, ["16"]),
  pkg(2, "received", BLACK22.projectId, null),
  pkg(3, "stored", PECAN14.projectId, C1),
];

const REASONS = [
  { id: "r1", label: "Ready for installation", sort: 10, active: true },
  { id: "r2", label: "Other", sort: 90, active: true },
];

function json(route: Route, body: unknown, rows = 0) {
  return route.fulfill({
    status: 200,
    contentType: "application/json",
    headers: { "content-range": `0-${Math.max(0, rows - 1)}/${rows}` },
    body: JSON.stringify(body),
  });
}

/** Fixture rows for the storage tables + captured write payloads. */
async function useStorageFixtures(page: Page) {
  const calls: { fn: string; body: unknown }[] = [];
  await page.route("**/rest/v1/storage_containers**", (r) =>
    json(r, CONTAINERS, CONTAINERS.length),
  );
  await page.route("**/rest/v1/packages**", (r) => {
    const url = new URL(r.request().url());
    const status = url.searchParams.get("status");
    // The hub/lists ask for status=neq.blank — serve everything non-blank.
    const rows = status?.startsWith("neq.")
      ? PACKAGES
      : PACKAGES.filter((p) => p.status === (status?.replace("eq.", "") ?? p.status));
    return json(r, rows, rows.length);
  });
  await page.route("**/rest/v1/checkout_reasons**", (r) =>
    json(r, REASONS, REASONS.length),
  );
  await page.route("**/rest/v1/rpc/store_packages", (r) => {
    calls.push({ fn: "store_packages", body: r.request().postDataJSON() });
    return json(r, 2);
  });
  await page.route("**/rest/v1/rpc/checkout_packages", (r) => {
    calls.push({ fn: "checkout_packages", body: r.request().postDataJSON() });
    return json(r, 1);
  });
  return calls;
}

test.use({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });

test("hub shows each container with its contents and aging", async ({ page }) => {
  // A foreman, not an installer. The container hub went foreman+ (D6): it had
  // been listed as installer-reachable while nothing in the app ever took an
  // installer there, and it showed Tag and Check out to every role while the
  // warehouse page kept the same tools to leads. Two doors to one set of tools
  // with two different rules is the drift that got closed.
  await useSupabaseFixtures(page, { role: "foreman" });
  await useStorageFixtures(page);
  await page.goto("/storage");

  await expect(page.getByText("Conex 7")).toBeVisible();
  await expect(page.getByText("Main warehouse")).toBeVisible();
  // Conex 7 holds the one stored PECAN14 package.
  await expect(page.getByText(/1 package · PECAN14 ×1/)).toBeVisible();

  // Search finds a package by the MARK riding inside it.
  await page.getByPlaceholder(/PKG-000123/).fill("16");
  await expect(page.getByText("PKG-000001 · AB1CDE")).toBeVisible();

  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: join(SHOTS, "hub.png"), fullPage: true });
});

test("an installer is turned away from the container hub", async ({ page }) => {
  // The other half of D6, and the half a registry cannot prove: the floor in
  // the route registry says who MAY open a path, and the app still has to
  // actually stop them. Tagging and checking out are unaffected — those belong
  // to whoever is at the truck (S3) and they are reached from the warehouse
  // page, which is why locking this hub does not cost an installer anything.
  await useSupabaseFixtures(page, { role: "installer" });
  await useStorageFixtures(page);
  await page.goto("/storage");

  await expect(
    page.getByRole("heading", { name: "Not available for your role" }),
  ).toBeVisible();
  await expect(page.getByText("Conex 7")).toHaveCount(0);
});

test("check-in: pick the conex once, tick packages, one submit", async ({
  page,
}) => {
  await useSupabaseFixtures(page, { role: "installer" });
  const calls = await useStorageFixtures(page);
  await page.goto(`/storage/c/${C1}`);

  await expect(page.getByRole("heading", { name: "Conex 7" })).toBeVisible();
  await expect(page.getByText("code 4417")).toBeVisible();

  await page.getByRole("button", { name: "Check in packages" }).click();
  // The two tagged-but-unstored packages are candidates; tick both.
  await page.getByRole("button", { name: /PKG-000001/ }).click();
  await page.getByRole("button", { name: /PKG-000002/ }).click();
  await page.getByRole("button", { name: "Store 2 here" }).click();

  await expect
    .poll(() => calls.filter((c) => c.fn === "store_packages").length)
    .toBe(1);
  const body = calls[0].body as { p_packages: string[]; p_container: string };
  expect(body.p_container).toBe(C1);
  expect(new Set(body.p_packages)).toEqual(new Set([P(1), P(2)]));

  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: join(SHOTS, "check-in.png"), fullPage: true });
});

test("checkout requires reason + job and flags a cross-job package", async ({
  page,
}) => {
  await useSupabaseFixtures(page, { role: "installer" });
  const calls = await useStorageFixtures(page);
  await page.goto("/storage/out");

  // Pick the stored PECAN14 package…
  await page.getByRole("button", { name: /PKG-000003/ }).click();
  // …reason…
  await page.getByRole("button", { name: "Ready for installation" }).click();
  // …but send it to BLACK22: the mismatch guard must speak up.
  await page
    .locator("select")
    .last()
    .selectOption(BLACK22.projectId);
  await expect(page.getByText(/tagged\s+for a different job/)).toBeVisible();

  await page.getByRole("button", { name: "Check out 1" }).click();
  await expect
    .poll(() => calls.filter((c) => c.fn === "checkout_packages").length)
    .toBe(1);
  const body = calls.find((c) => c.fn === "checkout_packages")!.body as {
    p_packages: string[];
    p_reason: string;
    p_project: string;
  };
  expect(body.p_packages).toEqual([P(3)]);
  expect(body.p_reason).toBe("Ready for installation");
  expect(body.p_project).toBe(BLACK22.projectId);

  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: join(SHOTS, "checkout.png"), fullPage: true });
});
