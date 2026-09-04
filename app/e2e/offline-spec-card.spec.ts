// The spec sheet has to be in the phone's pocket (installer research item 2).
//
// The unit sheet's spec card is the paperwork somebody reads standing at the
// opening: size, style, glass, colour, the operation. It comes from the
// ["markSpecs", projectId] query, and until 2026-09-04 that key was not in the
// offline cache list — so after a reload with no signal the card was simply not
// there, and the "no spec sheet for this mark" notice is itself gated on the
// spec list being non-empty, so the installer got silence instead of a reason
// and guessed.
//
// This is the whole promise in one test: read it with signal, cut the signal,
// reload, and the card is still there.
//
// Three things about how the dead zone is made here, because none of them are
// obvious and all three were learned the hard way writing it:
//
//   - A Playwright route handler runs BEFORE the network, so
//     `context.setOffline(true)` alone would not stop the fixture router from
//     answering and the test would pass for the wrong reason. Every Supabase
//     call is therefore aborted outright, and the test counts the refusals, so
//     a run where the app quietly reached the network again cannot pass.
//   - With the context offline the DOCUMENT cannot load either, so a reload
//     fails outright. In the field that is the service worker's job; a Vite
//     dev server has no service worker (vite.config.ts, devOptions.enabled =
//     false). So the app's own files are passed through by `route.fetch()`,
//     which is performed by the Playwright process rather than the browser and
//     so still works while the browser is offline. Nothing of Supabase's comes
//     through that door — those URLs fall through to the aborts.
//   - `navigator.onLine` is deliberately not asserted: under route
//     interception the renderer still reports itself online, so that would be
//     a test of Playwright rather than of the app. The refused reads are the
//     honest evidence.
import { expect, test, type Page } from "@playwright/test";
import { jobFixtures, openingsFor, useSupabaseFixtures } from "./support/supabaseFixtures";

const BLACK22 = jobFixtures().find((j) => j.jobCode === "BLACK22")!;
type Json = Record<string, unknown>;
const REAL_OPENINGS = openingsFor(BLACK22.projectId) as unknown as Json[];

/** Fixture rows are read as plain records and cast at the point of use — the
 * same idiom opening-sheet.spec.ts uses. */
function str(v: unknown): string {
  return v as string;
}

/** `getOpening` reads one row by `id=eq.`; the shared router only answers the
 * by-project form, so the single-row read is served here (same helper shape as
 * opening-sheet.spec.ts). Registered after the fixtures so it wins. */
async function routeOpening(page: Page, row: Json) {
  await page.route(
    (url) =>
      url.pathname.includes("/rest/v1/project_openings") &&
      (url.searchParams.get("id") ?? "").startsWith("eq."),
    (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: { "content-range": "0-0/1" },
        body: JSON.stringify([row]),
      }),
  );
}

/**
 * Cut every line to Supabase, and keep the app's own files coming.
 *
 * Registered last, so these win over the fixture router. Returns the list of
 * refused paths so the test can prove the screen was not served by anybody.
 */
async function goToTheDeadZone(page: Page): Promise<string[]> {
  const refused: string[] = [];
  for (const pattern of ["**/rest/v1/**", "**/storage/v1/**", "**/functions/v1/**"]) {
    await page.route(pattern, (route) => {
      refused.push(new URL(route.request().url()).pathname);
      return route.abort("internetdisconnected");
    });
  }
  // The app shell only (see the note at the top). Anything not served by the
  // dev server falls through to the aborts above.
  await page.route("**/*", async (route) => {
    if (!new URL(route.request().url()).host.startsWith("localhost")) {
      return route.fallback();
    }
    try {
      await route.fulfill({ response: await route.fetch() });
    } catch {
      await route.abort();
    }
  });
  return refused;
}

test("the spec card is still on the sheet after an offline reload", async ({
  page,
  context,
}) => {
  await useSupabaseFixtures(page, { role: "installer" });
  // BLACK22's 1-1: a real opening whose real mark spec carries a style, a
  // glass build-up, a colour and a size — the card an installer reads.
  const o: Json = {
    ...(REAL_OPENINGS[0] as Json),
    status: "assigned",
    needs_flashing: false,
  };
  await routeOpening(page, o);

  await page.goto(`/projects/${str(o.project_id)}/opening/${str(o.id)}`);

  // With signal: the card is there, on the mark the opening code resolves to
  // ("1-1" → mark 1).
  await expect(page.getByText("Spec · mark #1", { exact: true })).toBeVisible();

  // The cache reaches localStorage on a throttle, so wait for the specs to be
  // on the device before cutting the signal — otherwise this would be a test
  // of the throttle, not of the cache.
  await expect
    .poll(
      () =>
        page.evaluate(() =>
          (window.localStorage.getItem("wops-query-cache") ?? "").includes(
            "markSpecs",
          ),
        ),
      { timeout: 20_000, message: "the query cache never reached localStorage" },
    )
    .toBe(true);

  const refused = await goToTheDeadZone(page);
  await context.setOffline(true);
  await page.reload();

  // The whole point: no signal, a fresh page, and the installer can still read
  // what they are supposed to be installing.
  await expect(page.getByText("Spec · mark #1", { exact: true })).toBeVisible();
  await expect(page.getByText("Clay(Aluminum profile Color)")).toBeVisible();
  await expect(page.getByText("1'11½\" × 7'5½\" (23½\" × 89½\")")).toBeVisible();

  // …and it came off the phone, not off the wire. Everything the app asked
  // Supabase for during that load was refused (profiles, the PIN check, the
  // partner check, the photo lists — around twenty calls). The specs read is
  // not among them, and that is the point rather than a gap: the restored copy
  // is still inside its stale time, so the sheet never asks at all.
  expect(
    refused.length,
    "nothing was refused — the app was not actually cut off, so this proves nothing",
  ).toBeGreaterThan(0);
});
