import { expect, test as base, type BrowserContext } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// WebKit's default ephemeral context can refuse the native PNG/PDF Blob and
// IndexedDB operations a few cases depend on. Only the cases reviewed for it
// opt in with `test.use({ nativeBlobProfile: true })`; they then get a fresh,
// empty, normal (persistent) WebKit profile for that one test. Chromium, and
// every WebKit test that does not opt in, get the original `context` untouched.
//
// Options are passed explicitly from the effective public fixtures, mirroring
// how Playwright builds the default context, so a test.use override (viewport
// 375x667, deviceScaleFactor 2, locale, permissions, ...) still wins. Playwright
// 1.62 also merges the same combined options into any context created during a
// test and records it for tracing (runBeforeCreateBrowserContext /
// runAfterCreateBrowserContext, both called by launchPersistentContext), so the
// trace is not started or stopped here. Anything this path cannot carry over
// faithfully fails loudly rather than being dropped.
export interface NativeBlobOptions {
  nativeBlobProfile: boolean;
}

export const test = base.extend<NativeBlobOptions>({
  nativeBlobProfile: [false, { option: true }],

  context: async ({
    context,
    nativeBlobProfile,
    browserName,
    playwright,
    connectOptions,
    video,
    headless,
    channel,
    launchOptions,
    actionTimeout,
    navigationTimeout,
    contextOptions,
    acceptDownloads,
    bypassCSP,
    colorScheme,
    deviceScaleFactor,
    extraHTTPHeaders,
    geolocation,
    hasTouch,
    httpCredentials,
    ignoreHTTPSErrors,
    isMobile,
    javaScriptEnabled,
    locale,
    offline,
    permissions,
    proxy,
    storageState,
    clientCertificates,
    timezoneId,
    userAgent,
    viewport,
    baseURL,
    serviceWorkers,
  }, runFixture, testInfo) => {
    if (!nativeBlobProfile || browserName !== "webkit") {
      await runFixture(context);
      return;
    }
    // The original `context` above is still created for an opted WebKit test
    // and simply goes unused; it is closed by Playwright as usual.
    if (connectOptions) {
      throw new Error("nativeBlobProfile needs a local WebKit launch; it does not support connectOptions.");
    }
    const videoMode = typeof video === "string" ? video : video.mode;
    if (videoMode !== "off") {
      throw new Error(`nativeBlobProfile does not record video; video is "${videoMode}".`);
    }
    if (clientCertificates?.length) {
      throw new Error("nativeBlobProfile does not carry clientCertificates over.");
    }

    // Same precedence as Playwright's own default context: contextOptions
    // first, then every individual option that is set.
    const explicit = {
      acceptDownloads, bypassCSP, colorScheme, deviceScaleFactor, extraHTTPHeaders,
      geolocation, hasTouch, httpCredentials, ignoreHTTPSErrors, isMobile,
      javaScriptEnabled, locale, offline, permissions, proxy, timezoneId,
      userAgent, viewport, baseURL, serviceWorkers,
    };
    const contextSettings: Record<string, unknown> = { ...contextOptions };
    for (const [key, value] of Object.entries(explicit)) {
      if (value !== undefined) contextSettings[key] = value;
    }
    // Storage state is applied after launch through the public setter. The key
    // stays present (as undefined) so the automatic merge cannot re-add it.
    contextSettings.storageState = undefined;

    let profileDir: string | undefined;
    let persistent: BrowserContext | undefined;
    try {
      profileDir = await mkdtemp(join(tmpdir(), "forge-native-blob-webkit-"));
      persistent = await playwright.webkit.launchPersistentContext(profileDir, {
        ...launchOptions,
        ...(headless !== undefined ? { headless } : {}),
        ...(channel !== undefined ? { channel } : {}),
        ...contextSettings,
      });
      persistent.setDefaultTimeout(actionTimeout || 0);
      persistent.setDefaultNavigationTimeout(navigationTimeout || 0);
      if (storageState !== undefined) await persistent.setStorageState(storageState);
      testInfo.annotations.push({
        type: "native-blob-profile",
        description: "Ran in a fresh persistent WebKit profile, not the default ephemeral context.",
      });
      await runFixture(persistent);
    } finally {
      try {
        if (persistent) {
          await persistent.close({
            reason: testInfo.status === "timedOut" ? `Test timeout of ${testInfo.timeout}ms exceeded.` : "Test ended.",
          });
        }
      } finally {
        if (profileDir) await rm(profileDir, { recursive: true, force: true });
      }
    }
  },
});

export { expect };
