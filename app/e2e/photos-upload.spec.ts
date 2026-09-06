// "Upload files" opens the phone's own picker — the library, the Files app,
// Google Drive — instead of the camera, and a file that is not a picture says
// so in one sentence instead of vanishing.
//
// House style (receipts.spec.ts, global-capture.spec.ts): mocked routes, real
// UI, assert what the tap actually SENDS — here the attachments rows the
// offline outbox writes — rather than that something rendered.
//
// The thing worth pinning forever is an ATTRIBUTE: `capture` on the upload
// input is what told iOS and Android "camera only, no picker", and it is a
// one-word regression that no screenshot would catch.
import { expect, test, type Page, type Route } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { jobFixtures, useSupabaseFixtures } from "./support/supabaseFixtures";

const SHOTS = resolve(dirname(fileURLToPath(import.meta.url)), "__screenshots__/photos");

const BLACK22 = jobFixtures().find((j) => j.jobCode === "BLACK22")!;

/** A tiny (1x1) real PNG — small enough to inline, real enough for the capture
 * pipeline's canvas decode (createImageBitmap/Image) to succeed. Same fixture
 * receipts.spec.ts uses for the same reason. */
const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

function pngFile(name: string) {
  return { name, mimeType: "image/png", buffer: Buffer.from(TINY_PNG_BASE64, "base64") };
}

/** What a phone hands over when the pick was not a photo: a real file, a name
 * that ends in .jpg, the mime type the OS guesses from that name — and bytes
 * no image decoder can do anything with. A PDF from the Files app and a
 * half-synced download both arrive looking exactly like this. */
function notAPhoto(name: string) {
  return { name, mimeType: "image/jpeg", buffer: Buffer.from("this is not a picture") };
}

function json(route: Route, body: unknown, rows = 0) {
  return route.fulfill({
    status: 200,
    contentType: "application/json",
    headers: { "content-range": `0-${Math.max(0, rows - 1)}/${rows}` },
    body: JSON.stringify(body),
  });
}

/** Every capture "upload" succeeds, whatever bucket it targets — the sheet's
 * own storage traffic, not fixture data. Same idiom as receipts.spec.ts. */
async function useCaptureStorage(page: Page) {
  await page.route("**/storage/v1/object/**", (route) => {
    if (route.request().url().includes("/object/sign/")) {
      return json(route, { signedURL: "/fixture.jpg" });
    }
    return json(route, { Key: "install-media/x.jpg" });
  });
}

/** Headless Chromium has no UI to grant or deny the real prompt, so make the
 * outcome deterministic — the same stub global-capture.spec.ts uses. */
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

/** The fixture env points at a made-up Supabase host, so the app's own
 * "Wrong database" banner covers the header in every screenshot. Same trick
 * stg-partner-wall.spec.ts uses, and for the same reason. */
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

/** Collect the attachments rows the outbox writes after the storage put. */
async function collectPhotoRows(page: Page): Promise<Record<string, unknown>[]> {
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
  return rows;
}

const uploadInput = (page: Page) =>
  page.locator('.jobphoto-actions label:has-text("Upload files") input[type="file"]');
const cameraInput = (page: Page) =>
  page.locator('.jobphoto-actions label:has-text("Use camera") input[type="file"]');
/** The live-preview shutter: a real button, not the camera-app hand-off. */
const cameraButton = (page: Page) =>
  page.locator('.jobphoto-actions button:has-text("Use camera")');

/** Make getUserMedia fail the way a given phone fails.
 *
 * `delayMs` is the gap between the tap and the answer — the permission prompt,
 * which on a phone can sit there for as long as the person looks at it. */
async function stubCameraFailure(page: Page, name: string, delayMs = 0) {
  await page.addInitScript(
    (opts: { name: string; delayMs: number }) => {
      const media = {
        getUserMedia: () =>
          new Promise<MediaStream>((_ok, reject) => {
            setTimeout(() => reject(new DOMException("stubbed", opts.name)), opts.delayMs);
          }),
      };
      Object.defineProperty(navigator, "mediaDevices", { value: media, configurable: true });
    },
    { name, delayMs },
  );
}

