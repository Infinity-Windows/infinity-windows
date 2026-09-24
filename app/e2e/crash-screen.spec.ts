// The crash screen, driven by a real crash, and the silence that surrounds it.
//
// The crash is not simulated: the phone loses the connection halfway through
// opening a screen and the code for it never arrives. That is a Tuesday on a
// jobsite, and it is what the ErrorBoundary is there for. What has to hold:
//
//   - the screen says what happened in words, and gives the crew the
//     five-character code somebody can read out over the phone,
//   - Try again is there and works, so nobody is forced to reload and lose the
//     screen they were on, and
//   - WITH NO DSN CONFIGURED — which is the state this ships in, and the state
//     the dev server here runs in — not one request leaves for Sentry. Not a
//     failed one, not a queued one, not the SDK's own chunk.
//
// That last assertion is the whole safety case for shipping this switched off,
// so it is made against the network log rather than against the source.

import { expect, test, type Page } from "@playwright/test";
import { useSupabaseFixtures } from "./support/supabaseFixtures";

test.use({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });

/**
 * Anything that would be a crash report LEAVING this phone.
 *
 * Off-origin only, deliberately: in dev the app's own gate module is served as
 * /src/lib/monitoring/sentry.ts, and matching that would make this test pass by
 * accident on a name rather than on a destination. What must not happen is a
 * request to somebody else's server.
 */
function offOrigin(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host !== "localhost" && host !== "127.0.0.1" && host !== "::1";
  } catch {
    return false;
  }
}

const MONITORING = /sentry|ingest\.|\/envelope|\/store\//i;

function reportsSent(urls: string[]): string[] {
  return urls.filter((u) => offOrigin(u) && MONITORING.test(u));
}

function watchNetwork(page: Page): string[] {
  const seen: string[] = [];
  page.on("request", (r) => seen.push(r.url()));
  return seen;
}

test("a screen that fails to load shows the code and Try again, and tells nobody else", async ({
  page,
}) => {
  const requests = watchNetwork(page);
  await useSupabaseFixtures(page, { role: "supervisor" });

  // The Studio is loaded on demand. Cut the wire it comes down and the import
  // rejects, which lands in the ErrorBoundary exactly like a render crash.
  let cut = true;
  await page.route("**/StudioList*", (route) =>
    cut ? route.abort("failed") : route.continue(),
  );

  await page.goto("/studio");

  const crash = page.locator(".page", { hasText: "Something went wrong" });
  await expect(crash).toBeVisible();
  await expect(page.getByText("still here")).toBeVisible();

  // Crockford base32, five characters, no I/L/O/U — the alphabet that survives
  // being read out over a bad line and typed back by whoever answered.
  const code = await crash.locator("strong").first().textContent();
  expect(code?.trim()).toMatch(/^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{5}$/);

  // Try again now actually brings Studio back (K0.7) — but for THIS failure
  // (a REJECTED import, not merely a slow one) that takes a real reload, and
  // there is no way around that: the browser's own module registry remembers
  // a failed fetch for the life of the page, the same reason production's
  // vite:preloadError handler (preloadRecovery.ts) reloads instead of
  // retrying softly. A plain re-render — clearing `error` and showing
  // `children` again — would just hit that same remembered failure; only a
  // fresh document gets a fresh module registry. So ErrorBoundary's Try Again
  // reloads specifically when the caught error is a chunk-load error (never
  // over unsaved work — proved directly in ErrorBoundary.test.tsx, which also
  // pins the ORIGINAL "no reload" guarantee for an ordinary crash that isn't
  // a chunk-load failure at all). `__stillHere` is expected to be gone
  // afterwards — that is this reload actually happening, not a regression.
  //
  // (A chunk that is merely SLOW rather than rejected recovers WITHOUT a
  // reload, via lazyRoute.tsx's own retry — see lazy-route-hang.spec.ts.)
  cut = false;
  const tryAgain = page.getByRole("button", { name: "Try again" });
  await expect(tryAgain).toBeEnabled();
  await tryAgain.click();
  await expect(page.getByRole("heading", { name: "Studio" })).toBeVisible();

  // Nothing about that crash went anywhere near a monitoring host.
  expect(reportsSent(requests)).toEqual([]);
});

test("with no DSN the monitoring code is never even fetched", async ({ page }) => {
  const requests = watchNetwork(page);
  await useSupabaseFixtures(page, { role: "installer" });
  await page.goto("/");
  await page.waitForLoadState("networkidle");

  // The SDK sits behind a dynamic import, so an unset DSN means the chunk is
  // never requested at all — not merely loaded and left idle. This is what
  // keeps the feature free for a phone on a bad connection until somebody
  // decides to turn it on.
  const sdk = requests.filter((u) => /@sentry|node_modules.*sentry/i.test(u));
  expect(sdk).toEqual([]);
  expect(reportsSent(requests)).toEqual([]);
});
