// The last two screens that could only ever open the camera.
//
// Both wrote their own `<input type="file">` and both put `capture="environment"`
// on it — the attribute that tells iOS and Android to open the camera and offer
// nothing else. So the package sheet's "Add a photo" and the missed-unit form's
// photo could not reach a picture already on the phone: the shot taken at the
// truck before the app was open, the one from the first walk of the house.
// Both go through lib/photo/usePhotoPicker now, which is the same pair of
// inputs photos-upload.spec.ts pins on the capture sheet.
//
// Two things are worth a browser here, and neither is visible in a unit test:
//
//   1. THE ATTRIBUTE. `capture` on the library input is the one-word
//      regression that broke this in the first place, and no headless browser
//      honours it (Chrome, Playwright and happy-dom all just open a dialog),
//      so only the source can be asked which input has it. usePhotoPicker.test
//      asks the source; this asks the rendered DOM, which is the half that
//      catches a sheet wiring the two up backwards.
//   2. THE SAME DOWNSTREAM PATH. A second door is only worth having if a file
//      picked through it goes exactly where a photo taken through the camera
//      goes. So each sheet is driven twice — once through each input — and the
//      two payloads are compared: same bucket, same path shape, same RPC.
//
// House style (photos-upload.spec.ts, storage.spec.ts): mocked routes, real
// UI, assert what the tap SENDS.

import { expect, test, type Page, type Route } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { jobFixtures, useSupabaseFixtures } from "./support/supabaseFixtures";

const SHOTS = resolve(dirname(fileURLToPath(import.meta.url)), "__screenshots__/photos");

const BLACK22 = jobFixtures().find((j) => j.jobCode === "BLACK22")!;

const PKG_ID = "00000000-0000-4000-8000-00000000a001";
const PKG_SERIAL = "PKG-000001";

/** A tiny (1x1) real PNG — the same fixture photos-upload.spec.ts uses, and
 * real enough for anything downstream that tries to decode it. */
const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

function pngFile(name: string) {
  return { name, mimeType: "image/png", buffer: Buffer.from(TINY_PNG_BASE64, "base64") };
}

/**
 * A PDF — the packing slip, the spec sheet — sitting in the Files app one tap
 * away from the photos. This is the file the library door made reachable and
 * the camera door never could, and `accept="image/*"` does not stop a phone
 * handing it over.
 */
