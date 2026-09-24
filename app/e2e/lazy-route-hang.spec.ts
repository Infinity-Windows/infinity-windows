// K0.7: a screen loaded on demand cannot spin forever on bad signal.
//
// /studio is reused from crash-screen.spec.ts's own pattern (`**/StudioList*`
// is already proven to intercept this dev-server's dynamic import cleanly);
// that spec covers the REJECTED-import outcome (the request fails outright).
// This file covers the other two outcomes lazyRoute.tsx (K0.7) now handles —
// a chunk that is merely SLOW, and one that never answers at all — using the
// reusable bad-signal helpers in support/badSignal.ts, built here for reuse by
// later releases' clock and photo scenarios (spec K-X1).
//
// The 20-second deadline itself is shortened through the test hook
// lib/pwa/lazyRoute.ts reads at runtime (`window.__forgeLazyRouteTimeoutMs`,
// harmless in prod — see that file's comment), set via `page.addInitScript` so
// it exists before the app's own first paint.

import { expect, test } from "@playwright/test";
import { useSupabaseFixtures } from "./support/supabaseFixtures";
import { delayRoute, hangRoute } from "./support/badSignal";

test.use({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });

const SHORT_TIMEOUT_MS = 1000;

async function shortenLazyRouteTimeout(page: import("@playwright/test").Page) {
  await page.addInitScript((ms) => {
    (window as unknown as Record<string, unknown>).__forgeLazyRouteTimeoutMs = ms;
  }, SHORT_TIMEOUT_MS);
}

test("a slow chunk shows the hung message after the deadline, and Try again succeeds", async ({
  page,
}) => {
  await shortenLazyRouteTimeout(page);
  await useSupabaseFixtures(page, { role: "supervisor" });

  // Slower than the shortened deadline, so the message has to show up before
  // the chunk itself ever arrives — but it DOES arrive, eventually, same as a
  // slow chunk on real bad signal usually does.
  await delayRoute(page, "**/StudioList*", 4000);

  await page.goto("/studio");

  const hung = page.getByText("This didn't load on this signal.");
  await expect(hung).toBeVisible({ timeout: SHORT_TIMEOUT_MS + 3000 });
  const tryAgain = page.getByRole("button", { name: "Try again" });
  await expect(tryAgain).toBeVisible();
  await expect(page.getByRole("link", { name: "Go to Work" })).toHaveAttribute("href", "/");

  await tryAgain.click();
  // The retry gets its own fresh clock — it must not show the hung message
  // again the instant it's clicked, only the loading state.
  await expect(hung).not.toBeVisible();

  // Whether the retry's import() rides the same still-in-flight request or a
  // fresh one, the chunk lands within its 4-second delay either way.
  await expect(page.getByRole("heading", { name: "Studio" })).toBeVisible({ timeout: 8000 });
});

test("a chunk that never answers still leaves a way out: Go to Work", async ({ page }) => {
  await shortenLazyRouteTimeout(page);
  await useSupabaseFixtures(page, { role: "supervisor" });

  // Never fulfilled, continued or aborted — the request just sits there, same
  // as a stalled connection with no error to catch.
  await hangRoute(page, "**/StudioList*");

  await page.goto("/studio");

  const hung = page.getByText("This didn't load on this signal.");
  await expect(hung).toBeVisible({ timeout: SHORT_TIMEOUT_MS + 3000 });

  // Try again cannot make this one succeed — the browser's own module map
  // dedupes a second import() against the still-pending first (see
  // lazyRoute.ts's header) — so the honest escape hatch is Go to Work, which
  // needs no chunk at all: My Work / Home / Heartbeat ship in the entry.
  await page.getByRole("link", { name: "Go to Work" }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole("heading", { name: "Heartbeat" })).toBeVisible();
  await expect(hung).not.toBeVisible();
});