async function openTheSheet(page: Page) {
  await page.goto(`/photos?project=${BLACK22.projectId}`);
  await page.getByRole("button", { name: "Add photo" }).click();
  await expect(page.getByRole("dialog", { name: "Add job photos" })).toBeVisible();
}

/**
 * Wait for the bottom sheet to stop moving before photographing it.
 *
 * `.sheet-enter` slides the sheet a full height up and fades it in over 220ms.
 * A screenshot taken the instant the tiles become VISIBLE catches all of that
 * half-done: the whole page dimmed by the opacity ramp, the sheet still pushed
 * down, and its two buttons sliced off by the bottom of the viewport with the
 * tab bar showing through them — a collision the CSS does not actually have
 * (`bottom: var(--above-tabbar)` parks the settled sheet above the bar).
 *
 * The wait is also the assertion: the sheet has landed when its bottom edge is
 * at or above the top of the tab bar, and that is the thing the shot is for.
 */
async function settleSheetAboveTabbar(page: Page) {
  const sheet = page.locator(".jobphoto-sheet");
  await expect(sheet).toBeVisible();
  await expect
    .poll(async () => {
      const s = await sheet.boundingBox();
      const bar = await page.locator("nav.tabbar").boundingBox();
      if (!s || !bar) return false;
      const landed = Math.round(s.y + s.height) <= Math.round(bar.y);
      // Reduced motion drops the slide and keeps the fade, so the box can be
      // right while the sheet is still see-through.
      const opaque = await sheet.evaluate((el) => getComputedStyle(el).opacity === "1");
      return landed && opaque;
    })
    .toBe(true);
}

test("Upload files opens the phone's own picker, and two picked photos both reach the queue", async ({
  page,
}) => {
  await useSupabaseFixtures(page, { role: "foreman" });
  await useCaptureStorage(page);
  await stubGeolocationDenied(page);
  const rows = await collectPhotoRows(page);

  await openTheSheet(page);

  // THE FIX, in one assertion: no `capture` attribute. With it, iOS and
  // Android open the camera and offer nothing else — no Photo Library, no
  // Files, no Google Drive — which is exactly the bug this is here to stop
  // coming back.
  await expect(uploadInput(page)).toHaveAttribute("accept", "image/*");
  expect(await uploadInput(page).getAttribute("capture")).toBeNull();
  // And with a live camera to drive, the camera-app fallback is not on the
  // page at all — so the sheet still holds exactly one file input, which is
  // what receipts.spec.ts / global-capture.spec.ts address by that selector.
  await expect(cameraInput(page)).toHaveCount(0);
  await expect(page.locator('.jobphoto-actions input[type="file"]')).toHaveCount(1);

  // A phone photo pick is usually several at once — that is the whole point of
  // reaching the library — so prove the multi-pick, and prove both land on the
  // job the page is filtered to.
  await uploadInput(page).setInputFiles([pngFile("south-1.png"), pngFile("south-2.png")]);

  await expect.poll(() => rows.length, { timeout: 60_000 }).toBe(2);
  for (const row of rows) {
    expect(row).toMatchObject({ project_id: BLACK22.projectId, kind: "photo" });
  }
});

test("with no camera to drive, Use camera hands off to the phone's camera app", async ({
  page,
}) => {
  // A browser with no getUserMedia at all: an in-app webview, an old machine,
  // or a permission already refused. The OS camera app is then the only
  // shutter left, and `capture` is what opens it straight to the rear lens.
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "mediaDevices", { value: undefined, configurable: true });
  });
  await useSupabaseFixtures(page, { role: "foreman" });
  await useCaptureStorage(page);
  await stubGeolocationDenied(page);

  await openTheSheet(page);

  await expect(cameraInput(page)).toHaveAttribute("capture", "environment");
  // The other half of the split: the upload input never gets it, even here.
  expect(await uploadInput(page).getAttribute("capture")).toBeNull();
});

