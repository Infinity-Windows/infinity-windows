import { expect, test } from "@playwright/test";
import { useSupabaseFixtures } from "./support/supabaseFixtures";
import { hideWrongProjectBanner, json, stubGeolocationDenied } from "./support/specHelpers";
import { morningFixtures, OAKRIDGE } from "./support/release1Fixtures";
import { savedClockPunch } from "./support/savedClockPunch";

// Vite keeps serving the shell so WebKit can reload while fixture database
// requests fail. The installed-shell outage is covered separately by the PWA
// spec; Playwright WebKit cannot combine setOffline(true) with page.reload().
test("a refused Start day request survives reload and sends its original punch once", async ({ page }) => {
  await useSupabaseFixtures(page, { role: "installer", uiDesign: "new" });
  await hideWrongProjectBanner(page);
  await stubGeolocationDenied(page);
  const world = await morningFixtures(page, { signed: true, myOpening: true });
  await page.route((url) => /\/rest\/v1\/rpc\/server_now(\?|$)/.test(url.href), (route) => json(route, new Date().toISOString(), null));

  const signal = { dead: false, refused: 0 };
  await page.route(/e2efixture\.supabase\.co/, (route) => {
    if (signal.dead) {
      signal.refused += 1;
      return route.abort("internetdisconnected");
    }
    return route.fallback();
  });

  await page.goto("/");
  const clock = page.getByTestId("ws-clock");
  await expect(page.getByTestId("ws-start-day")).toBeVisible();
  await expect(clock).toContainText("OAKRIDGE · Oakridge Apartments Bldg C");
  await expect(clock).toContainText("000 — General");

  signal.dead = true;
  const tappedAt = Date.now();
  await page.getByTestId("ws-start-day").click();
  await expect(clock).toContainText("Clocked in");
  await expect(clock).toContainText("Saved on this phone");
  expect(world.clockIns).toHaveLength(0);
  const beforeReload = await savedClockPunch(page);
  expect(beforeReload).toHaveLength(1);

  await page.reload();
  await expect(clock).toContainText("Clocked in", { timeout: 30_000 });
  await expect(clock).toContainText("Saved on this phone");
  await expect(page.getByTestId("ws-start-day")).toHaveCount(0);
  expect(world.clockIns).toHaveLength(0);
  expect(await savedClockPunch(page)).toEqual(beforeReload);
  expect(signal.refused, "the database request was actually refused").toBeGreaterThan(0);

  signal.dead = false;
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect.poll(() => world.clockIns.length).toBe(1);
  expect(world.clockIns[0].p_project_id).toBe(OAKRIDGE);
  expect(world.clockIns[0].p_client_id).toBe(beforeReload[0].payload.clientId);
  expect(world.clockIns[0].p_tapped_at).toBe(beforeReload[0].payload.tappedAt);
  const tapped = new Date(String(world.clockIns[0].p_tapped_at)).getTime();
  expect(Math.abs(tapped - tappedAt)).toBeLessThan(5_000);
  await expect(clock).not.toContainText("Saved on this phone");
  await expect(page.getByTestId("ws-start-day")).toHaveCount(0);
  await page.waitForTimeout(1_500);
  expect(world.clockIns).toHaveLength(1);
});