function pdfFile(name: string) {
  return { name, mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4\n") };
}

/** The one sentence both sheets give a file that isn't a picture. */
const NOT_A_PHOTO = /isn't a photo this phone can read/;

function json(route: Route, body: unknown, rows = 0) {
  return route.fulfill({
    status: 200,
    contentType: "application/json",
    headers: { "content-range": `0-${Math.max(0, rows - 1)}/${rows}` },
    body: JSON.stringify(body),
  });
}

/** Every storage upload succeeds, and every object path it was given is kept —
 * "which bucket, which path" is half of what this spec compares. */
async function collectUploads(page: Page): Promise<string[]> {
  const paths: string[] = [];
  await page.route("**/storage/v1/object/**", (route) => {
    const url = route.request().url();
    if (url.includes("/object/sign/")) return json(route, { signedURL: "/fixture.jpg" });
    const objectPath = decodeURIComponent(url.split("/storage/v1/object/")[1] ?? "")
      .replace(/^(authenticated|public)\//, "")
      .split("?")[0];
    if (route.request().method() !== "GET") paths.push(objectPath);
    return json(route, { Key: objectPath });
  });
  return paths;
}

/** The attachments rows the offline outbox writes after the storage put — the
 * package sheet's half of "where did the photo actually go". */
async function collectAttachments(page: Page): Promise<Record<string, unknown>[]> {
  const rows: Record<string, unknown>[] = [];
  await page.route("**/rest/v1/attachments**", (route) => {
    if (route.request().method() === "POST") {
      const body = route.request().postDataJSON();
      for (const r of Array.isArray(body) ? body : [body]) {
        rows.push(r as Record<string, unknown>);
      }
      return route.fulfill({ status: 201, contentType: "application/json", body: "[]" });
    }
    return json(route, []);
  });
  return rows;
}

/** The fixture env points at a made-up Supabase host, so the app's own "Wrong
 * database" banner covers the header in every screenshot. Same trick
 * photos-upload.spec.ts uses, and for the same reason. */
async function hideWrongProjectBanner(page: Page) {
  await page.addInitScript(() => {
    document.addEventListener(
      "DOMContentLoaded",
      () => {
        const style = document.createElement("style");
        style.textContent = ".pwa-banner-wrong-project { display: none !important; }";
        document.head.appendChild(style);
      },
      { once: true },
    );
  });
}

/** One non-blank package, so the sheet's Photos card is on the screen at all. */
async function usePackageFixture(page: Page) {
  const row = {
    id: PKG_ID,
    serial: PKG_SERIAL,
    short_code: "AB1CDE",
    status: "received",
    project_id: BLACK22.projectId,
    category: "windows",
    note: null,
    delivery_id: null,
    container_id: null,
    bound_at: "2026-08-10T12:00:00Z",
    bound_by: "e2e",
    created_at: "2026-08-10T12:00:00Z",
    package_marks: [{ mark_code: "16" }],
  };
  await page.route("**/rest/v1/packages**", (route) => {
    // getPackageBySerial uses maybeSingle(), which asks for a bare object.
    const accept = route.request().headers()["accept"] ?? "";
    return accept.includes("pgrst.object") ? json(route, row, 1) : json(route, [row], 1);
  });
}

const pkgCamera = (page: Page) => page.locator('.photos-actions input[type="file"][capture]');
const pkgLibrary = (page: Page) =>
  page.locator('.photos-actions input[type="file"]:not([capture])');
const missedCamera = (page: Page) =>
  page.locator('.missed-photo-actions input[type="file"][capture]');
const missedLibrary = (page: Page) =>
  page.locator('.missed-photo-actions input[type="file"]:not([capture])');

test.use({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });

test("a package photo can come from the phone, and lands exactly where a camera shot does", async ({
  page,
}) => {
  await useSupabaseFixtures(page, { role: "foreman" });
  await usePackageFixture(page);
  const uploads = await collectUploads(page);
  const rows = await collectAttachments(page);

  await page.goto(`/pkg/${PKG_SERIAL}`);
  await expect(page.getByRole("heading", { name: "Photos" })).toBeVisible();

  // THE FIX, in two assertions. The library door has no `capture`, so the
  // phone offers the Photo Library, the Files app and Google Drive; the camera
  // door has it, so it opens straight to the rear lens.
  expect(await pkgLibrary(page).getAttribute("capture")).toBeNull();
  await expect(pkgLibrary(page)).toHaveAttribute("accept", "image/*");
  await expect(pkgCamera(page)).toHaveAttribute("capture", "environment");
  // A package gets several shots at once from the library and one from the
  // camera, which is what it always did — see packagePhotoPath's random suffix.
  await expect(pkgLibrary(page)).toHaveAttribute("multiple", "");
  expect(await pkgCamera(page).getAttribute("multiple")).toBeNull();

  // Drive BOTH doors, because "the same downstream path" is the claim.
  await pkgCamera(page).setInputFiles(pngFile("from-the-camera.png"));
  await expect.poll(() => rows.length, { timeout: 60_000 }).toBe(1);
  await pkgLibrary(page).setInputFiles(pngFile("from-the-library.png"));
  await expect.poll(() => rows.length, { timeout: 60_000 }).toBe(2);

  // Same bucket, same path shape, same row — the only difference between the
  // two is the timestamp and the random suffix that keep them apart.
  for (const path of uploads) {
    expect(path).toMatch(new RegExp(`^install-media/packages/${PKG_ID}/\\d+-[0-9a-f]+\\.jpg$`));
  }
  expect(uploads).toHaveLength(2);
  expect(uploads[0]).not.toBe(uploads[1]);
  for (const row of rows) {
    expect(row).toMatchObject({ kind: "photo", package_id: PKG_ID });
    expect(String(row.storage_path)).toMatch(
      new RegExp(`^install-media/packages/${PKG_ID}/`),
    );
  }
});

test("the package sheet shows both doors", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await hideWrongProjectBanner(page);
  await useSupabaseFixtures(page, { role: "foreman" });
  await usePackageFixture(page);
  await collectUploads(page);
  await collectAttachments(page);

  await page.goto(`/pkg/${PKG_SERIAL}`);
  const card = page.locator(".photos-actions");
  await expect(card.getByRole("button", { name: "Use camera" })).toBeVisible();
  await expect(card.getByRole("button", { name: "Upload files" })).toBeVisible();

  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: `${SHOTS}/package-sheet-390-dark.png` });
});