test("a file this phone can't read says so by name, and the good one still goes", async ({
  page,
}) => {
  await useSupabaseFixtures(page, { role: "foreman" });
  await useCaptureStorage(page);
  await stubGeolocationDenied(page);
  const rows = await collectPhotoRows(page);

  await openTheSheet(page);
  await uploadInput(page).setInputFiles([notAPhoto("scan.jpg"), pngFile("south-1.png")]);

  // Named, so a pick of ten says WHICH one — and in plain words, not
  // "InvalidStateError".
  await expect(page.getByText("scan.jpg")).toBeVisible();
  await expect(
    page.getByText("That file isn't a photo this phone can read — try a JPG or PNG."),
  ).toBeVisible();

  // One bad file does not take the rest of the pick with it.
  await expect.poll(() => rows.length, { timeout: 60_000 }).toBe(1);
  expect(rows[0]).toMatchObject({ project_id: BLACK22.projectId, kind: "photo" });
});

test("the capture sheet offers both doors: the camera, and everything else on the phone", async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await hideWrongProjectBanner(page);
  await useSupabaseFixtures(page, { role: "foreman" });
  await useCaptureStorage(page);
  await stubGeolocationDenied(page);

  await openTheSheet(page);
  await expect(page.getByText("Use camera")).toBeVisible();
  await expect(page.getByText("Upload files")).toBeVisible();
  await settleSheetAboveTabbar(page);

  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: `${SHOTS}/upload-390-after.png` });
});

test("a camera another app is holding does not cost the shutter for the rest of the sheet", async ({
  page,
}) => {
  // The everyday Android failure: the OS camera app, or a video call, still has
  // the lens. NotReadableError. The installer closes that app and taps again —
  // which only works if the live-preview button is still there to tap. The
  // delay is what leaves room to check the SECOND tap before it fails too.
  await stubCameraFailure(page, "NotReadableError", 1200);
  await useSupabaseFixtures(page, { role: "foreman" });
  await useCaptureStorage(page);
  await stubGeolocationDenied(page);

  await openTheSheet(page);
  await cameraButton(page).click();

  await expect(
    page.getByText("Camera busy — close any other app using it, then tap Use camera again."),
  ).toBeVisible();
  // Still a button, not the hand-off to the phone's camera app — and still the
  // one file input the other specs address by that selector.
  await expect(cameraButton(page)).toBeVisible();
  await expect(cameraInput(page)).toHaveCount(0);
  await expect(page.locator('.jobphoto-actions input[type="file"]')).toHaveCount(1);

  // And a second tap clears the last complaint instead of leaving it under a
  // shutter that is trying again.
  await cameraButton(page).click();
  await expect(page.getByText("Camera busy", { exact: false })).toHaveCount(0);
});

test("a refused camera permission hands the shutter to the phone's camera app", async ({
  page,
}) => {
  // The one failure asking again cannot fix: the browser remembers a no.
  await stubCameraFailure(page, "NotAllowedError");
  await useSupabaseFixtures(page, { role: "foreman" });
  await useCaptureStorage(page);
  await stubGeolocationDenied(page);

  await openTheSheet(page);
  await cameraButton(page).click();

  await expect(page.getByText("Camera unavailable — use Upload files instead.")).toBeVisible();
  await expect(cameraInput(page)).toHaveAttribute("capture", "environment");
  await expect(cameraButton(page)).toHaveCount(0);
  // The upload input still never gets `capture`, even now.
  expect(await uploadInput(page).getAttribute("capture")).toBeNull();
});

test("backing out while the permission prompt is up leaves the camera alone", async ({ page }) => {
  // Tap "Use camera", think better of it, tap "Done" — and the prompt answers
  // afterwards, against a stage nobody is looking at. That answer must not
  // decide anything: the request was cancelled, not refused.
  await stubCameraFailure(page, "NotAllowedError", 1500);
  await useSupabaseFixtures(page, { role: "foreman" });
  await useCaptureStorage(page);
  await stubGeolocationDenied(page);

  await openTheSheet(page);
  await cameraButton(page).click();
  await page
    .getByRole("dialog", { name: "Add job photos" })
    .getByRole("button", { name: "Done" })
    .click();

  // Well past the stubbed answer.
  await page.waitForTimeout(2500);
  await expect(cameraButton(page)).toBeVisible();
  await expect(cameraInput(page)).toHaveCount(0);
  await expect(page.getByText("Camera unavailable", { exact: false })).toHaveCount(0);
  await expect(page.getByText("Camera busy", { exact: false })).toHaveCount(0);
});
