import { expect, test } from "@playwright/test";
import { serveBuild, signInButton } from "./support/pwa";

test("a cancelled app entry recovers the empty screen once", async ({ page, request }) => {
  await serveBuild(request, "new");
  let entryRequests = 0;
  await page.route(/\/assets\/index-[^/]+\.js$/, (route) => {
    entryRequests += 1;
    return entryRequests === 1 ? route.abort("failed") : route.continue();
  });

  await page.goto("/");
  await expect(signInButton(page)).toBeVisible({ timeout: 30_000 });
  expect(entryRequests).toBe(2);
});

test("a repeatedly broken entry offers a retry instead of looping forever", async ({ page, request }) => {
  await serveBuild(request, "new");
  let entryRequests = 0;
  await page.route(/\/assets\/index-[^/]+\.js$/, (route) => {
    entryRequests += 1;
    return route.abort("failed");
  });

  await page.goto("/");
  await expect(page.getByRole("button", { name: "Try again" })).toBeVisible({ timeout: 30_000 });
  expect(entryRequests).toBe(2);
});

test("an already started app is not reloaded if its root briefly empties", async ({ page, request }) => {
  await serveBuild(request, "new");
  let loads = 0;
  page.on("load", () => { loads += 1; });

  await page.goto("/");
  await expect(signInButton(page)).toBeVisible();
  await page.evaluate(() => document.getElementById("root")?.replaceChildren());
  await page.waitForTimeout(9_000);

  expect(loads).toBe(1);
});