/**
 * Open the missed-unit form from the job Overview, fill it in, and add it
 * through ONE of the two doors. Returns what the tap sent.
 *
 * The Overview door rather than the map's: the sheet is the same component
 * either way, and this one does not need the planset PDF rendered first.
 */
async function addMissedUnitVia(
  page: Page,
  door: "camera" | "library",
  fileName: string,
): Promise<{ photoPath: string; body: Record<string, unknown> }> {
  const bodies: Record<string, unknown>[] = [];
  await page.route("**/rest/v1/rpc/add_field_unit", (route) => {
    bodies.push(route.request().postDataJSON() as Record<string, unknown>);
    return json(route, {
      id: "00000000-0000-4000-8000-0000000000f1",
      opening_code: "F1",
      project_id: BLACK22.projectId,
    });
  });

  await page.getByRole("button", { name: "Add a missed unit" }).click();
  await expect(page.getByRole("heading", { name: /isn't on the plans/i })).toBeVisible();

  const input = door === "camera" ? missedCamera(page) : missedLibrary(page);
  await input.setInputFiles(pngFile(fileName));
  // The inputs are hidden, so the sheet prints the name itself — without this
  // line there is nothing on screen to say the photo took.
  await expect(page.locator(".missed-unit-sheet").getByText(fileName)).toBeVisible();

  await page.locator("#missed-width").fill("36");
  await page.locator("#missed-height").fill("60");
  await page.getByRole("button", { name: "Add it" }).click();

  await expect.poll(() => bodies.length, { timeout: 60_000 }).toBe(1);
  await page.unroute("**/rest/v1/rpc/add_field_unit");
  const body = bodies[0];
  return { photoPath: String(body.p_photo_path), body };
}

test("a missed unit's photo can come from the phone, and rides into the same RPC", async ({
  page,
}) => {
  // Installer on purpose: the permission is an open shift on the job, checked
  // by the server, so this door is not rank-gated (data-off.spec.ts makes the
  // same point about the map's entry point).
  await useSupabaseFixtures(page, { role: "installer" });
  const uploads = await collectUploads(page);

  await page.goto(`/projects/${BLACK22.projectId}`);
  await expect(page.getByRole("button", { name: "Add a missed unit" })).toBeVisible({
    timeout: 60_000,
  });

  // The attributes first, on the sheet as it renders.
  await page.getByRole("button", { name: "Add a missed unit" }).click();
  expect(await missedLibrary(page).getAttribute("capture")).toBeNull();
  await expect(missedLibrary(page)).toHaveAttribute("accept", "image/*");
  await expect(missedCamera(page)).toHaveAttribute("capture", "environment");
  // One photo, either way: add_field_unit takes a single p_photo_path, so a
  // multi-pick would silently drop all but the first.
  expect(await missedLibrary(page).getAttribute("multiple")).toBeNull();
  await page.locator(".missed-unit-sheet").getByRole("button", { name: "Cancel" }).click();

  // Then both doors, all the way to the RPC.
  const camera = await addMissedUnitVia(page, "camera", "from-the-camera.png");
  const library = await addMissedUnitVia(page, "library", "from-the-library.png");

  const missedPath = new RegExp(
    `^install-media/${BLACK22.projectId}/missed/\\d+-[0-9a-z]+\\.jpg$`,
  );
  expect(camera.photoPath).toMatch(missedPath);
  expect(library.photoPath).toMatch(missedPath);
  // Same bucket and the same "bucket/path" spelling either way — which is what
  // puts the picture on the job feed and on the unit's own sheet.
  expect(uploads).toHaveLength(2);
  for (const path of uploads) {
    expect(path).toMatch(new RegExp(`^install-media/${BLACK22.projectId}/missed/`));
  }
  // And the rest of the payload does not know which door the file came through.
  const shape = (b: Record<string, unknown>) => ({ ...b, p_photo_path: "…" });
  expect(shape(library.body)).toEqual(shape(camera.body));
  expect(camera.body).toMatchObject({
    p_project_id: BLACK22.projectId,
    p_kind: "window",
    p_width_in: 36,
    p_height_in: 60,
  });
});

/**
 * THE COST OF THE SECOND DOOR, on the sheet where it is highest.
 *
 * A missed unit gets one photo and `uploadMissedUnitPhoto` names the object
 * `.jpg` from a template whatever it was handed — so a PDF picked here would
 * upload, its path would ride into `add_field_unit`, and the unit would exist
 * forever pointing at something the feed renders as a broken image. Every step
 * succeeds, so without this check nobody is ever told.
 */
test("a PDF picked for a missed unit is refused, and the sheet says so", async ({
  page,
}) => {
  await useSupabaseFixtures(page, { role: "installer" });
  const uploads = await collectUploads(page);
  const bodies: Record<string, unknown>[] = [];
  await page.route("**/rest/v1/rpc/add_field_unit", (route) => {
    bodies.push(route.request().postDataJSON() as Record<string, unknown>);
    return json(route, {
      id: "00000000-0000-4000-8000-0000000000f2",
      opening_code: "F2",
      project_id: BLACK22.projectId,
    });
  });

  await page.goto(`/projects/${BLACK22.projectId}`);
  await expect(page.getByRole("button", { name: "Add a missed unit" })).toBeVisible({
    timeout: 60_000,
  });
  await page.getByRole("button", { name: "Add a missed unit" }).click();
  const sheet = page.locator(".missed-unit-sheet");

  await missedLibrary(page).setInputFiles(pdfFile("packing-slip.pdf"));

  // Told, not ignored. A silent drop here is a tap that looks like nothing
  // happened, on the one field somebody walked outside to fill in.
  await expect(sheet.getByText(NOT_A_PHOTO)).toBeVisible();
  // And it is not held as the photo: the sheet prints the picked file's name,
  // and there is no name to print.
  await expect(sheet.getByText("packing-slip.pdf")).toHaveCount(0);
  expect(uploads).toEqual([]);

  // A real photo after the refusal still works, and answers the complaint.
  await missedLibrary(page).setInputFiles(pngFile("from-the-library.png"));
  await expect(sheet.getByText("from-the-library.png")).toBeVisible();
  await expect(sheet.getByText(NOT_A_PHOTO)).toHaveCount(0);

  await page.locator("#missed-width").fill("36");
  await page.locator("#missed-height").fill("60");
  await page.getByRole("button", { name: "Add it" }).click();
  await expect.poll(() => bodies.length, { timeout: 60_000 }).toBe(1);

  // One upload, and it is the photo — the PDF never got a path of its own.
  expect(uploads).toHaveLength(1);
  expect(String(bodies[0].p_photo_path)).toMatch(
    new RegExp(`^install-media/${BLACK22.projectId}/missed/\\d+-[0-9a-z]+\\.jpg$`),
  );
});

test("a PDF picked on a package is refused, and the card says so", async ({ page }) => {
  await useSupabaseFixtures(page, { role: "foreman" });
  await usePackageFixture(page);
  const uploads = await collectUploads(page);
  const rows = await collectAttachments(page);

  await page.goto(`/pkg/${PKG_SERIAL}`);
  await expect(page.getByRole("heading", { name: "Photos" })).toBeVisible();

  // The same hazard as the missed-unit sheet, and now the same answer. This
  // card already threw the PDF away — in silence, which from the outside is a
  // button that does nothing.
  await pkgLibrary(page).setInputFiles(pdfFile("packing-slip.pdf"));
  await expect(page.getByText(NOT_A_PHOTO)).toBeVisible();
  expect(uploads).toEqual([]);
  expect(rows).toEqual([]);
});

test("the missed-unit sheet shows both doors", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await hideWrongProjectBanner(page);
  await useSupabaseFixtures(page, { role: "installer" });
  await collectUploads(page);

  await page.goto(`/projects/${BLACK22.projectId}`);
  await page.getByRole("button", { name: "Add a missed unit" }).click();
  const sheet = page.locator(".missed-unit-sheet");
  await expect(sheet.getByRole("button", { name: "Use camera" })).toBeVisible();
  await expect(sheet.getByRole("button", { name: "Upload files" })).toBeVisible();
  await sheet.scrollIntoViewIfNeeded();

  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: `${SHOTS}/missed-unit-sheet-390-dark.png` });
});
