import { expect, test, type Page } from "@playwright/test";
import { useSupabaseFixtures } from "./support/supabaseFixtures";
import { hideWrongProjectBanner, json, stubGeolocationDenied } from "./support/specHelpers";
import { morningFixtures, OAKRIDGE } from "./support/release1Fixtures";
import { serviceWorkerReady } from "./support/pwa";

async function savedClockPunch(page: Page) {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("wops-write-outbox");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      const rows = await new Promise<Array<{ meta: string }>>((resolve, reject) => {
        const request = db.transaction("entries", "readonly").objectStore("entries").getAll();
        request.onsuccess = () => resolve(request.result as Array<{ meta: string }>);
        request.onerror = () => reject(request.error);
      });
      return rows.map((row) => JSON.parse(row.meta) as {
        id: string;
        op: string;
        ownerId: string;
        payload: { clientId: string; tappedAt: string; projectId: string };
      }).filter((row) => row.op === "clock_in").map((row) => ({
        id: row.id,
        ownerId: row.ownerId,
        payload: {
          clientId: row.payload.clientId,
          tappedAt: row.payload.tappedAt,
          projectId: row.payload.projectId,
        },
      }));
    } finally {
      db.close();
    }
  });
}

// The installed app's worker supplies the shell while the local server refuses
// browser traffic. WebKit's inspector rejects page.reload with setOffline or
// a page-wide route abort before the worker can respond.
test("an installed phone keeps its saved Start day through a server-outage reload and sends one original punch", async ({ page, request }) => {
  await request.post("/__pwa-harness/network/online");
  await useSupabaseFixtures(page, { role: "installer", uiDesign: "new" });
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
  const tappedAt = Date.now();
  await page.getByTestId("ws-start-day").click();
  await expect(clock).toContainText("Clocked in");
  await expect(clock).toContainText("Saved on this phone");
  expect(world.clockIns).toHaveLength(0);
  const beforeReload = await savedClockPunch(page);
  expect(beforeReload).toHaveLength(1);

  await page.reload();
  await serviceWorkerReady(page);
  await expect(clock).toContainText("Clocked in", { timeout: 30_000 });
  await expect(clock).toContainText("Saved on this phone");
  await expect(page.getByTestId("ws-start-day")).toHaveCount(0);
  expect(world.clockIns).toHaveLength(0);
  expect(await savedClockPunch(page)).toEqual(beforeReload);
  await expect(request.get(networkProbe), "the server refuses uncached requests after the offline reload").rejects.toThrow();

  signal.dead = false;
  await request.post("/__pwa-harness/network/online");
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect.poll(() => world.clockIns.length).toBe(1);
  expect(world.clockIns[0].p_project_id).toBe(OAKRIDGE);
  expect(world.clockIns[0].p_client_id).toBe(beforeReload[0].payload.clientId);
  expect(world.clockIns[0].p_tapped_at).toBe(beforeReload[0].payload.tappedAt);
  expect(beforeReload[0].payload.projectId).toBe(OAKRIDGE);
  expect(beforeReload[0].ownerId).toBeTruthy();
  const tapped = new Date(String(world.clockIns[0].p_tapped_at)).getTime();
  expect(Math.abs(tapped - tappedAt)).toBeLessThan(5_000);
  await expect(clock).not.toContainText("Saved on this phone");
  await expect(page.getByTestId("ws-start-day")).toHaveCount(0);
  await page.waitForTimeout(1_500);
  expect(world.clockIns).toHaveLength(1);
});

test.afterEach(async ({ request }) => {
  await request.post("/__pwa-harness/network/online");
});
