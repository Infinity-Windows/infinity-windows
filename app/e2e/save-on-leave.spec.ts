// A phone put away a moment after it opened still opens with no signal.
//
// The phone's copy of what the screens last read (the React Query cache in
// localStorage) used to be written only on a one-second timer, and never when
// the page went away. A reload, a close or iOS putting the app to sleep inside
// that second lost the last second of reads; inside the FIRST second after
// opening, that was all of them. Reopened with no signal, the app then had no
// profile to restore and the device lock sat on "Checking device lock…" for
// good. e2e/queued-clock.spec.ts hit it in half its runs (2026-09-24), because
// it reloads about 0.8 s after the landing appears.
//
// This makes that race certain rather than likely: the reload comes the
// moment the landing is up, well inside the timer's first second, so only a
// write made when the page is put away can have saved anything. The dead zone
// is built the way queued-clock.spec.ts builds it — every Supabase data call
// refused outright, the app's own files passed through so a reload works with
// the context offline, and the refusals counted so a run where the app quietly
// reached the server cannot pass.

import { expect, test } from "@playwright/test";
import { useSupabaseFixtures } from "./support/supabaseFixtures";
import { hideWrongProjectBanner, json, stubGeolocationDenied } from "./support/specHelpers";

const BLACK22 = "ebf64f94-0413-4434-aeb3-1aff228fb5b3";
const GENERAL = "11111111-aaaa-4aaa-8aaa-111111111111";

test.use({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });

test("an app reloaded a moment after it opened still opens with no signal, from the copy it saved on the way out", async ({
  page,
  context,
}) => {
  await useSupabaseFixtures(page, { role: "installer" });
  await hideWrongProjectBanner(page);
  await stubGeolocationDenied(page);

  // What the phone had saved at the instant each page started, before any of
  // the app's own code ran — the copy a reopened app has to work from.
  await page.addInitScript(() => {
    (window as unknown as { __savedAtStart: string | null }).__savedAtStart =
      window.localStorage.getItem("wops-query-cache");
  });

  // An installer with no shift open and no talk today: the plain landing with
  // Start clock (the same answers queued-clock.spec.ts gives).
  await page.route("**/rest/v1/safety_talks**", (r) => {
    const accept = r.request().headers()["accept"] ?? "";
    return accept.includes("pgrst.object") ? json(r, null, 0) : json(r, [], 0);
  });
  await page.route("**/rest/v1/cost_codes**", (r) =>
    json(r, [{ id: GENERAL, code: "000", label: "General", description: null, active: true, sort_order: 5, is_general: true }], 1),
  );
  await page.route("**/rest/v1/time_shifts**", (r) => {
    const url = new URL(r.request().url());
    if ((url.searchParams.get("status") ?? "").startsWith("in.")) return json(r, [], 0);
    return json(r, [{ project_id: BLACK22, cost_code_id: GENERAL, clock_in_at: new Date(Date.now() - 26 * 3600_000).toISOString(), projects: { job_code: "BLACK22", name: "Black Desert" } }], 1);
  });
  await page.route(
    (url) => /\/rest\/v1\/rpc\/server_now(\?|$)/.test(url.href),
    (r) => json(r, new Date().toISOString(), null),
  );

  // The dead zone, registered last so it wins while the signal is off.
  let dead = false;
  let refused = 0;
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.host.startsWith("localhost")) {
      if (!dead) return route.fallback();
      try {
        await route.fulfill({ response: await route.fetch() });
      } catch {
        await route.abort();
      }
      return;
    }
    if (dead && /\/(rest|storage|functions)\/v1\//.test(url.pathname)) {
      refused += 1;
      return route.abort("internetdisconnected");
    }
    return route.fallback();
  });

  await page.goto("/");
  const start = page.locator(".clockin-block .clock-btn.primary.big");
  await expect(start).toHaveText(/Start clock/);

  // Signal gone, and the app reloaded straight away.
  dead = true;
  await context.setOffline(true);
  await page.reload();

  // The copy was on the phone before the reloaded app's first line ran…
  const saved = await page.evaluate(
    () => (window as unknown as { __savedAtStart: string | null }).__savedAtStart,
  );
  expect(saved, "nothing was saved when the page went away").toContain('"myProfile"');

  // …so the app opens from it, past the device lock. The real tab bar is the
  // proof: it is drawn inside the lock, and only once the profile is known (a
  // bare "no lock on screen" would also pass during the "Connecting…" splash).
  await expect(page.locator('nav.tabbar[aria-label="Main"]:not([aria-busy])')).toBeVisible({ timeout: 10_000 });
  await expect(page.locator(".pin-gate")).toHaveCount(0);
  expect(refused, "nothing was refused — the app was never cut off").toBeGreaterThan(0);
});
