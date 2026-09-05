// The one Capture button, end to end. House style (receipts.spec.ts,
// daily-logs.spec.ts): mocked routes, real UI, assert the RPC PAYLOAD a tap
// actually sends — not merely that something rendered.
//
// The five things worth pinning, and why each of them:
//
//   1. An INSTALLER sees Capture everywhere, and their tiles are their tiles.
//      Before this the capture tab was foreman+ only, so the sheet was mounted
//      on an installer's phone and nothing could open it. The Daily log tile
//      stays hidden for them — daily_logs' RLS is foreman+ (Q7) and a tile
//      that greys out only advertises a door that does not exist.
//   2. A receipt captured from a job page carries that job's id into
//      file_receipt. That is the owner's ask in one sentence.
//   3. A photo captured with a job picked in the sheet reaches the upload
//      queue carrying that project id.
//   4. A foreman's Daily log tile files a log without leaving the screen.
//   5. The desktop rail's Capture opens the same sheet at 1024px, where there
//      is no bottom bar at all.
//
// Geolocation is stubbed denied, the way opening-sheet.spec.ts does it, so the
// capture pipeline's warm-fix never waits one out in headless Chromium.
import { expect, test, type Page, type Route } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { jobFixtures, useSupabaseFixtures } from "./support/supabaseFixtures";

const SHOTS = resolve(dirname(fileURLToPath(import.meta.url)), "__screenshots__/global-capture");

const BLACK22 = jobFixtures().find((j) => j.jobCode === "BLACK22")!;

const PROJECT = {
  id: BLACK22.projectId,
  job_code: "BLACK22",
  name: "Black Desert",
  address: null,
  status: "active",
};

const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

function pngFile(name: string) {
  return { name, mimeType: "image/png", buffer: Buffer.from(TINY_PNG_BASE64, "base64") };
}

function json(route: Route, body: unknown, rows = 0) {
  return route.fulfill({
    status: 200,
    contentType: "application/json",
    headers: { "content-range": `0-${Math.max(0, rows - 1)}/${rows}` },
    body: JSON.stringify(body),
  });
}

async function useProjectFixture(page: Page) {
  await page.route("**/rest/v1/projects**", (r) => json(r, [PROJECT], 1));
}

/** Every capture "upload" succeeds, whatever bucket it targets — the sheet's
 *  own storage traffic, not fixture data. Same idiom as receipts.spec.ts. */
async function useCaptureStorage(page: Page) {
  await page.route("**/storage/v1/object/**", (route) => {
    const url = route.request().url();
    if (url.includes("/object/sign/")) return json(route, { signedURL: "/fixture.jpg" });
    return json(route, { Key: "install-media/x.jpg" });
  });
}

/** Headless Chromium has no UI to grant or deny the real prompt, so make the
 *  outcome deterministic. Both doors: the one-shot lookup and the watch a
 *  capture surface starts on mount (lib/geoWatch.ts). */
async function stubGeolocationDenied(page: Page) {
  await page.addInitScript(() => {
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition = (_ok, err) => {
      err?.({ code: 1, message: "denied" } as GeolocationPositionError);
    };
    navigator.geolocation.watchPosition = (_ok, err) => {
      err?.({ code: 1, message: "denied", PERMISSION_DENIED: 1 } as GeolocationPositionError);
      return 1;
    };
    navigator.geolocation.clearWatch = () => {};
  });
}

const captureFab = (page: Page) => page.getByRole("button", { name: "Quick capture" });
const sheet = (page: Page) => page.getByRole("dialog", { name: "Quick capture" });

test("an installer finds Capture on every screen, and sees an installer's tiles", async ({
  page,
}) => {
  // Dark, because that is what a phone on a job site in August is set to and
  // it is the harder half of the palette to get right.
  await page.emulateMedia({ colorScheme: "dark" });
  await useSupabaseFixtures(page, { role: "installer" });
  await useProjectFixture(page);
  await stubGeolocationDenied(page);

  // Today, a job page, and the warehouse — three unrelated screens, one button.
  for (const path of ["/", `/projects/${BLACK22.projectId}`, "/warehouse"]) {
    await page.goto(path);
    await expect(captureFab(page), `Capture should be on ${path}`).toBeVisible();
  }

  await captureFab(page).click();
  await expect(sheet(page)).toBeVisible();

  // Their four tiles, and not the fifth. Daily log is foreman+ by RLS.
  for (const tile of ["Take a photo", "Add a receipt", "Open gallery", "Scan a unit"]) {
    await expect(sheet(page).getByText(tile, { exact: true })).toBeVisible();
  }
  await expect(sheet(page).getByText("Daily log", { exact: true })).toHaveCount(0);

  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: `${SHOTS}/installer-390-dark.png` });
});

test("a foreman gets the Daily log tile the installer does not", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" });
  await useSupabaseFixtures(page, { role: "foreman" });
  await useProjectFixture(page);
  await stubGeolocationDenied(page);

  await page.goto("/");
  await captureFab(page).click();
  await expect(sheet(page).getByText("Daily log", { exact: true })).toBeVisible();

  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: `${SHOTS}/foreman-390-light.png` });
});

