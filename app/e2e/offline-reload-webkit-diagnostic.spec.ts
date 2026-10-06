import { expect, test, type Page, type Route } from "@playwright/test";

// Diagnostic only. This isolates WebKit's offline main-resource navigation from
// Forge and from the Start day fixtures. It is not a release-acceptance test.
test.use({ trace: "on" });

async function observeReload(page: Page, path: string) {
  await expect(page.locator("h1")).toHaveText("Offline reload probe");
  await page.context().setOffline(true);
  let error: string | null = null;
  try {
    await page.reload();
  } catch (cause) {
    error = cause instanceof Error ? cause.message : String(cause);
  }
  const headingAfter = await page.locator("h1").textContent().catch(() => null);
  const result = { path, error, headingAfter };
  await test.info().attach("offline-reload-result", {
    body: Buffer.from(JSON.stringify(result, null, 2)),
    contentType: "application/json",
  });
  console.log(`OFFLINE_RELOAD_PROBE ${JSON.stringify(result)}`);
  // The result is evidence, not a pass for the original Start day gate.
}

test("diagnostic: static route fulfilled during an offline WebKit reload", async ({ page }) => {
  let routeCalls = 0;
  await page.route("**/offline-static-probe", async (route) => {
    routeCalls += 1;
    await route.fulfill({
      status: 200,
      contentType: "text/html",
      body: "<!doctype html><title>Probe</title><h1>Offline reload probe</h1>",
    });
  });
  await page.goto("/offline-static-probe");
  await observeReload(page, "static");
  console.log(`OFFLINE_RELOAD_ROUTE_CALLS static=${routeCalls}`);
});

test("diagnostic: route.fetch fulfilled during an offline WebKit reload", async ({ page }) => {
  let routeCalls = 0;
  const statuses: number[] = [];
  const routeErrors: string[] = [];
  await page.route("**/offline-fetch-probe", async (route: Route) => {
    routeCalls += 1;
    try {
      const response = await route.fetch();
      statuses.push(response.status());
      await route.fulfill({
        response,
        status: 200,
        contentType: "text/html",
        body: "<!doctype html><title>Probe</title><h1>Offline reload probe</h1>",
      });
    } catch (cause) {
      routeErrors.push(cause instanceof Error ? cause.message : String(cause));
      await route.abort();
    }
  });
  await page.goto("/offline-fetch-probe");
  await observeReload(page, "route.fetch");
  console.log(`OFFLINE_RELOAD_ROUTE_CALLS fetch=${routeCalls} statuses=${JSON.stringify(statuses)} errors=${JSON.stringify(routeErrors)}`);
});
