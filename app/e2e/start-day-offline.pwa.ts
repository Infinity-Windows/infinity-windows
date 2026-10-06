import { expect, test } from "@playwright/test";
import { useSupabaseFixtures } from "./support/supabaseFixtures";
import { hideWrongProjectBanner, json, stubGeolocationDenied } from "./support/specHelpers";
import { morningFixtures, OAKRIDGE } from "./support/release1Fixtures";
import { serviceWorkerReady } from "./support/pwa";
import { savedClockPunch } from "./support/savedClockPunch";

// The installed app's worker supplies the shell while the local server refuses
// browser traffic. WebKit's inspector rejects page.reload with setOffline or
// a page-wide route abort before the worker can respond.
test("the owner pilot preserves its saved Start day when an offline reload falls back to Classic", async ({ page, request }) => {
  await request.post("/__pwa-harness/network/online");
  await useSupabaseFixtures(page, { role: "owner", uiDesign: "new" });
  await page.route((url) => /\/rest\/v1\/rpc\/my_redesign_pilot_access(\?|$)/.test(url.href),
    (route) => json(route, true, null));
  await hideWrongProjectBanner(page);
  await stubGeolocationDenied(page);
  const world = await morningFixtures(page, { signed: true, myOpening: true });
  await page.route((url) => /\/rest\/v1\/rpc\/server_now(\?|$)/.test(url.href), (route) => json(route, new Date().toISOString(), null));

  const signal = { dead: false };
  await page.route(/e2efixture\.supabase\.co/, (route) => {
    if (signal.dead) {
      return route.abort("internetdisconnected");
    }
    return route.fallback();
  });

  await page.goto("/");
  await serviceWorkerReady(page);
  const networkProbe = `/__offline-probe/${crypto.randomUUID()}`;
  expect((await request.get(networkProbe)).status(), "the uncached server responds before signal is cut").toBe(404);
  const clock = page.getByTestId("ws-clock");
  await expect(page.getByTestId("ws-start-day")).toBeVisible();
  await expect(clock).toContainText("OAKRIDGE · Oakridge Apartments Bldg C");
  await expect(clock).toContainText("000 — General");

  signal.dead = true;
  await request.post("/__pwa-harness/network/offline");
  await page.getByTestId("ws-start-day").click();
  await expect(clock).toContainText("Clocked in");
  await expect(clock).toContainText("Saved on this phone");
  expect(world.clockIns).toHaveLength(0);
  const beforeReload = await savedClockPunch(page);
  expect(beforeReload).toHaveLength(1);

  await page.reload();
  await serviceWorkerReady(page);
  // A fresh pilot admission cannot be checked during the offline reload. The
  // account-specific gate closes the New screen, while the original punch
  // stays on this phone for the next connected session.
  await expect(page.getByRole("heading", { name: "Current Work" })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("status").filter({ hasText: "Clock 1" })).toBeVisible();
  await expect(clock).toHaveCount(0);
  await expect(page.getByTestId("ws-start-day")).toHaveCount(0);
  expect(world.clockIns).toHaveLength(0);
  expect(await savedClockPunch(page)).toEqual(beforeReload);
  await expect(request.get(networkProbe), "the server refuses uncached requests after the offline reload").rejects.toThrow();
  expect(beforeReload[0].payload.projectId).toBe(OAKRIDGE);
  expect(beforeReload[0].ownerId).toBeTruthy();
});

test.afterEach(async ({ request }) => {
  await request.post("/__pwa-harness/network/online");
});
