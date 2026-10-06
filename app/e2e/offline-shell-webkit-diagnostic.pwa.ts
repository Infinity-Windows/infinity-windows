import { expect, test } from "@playwright/test";
import { serviceWorkerReady, signInButton } from "./support/pwa";

// Diagnostic only: determine whether WebKit can reload an installed Forge
// shell while truly offline. The dev-server route probe cannot do so.
test("diagnostic: installed WebKit shell reopens without a network", async ({ page, context }) => {
  await page.goto("/");
  await expect(signInButton(page)).toBeVisible();
  await serviceWorkerReady(page);
  await context.setOffline(true);
  await page.reload();
  await expect(signInButton(page)).toBeVisible();
  await expect.poll(() => page.evaluate(() => navigator.serviceWorker.controller !== null)).toBe(true);
});
