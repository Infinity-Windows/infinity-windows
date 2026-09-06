// The small helpers every spec kept re-typing.
//
// These six were copied by hand into spec after spec — `json` alone had
// thirty-seven copies — and copies drift: a fix made in one file is a fix the
// other thirty-six never got. `hideWrongProjectBanner` is the one that already
// happened; only the newest copy carried the note about why the style tag has
// to wait for DOMContentLoaded, and the older copies looked like they could be
// simplified back into the bug. One home, one fix.
//
// Fixture DATA still belongs to its own spec — the ids, rows and models a
// screen is measured against are the test, not the plumbing. Only the plumbing
// lives here.

import type { Page, Route } from "@playwright/test";

/**
 * Answer a Supabase REST/RPC route with JSON.
 *
 * `rows` writes the `content-range` header PostgREST sends, which is where
 * supabase-js reads a requested count from. Pass `null` for no header at all —
 * a few specs answer plain RPCs that were never counted, and adding a range
 * they never had would be a change, not a cleanup.
 */
export function json(route: Route, body: unknown, rows: number | null = 0) {
  return route.fulfill({
    status: 200,
    contentType: "application/json",
    ...(rows === null
      ? {}
      : { headers: { "content-range": `0-${Math.max(0, rows - 1)}/${rows}` } }),
    body: JSON.stringify(body),
  });
}

/**
 * A local calendar date, `offsetDays` from today: `dayISO(0)` is today,
 * `dayISO(-3)` three days ago, `dayISO(2)` the day after tomorrow.
 *
 * Local, not UTC, on purpose — these dates are compared against what the app
 * renders for a person standing in their own timezone.
 */
export function dayISO(offsetDays: number): string {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * Fail geolocation immediately (PERMISSION_DENIED) so the photo-capture
 * pipeline's soft GPS lookup never waits one out. Headless Chromium has no UI
 * to grant or deny the real prompt, so this makes the outcome deterministic
 * instead of relying on it.
 *
 * `watch` (the default) stubs BOTH doors: the one-shot lookup a cold shutter
 * falls back to, and the position watch a capture screen starts on mount
 * (lib/geoWatch.ts). Pass `watch: false` for the flows that only ever ask
 * once — leaving the real `watchPosition` alone there is the behaviour those
 * specs were written against, so it stays available rather than being
 * quietly upgraded.
 */
export async function stubGeolocationDenied(
  page: Page,
  { watch = true }: { watch?: boolean } = {},
) {
  await page.addInitScript(
    (stubWatch: boolean) => {
      if (!navigator.geolocation) return;
      navigator.geolocation.getCurrentPosition = (_ok, err) => {
        err?.({ code: 1, message: "denied" } as GeolocationPositionError);
      };
      if (!stubWatch) return;
      navigator.geolocation.watchPosition = (_ok, err) => {
        err?.({
          code: 1,
          message: "denied",
          PERMISSION_DENIED: 1,
        } as GeolocationPositionError);
        return 1;
      };
      navigator.geolocation.clearWatch = () => {};
    },
    watch,
  );
}

/**
 * A 1x1 PNG — the smallest thing that is still a real image to upload.
 *
 * It has to be a REAL image, not just bytes with a .png name: the capture
 * pipeline decodes what it is handed (createImageBitmap / Image) and a fake
 * would fail there before any upload happened. It also stands in for what a
 * signed thumbnail URL resolves to — the fixture's storage handler answers
 * 404, and a broken <img> would sit in every screenshot the spec takes.
 */
export const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

/** That PNG shaped for `setInputFiles`. */
export function pngFile(name: string) {
  return {
    name,
    mimeType: "image/png",
    buffer: Buffer.from(TINY_PNG_BASE64, "base64"),
  };
}

/**
 * Hide the red "Wrong database" banner.
 *
 * The e2e fixture host (playwright.config.ts) legitimately and correctly
 * mismatches the real Supabase project, so WrongProjectBanner's real,
 * non-dismissable alert (position: fixed, near the top of the viewport,
 * z-index 90 — above a compact page's own header) renders on every page in
 * this suite. It never appears in production. An initScript, not a
 * post-navigation style tag: it has to exist before the app's own first
 * paint, or the banner blocks a click before this script would get a chance
 * to run.
 *
 * Deferred to DOMContentLoaded, not appended immediately: an initScript runs
 * at document_start, before the parser has created <html>/<head> —
 * document.documentElement is still null there, so an immediate appendChild
 * throws (silently, since Playwright doesn't surface an initScript's own
 * exceptions) and the banner is never actually hidden.
 */
export async function hideWrongProjectBanner(page: Page) {
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

/** Read one field off a fixture row as a string. */
export function str(v: unknown): string {
  return v as string;
}
