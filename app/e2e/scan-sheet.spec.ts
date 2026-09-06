// The scan sheet (warehouse redesign wave 2): one scan leads with the next
// verb; a box scanned first swallows everything after it; no sticker means
// type the code or pick the piece. Headless Chromium has no camera, so the
// Scanner shows its typed-entry box and every "scan" here is typed — the same
// path a hand confirmation takes on a phone.
import { expect, test, type Route } from "@playwright/test";
import { jobFixtures, useSupabaseFixtures } from "./support/supabaseFixtures";

const JOBS = jobFixtures();
const BLACK22 = JOBS.find((j) => j.jobCode === "BLACK22")!;
const C1 = "00000000-0000-4000-8000-00000000c001";
const C3 = "00000000-0000-4000-8000-00000000c003";
const P = (n: number) => `00000000-0000-4000-8000-00000000a0${String(n).padStart(2, "0")}`;
/** Six characters from the sticker alphabet — no O, 0, I or 1 (lib/qr.ts). */
const CODE = (n: number) => `AB${"CDEFGH"[n - 1]}QLM`;

function pkg(n: number, status: string, over: Record<string, unknown> = {}) {
  return {
    id: P(n), serial: `PKG-0000${String(n).padStart(2, "0")}`, short_code: CODE(n),
    status, project_id: BLACK22.projectId, category: "windows", note: null, delivery_id: null,
    container_id: status === "stored" ? C1 : null, location_id: null, area: null,
    part_index: n, part_total: 3, part_type: ["frame", "glass", "hardware"][n - 1],
    bound_at: "2026-08-10T12:00:00Z", bound_by: "e2e", created_at: "2026-08-10T12:00:00Z",
    package_marks: [{ mark_code: "16" }],
    ...over,
  };
}
const CONTAINERS = [
  { id: C1, serial: "CTR-000001", name: "Conex 7", kind: "conex", active: true, address: null, access_code: null, notes: null, created_at: "2026-08-01T00:00:00Z" },
  { id: C3, serial: "CTR-000003", name: "Conex 3", kind: "conex", active: true, address: null, access_code: null, notes: null, created_at: "2026-08-01T00:00:00Z" },
];

function json(route: Route, body: unknown, rows = 0) {
  return route.fulfill({
    status: 200, contentType: "application/json",
    headers: { "content-range": `0-${Math.max(0, rows - 1)}/${rows}` },
    body: JSON.stringify(body),
  });
}

async function fixtures(page: import("@playwright/test").Page, rows: unknown[]) {
  await useSupabaseFixtures(page, { role: "installer" });
  await page.route("**/rest/v1/packages**", (r) => json(r, rows, rows.length));
  await page.route("**/rest/v1/storage_containers**", (r) => json(r, CONTAINERS, CONTAINERS.length));
  await page.route("**/rest/v1/movements**", (r) => json(r, [], 0));
  const calls: { fn: string; body: unknown }[] = [];
  for (const fn of ["store_packages", "receive_minted_packages"]) {
    await page.route(`**/rest/v1/rpc/${fn}`, (r) => {
      calls.push({ fn, body: r.request().postDataJSON() });
      return json(r, 1);
    });
  }
  return calls;
}

async function typeCode(page: import("@playwright/test").Page, code: string) {
  const box = page.getByPlaceholder(/Or type ID/);
  await box.fill(code);
  await box.press("Enter");
}

test("a loose piece leads with 'Put with the rest' when its unit sits in one box", async ({ page }) => {
  const rows = [pkg(1, "stored"), pkg(2, "stored"), pkg(3, "received")];
  const calls = await fixtures(page, rows);
  await page.goto("/scan");
  await typeCode(page, CODE(3));
  await expect(page.getByText("3 of 3 · Hardware", { exact: false }).or(page.getByText(/Part 3 of 3/))).toBeVisible();
  const primary = page.locator(".scan-verb--primary");
  await expect(primary).toContainText("Put with the rest of window 16");
  await expect(primary).toContainText("Conex 7");
  await primary.click();
  await expect.poll(() => calls.filter((c) => c.fn === "store_packages").length).toBe(1);
  expect(calls[0].body).toEqual({ p_packages: [P(3)], p_container: C1 });
});

test("an expected piece leads with Arrive; a stored one with Move, then a box list", async ({ page }) => {
  const rows = [pkg(1, "minted"), pkg(2, "stored")];
  const calls = await fixtures(page, rows);
  await page.goto("/scan");
  await typeCode(page, CODE(1));
  await expect(page.locator(".scan-verb--primary")).toContainText("Arrived");
  await page.locator(".scan-verb--primary").click();
  await expect.poll(() => calls.filter((c) => c.fn === "receive_minted_packages").length).toBe(1);

  await page.getByRole("button", { name: "Clear" }).click();
  await typeCode(page, CODE(2));
  await expect(page.locator(".scan-verb--primary")).toContainText("Move to another box");
  await page.locator(".scan-verb--primary").click();
  await expect(page.getByText("Which box?")).toBeVisible();
  await page.getByRole("button", { name: /Conex 3/ }).click();
  await expect.poll(() => calls.filter((c) => c.fn === "store_packages").length).toBe(1);
  expect(calls.find((c) => c.fn === "store_packages")!.body).toEqual({ p_packages: [P(2)], p_container: C3 });
});

test("a box scanned first swallows every sticker after it", async ({ page }) => {
  const rows = [pkg(1, "received"), pkg(2, "received")];
  const calls = await fixtures(page, rows);
  await page.goto("/scan");
  await typeCode(page, "CTR-000003");
  await expect(page.getByText("Putting away into Conex 3")).toBeVisible();
  await typeCode(page, CODE(1));
  await expect.poll(() => calls.filter((c) => c.fn === "store_packages").length).toBe(1);
  await typeCode(page, CODE(2));
  await expect.poll(() => calls.filter((c) => c.fn === "store_packages").length).toBe(2);
  expect(calls.map((c) => (c.body as { p_container: string }).p_container)).toEqual([C3, C3]);
});

test("no sticker: pick the piece by job and window", async ({ page }) => {
  const rows = [pkg(1, "received"), pkg(2, "received")];
  await fixtures(page, rows);
  await page.goto("/scan");
  await page.getByRole("button", { name: "Pick it by job and window…" }).click();
  await page.getByLabel("Job", { exact: true }).selectOption(BLACK22.projectId);
  await page.getByLabel("Window", { exact: true }).selectOption("16");
  await page.getByRole("button", { name: /2 of 3 · glass/ }).click();
  await expect(page.locator(".scan-verb--primary")).toContainText("Put away");
});

test("the Scan button floats on warehouse screens and opens the same sheet", async ({ page }) => {
  await fixtures(page, [pkg(1, "stored")]);
  await page.goto("/warehouse");
  await page.getByRole("button", { name: "Scan a sticker or a box" }).click();
  await expect(page.getByRole("dialog", { name: "Scan" })).toBeVisible();
  await page.getByRole("button", { name: "Close" }).click();
  await expect(page.getByRole("dialog", { name: "Scan" })).toHaveCount(0);
});
