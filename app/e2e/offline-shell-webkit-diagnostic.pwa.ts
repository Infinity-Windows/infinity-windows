import { expect } from "@playwright/test";
import { test } from "./support/nativeBlobTest";
import { serviceWorkerReady, signInButton } from "./support/pwa";

// Diagnostic only: determine whether WebKit can reload an installed Forge
// shell while truly offline in a persistent profile like an installed phone.
// The ephemeral WebKit case failed before any new document started in CI.
test.use({ nativeBlobProfile: true });

test("diagnostic: persistent installed WebKit shell reopens without a network", async ({ page, context }) => {
  await page.goto("/");
  await expect(signInButton(page)).toBeVisible();
  await serviceWorkerReady(page);
  await context.setOffline(true);
  await page.reload();
  await expect(signInButton(page)).toBeVisible();
  await expect.poll(() => page.evaluate(() => navigator.serviceWorker.controller !== null)).toBe(true);
});