test("a receipt captured from a job page files against that job", async ({ page }) => {
  await useSupabaseFixtures(page, { role: "installer" });
  await useProjectFixture(page);
  await useCaptureStorage(page);
  await stubGeolocationDenied(page);

  const filed: Record<string, unknown>[] = [];
  await page.route("**/rest/v1/rpc/file_receipt", async (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    filed.push(body);
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ id: body.p_id, ...body }),
    });
  });
  await page.route("**/rest/v1/receipts**", (route) =>
    json(route, { amount_cents: null, vendor: null, purchased_on: null, category: null, note: null }),
  );

  // The sheet primes its job from the open shift; this installer has none, so
  // pick the job by hand — which is also the path a person on a job page takes
  // when the shift and the screen disagree.
  await page.goto(`/projects/${BLACK22.projectId}`);
  await captureFab(page).click();
  await sheet(page).getByRole("button", { name: /Find a job/ }).click();
  await sheet(page).getByRole("button", { name: /BLACK22/ }).click();
  await sheet(page).getByText("Add a receipt", { exact: true }).click();

  await expect(page.getByRole("dialog", { name: "Add a receipt" })).toBeVisible();
  await page
    .locator('input[type="file"][accept="image/*"]')
    .setInputFiles(pngFile("receipt.png"));

  await expect.poll(() => filed.length).toBe(1);
  expect(filed[0]).toMatchObject({ p_project_id: BLACK22.projectId });
  expect(filed[0].p_photo_path).toMatch(/^install-media\/receipts\/.+\.jpg$/);

  // The job the sheet chose is a DEFAULT, not a lock: the follow-up still
  // offers to move it, which is the whole difference from the /photos page.
  await expect(page.getByText("Which job?")).toBeVisible();
});

test("a photo captured with a job picked lands in the queue carrying that job", async ({
  page,
}) => {
  await useSupabaseFixtures(page, { role: "installer" });
  await useProjectFixture(page);
  await useCaptureStorage(page);
  await stubGeolocationDenied(page);

  // The upload handler writes `attachments` after the storage put; capture the
  // row so "assigned to a job" is asserted on the write, not on the UI.
  const rows: Record<string, unknown>[] = [];
  await page.route("**/rest/v1/attachments**", async (route) => {
    if (route.request().method() === "POST") {
      const body = route.request().postDataJSON();
      for (const r of Array.isArray(body) ? body : [body]) {
        rows.push(r as Record<string, unknown>);
      }
      return route.fulfill({ status: 201, contentType: "application/json", body: "[]" });
    }
    return json(route, []);
  });

  await page.goto("/");
  await captureFab(page).click();
  await sheet(page).getByRole("button", { name: /Find a job/ }).click();
  await sheet(page).getByRole("button", { name: /BLACK22/ }).click();
  await sheet(page).getByText("Take a photo", { exact: true }).click();

  await expect(page.getByRole("dialog", { name: "Add job photos" })).toBeVisible();
  await page.locator('input[type="file"][accept="image/*"]').setInputFiles(pngFile("shot.png"));

  await expect.poll(() => rows.length, { timeout: 30_000 }).toBeGreaterThan(0);
  expect(rows[0]).toMatchObject({ project_id: BLACK22.projectId, kind: "photo" });

  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: `${SHOTS}/photo-with-job-390.png` });
});

test("a foreman files a daily log from Capture without leaving the screen", async ({ page }) => {
  await useSupabaseFixtures(page, { role: "foreman" });
  await useProjectFixture(page);
  await stubGeolocationDenied(page);

  const calls: Record<string, unknown>[] = [];
  await page.route("**/rest/v1/rpc/file_daily_log", async (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    calls.push(body);
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ id: "new-log-id", ...body }),
    });
  });

  // Deliberately started from a screen that is not the job page and not the
  // Logs tab: before this, the daily log had exactly two doors and neither was
  // reachable from here.
  await page.goto("/warehouse");
  await captureFab(page).click();
  await sheet(page).getByText("Daily log", { exact: true }).click();

  // No job chosen yet, so the sheet asks — and does NOT offer "No job", since
  // file_daily_log cannot file one without a project.
  await expect(page.getByText("Which job is this log for?")).toBeVisible();
  await expect(sheet(page).getByRole("button", { name: "No job — general" })).toHaveCount(0);
  await sheet(page).getByRole("button", { name: /BLACK22/ }).click();

  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Notes").fill("Set four units on the south wall.");
  await dialog.getByRole("button", { name: "Save" }).click();

  await expect.poll(() => calls.length).toBe(1);
  expect(calls[0]).toMatchObject({
    p_project_id: BLACK22.projectId,
    p_notes: "Set four units on the south wall.",
  });
});

test("the desktop rail opens the same sheet where there is no bottom bar", async ({ page }) => {
  await useSupabaseFixtures(page, { role: "foreman" });
  await useProjectFixture(page);
  await stubGeolocationDenied(page);
  await page.setViewportSize({ width: 1200, height: 900 });

  await page.goto("/");
  // The bottom bar is display:none from 860px up, so the phone FAB is gone and
  // the rail's button is the only Capture on the screen.
  await expect(page.locator(".capture-fab")).toBeHidden();
  await page.locator(".rail-capture").click();
  await expect(sheet(page)).toBeVisible();
  await expect(sheet(page).getByText("Take a photo", { exact: true })).toBeVisible();

  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: `${SHOTS}/desktop-1200.png` });
});
