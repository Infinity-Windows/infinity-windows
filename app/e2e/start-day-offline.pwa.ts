import { expect, test } from "@playwright/test";
import { FIXTURE_SESSION, TEST_USER, useSupabaseFixtures } from "./support/supabaseFixtures";
import { OFFLINE_PILOT_PROOF_KEY } from "../src/lib/design/offlinePilotProof";
import { hideWrongProjectBanner, json, stubGeolocationDenied } from "./support/specHelpers";
import { morningFixtures, OAKRIDGE } from "./support/release1Fixtures";
import { serviceWorkerReady } from "./support/pwa";
import { savedClockPunch } from "./support/savedClockPunch";

// The installed app's worker supplies the shell while the local server refuses
// browser traffic. WebKit's inspector rejects page.reload with setOffline or
// a page-wide route abort before the worker can respond.
test("the owner pilot reopens New with its saved Start day after an offline reload", async ({ page, request }) => {
  await request.post("/__pwa-harness/network/online");
  const loginId = "11111111-1111-4111-8111-111111111111";
  const claims = Buffer.from(JSON.stringify({ sub: TEST_USER.id, session_id: loginId })).toString("base64url");
  await useSupabaseFixtures(page, {
    session: "phone", role: "owner", uiDesign: "new",
    authSession: { ...FIXTURE_SESSION, access_token: `header.${claims}.signature` },
  });
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
  expect(await page.evaluate((key) => localStorage.getItem(key), OFFLINE_PILOT_PROOF_KEY)).toContain(TEST_USER.id);
  const beforeReload = await savedClockPunch(page);
  expect(beforeReload).toHaveLength(1);

  await page.reload();
  await serviceWorkerReady(page);
  // The last server-confirmed, login-bound choice keeps this owner's New
  // screen open. The original clock punch remains local and is not duplicated.
  await expect(clock).toBeVisible({ timeout: 30_000 });
  await expect(clock).toContainText("Clocked in");
  await expect(clock).toContainText("Saved on this phone");
  await expect(page.getByTestId("ws-start-day")).toHaveCount(0);
  expect(world.clockIns).toHaveLength(0);
  expect(await savedClockPunch(page)).toEqual(beforeReload);
  await expect(request.get(networkProbe), "the server refuses uncached requests after the offline reload").rejects.toThrow();
  expect(beforeReload[0].payload.projectId).toBe(OAKRIDGE);
  expect(beforeReload[0].ownerId).toBeTruthy();
});

test("the owner's confirmed Classic choice stays Classic after an offline reload", async ({ page, request }) => {
  await request.post("/__pwa-harness/network/online");
  const live = { ui_design: "new" };
  const claims = Buffer.from(JSON.stringify({
    sub: TEST_USER.id, session_id: "33333333-3333-4333-8333-333333333333",
  })).toString("base64url");
  await useSupabaseFixtures(page, {
    session: "phone", role: "owner", uiDesign: "new",
    authSession: { ...FIXTURE_SESSION, access_token: `header.${claims}.signature` },
    profileOverrides: () => live,
  });
  await page.route((url) => /\/rest\/v1\/rpc\/my_redesign_pilot_access(\?|$)/.test(url.href),
    (route) => json(route, true, null));
  const signal = { dead: false };
  await page.route(/e2efixture\.supabase\.co/, (route) => signal.dead
    ? route.abort("internetdisconnected") : route.fallback());
  await stubGeolocationDenied(page);
  await morningFixtures(page, { signed: true, myOpening: true });
  await page.route((url) => /\/rest\/v1\/rpc\/set_my_ui_design(\?|$)/.test(url.href), (route) => {
    live.ui_design = "classic";
    return json(route, null, null);
  });
  await page.goto("/");
  await serviceWorkerReady(page);
  await expect(page.getByTestId("work-screen")).toBeVisible();
  expect(await page.evaluate((key) => localStorage.getItem(key), OFFLINE_PILOT_PROOF_KEY)).toContain(TEST_USER.id);

  await page.goto("/settings");
  await page.getByRole("button", { name: "Use the classic design" }).click();
  await expect.poll(() => page.evaluate((key) => localStorage.getItem(key), OFFLINE_PILOT_PROOF_KEY)).toBeNull();
  signal.dead = true;
  await request.post("/__pwa-harness/network/offline");
  await page.reload();
  await serviceWorkerReady(page);
  await page.goto("/");
  await expect(page.locator(".clockin-block")).toBeVisible();
  await expect(page.getByTestId("work-screen")).toHaveCount(0);
});

test("an installer who selected New still reloads into Classic without signal", async ({ page, request }) => {
  await request.post("/__pwa-harness/network/online");
  const claims = Buffer.from(JSON.stringify({
    sub: TEST_USER.id, session_id: "44444444-4444-4444-8444-444444444444",
  })).toString("base64url");
  await useSupabaseFixtures(page, {
    session: "phone", role: "installer", uiDesign: "new",
    authSession: { ...FIXTURE_SESSION, access_token: `header.${claims}.signature` },
  });
  await page.route((url) => /\/rest\/v1\/rpc\/my_redesign_pilot_access(\?|$)/.test(url.href),
    (route) => json(route, false, null));
  const signal = { dead: false };
  await page.route(/e2efixture\.supabase\.co/, (route) => signal.dead
    ? route.abort("internetdisconnected") : route.fallback());
  await stubGeolocationDenied(page);
  await morningFixtures(page, { signed: true, myOpening: true });
  await page.goto("/");
  await serviceWorkerReady(page);
  await expect(page.locator(".clockin-block")).toBeVisible();
  await expect(page.getByTestId("work-screen")).toHaveCount(0);

  signal.dead = true;
  await request.post("/__pwa-harness/network/offline");
  await page.reload();
  await serviceWorkerReady(page);
  await expect(page.locator(".clockin-block")).toBeVisible();
  await expect(page.getByTestId("work-screen")).toHaveCount(0);
});

test.afterEach(async ({ request }) => {
  await request.post("/__pwa-harness/network/online");
});
