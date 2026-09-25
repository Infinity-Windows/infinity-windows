// The device lock, reopened with no signal (2026-09-24).
//
// The lock asks the server one question — does this person have a PIN? — and
// until now the answer lived only in memory. So an app reopened in a dead zone
// had nothing to go on: the lock sat on "Checking device lock…" for as long as
// the question hung, and when it failed outright it read the failure as "no
// PIN" and let a PIN account straight in.
//
// The last answer is now kept on the phone (lib/queryKeys.ts, myPinStatus), so:
//   (a) a PIN account reopened offline gets the PIN pad — and because the PIN is
//       only ever checked by the server, the lock stays shut and says why;
//   (b) a no-PIN account reopened offline goes straight in;
//   (c) a phone that has never had an answer says so in plain words, with a
//       Try again button that works the moment signal is back.
//
// How the dead zone is made, and why a relaunch is a NEW PAGE:
//   - Every Supabase call — auth included, a phone with no signal reaches
//     nothing — is aborted by routes registered after the fixtures, and the
//     refusals are counted so a run that quietly reached the network cannot
//     pass (same approach as offline-spec-card.spec.ts, which explains it).
//   - The app's own files come through route.fetch(), performed by the
//     Playwright process, standing in for the service worker a dev server
//     does not have.
//   - A reload keeps sessionStorage, and the lock remembers an unlock for the
//     rest of the session there. Killing the app and opening it again does
//     not keep it, so a relaunch here is a fresh page in the same context:
//     same localStorage (the phone), fresh sessionStorage (a new launch).
import { expect, test, type BrowserContext, type Page, type Route } from "@playwright/test";
import { useSupabaseFixtures } from "./support/supabaseFixtures";

const SUPABASE = ["**/rest/v1/**", "**/auth/v1/**", "**/storage/v1/**", "**/functions/v1/**"];

/** Answer the PIN-status question the way this account would. */
async function pinStatusIs(page: Page, hasPin: boolean) {
  await page.route("**/rest/v1/rpc/my_pin_status", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(hasPin) }),
  );
}

interface DeadZone {
  /** Paths of every Supabase request the dead zone refused. */
  refused: string[];
  /** Signal is back: lift exactly these routes, and tell the page. */
  lift: (context: BrowserContext) => Promise<void>;
}

/** Cut every line to Supabase and keep the app's own files coming. */
async function goToTheDeadZone(page: Page): Promise<DeadZone> {
  const refused: string[] = [];
  const refuse = (route: Route) => {
    refused.push(new URL(route.request().url()).pathname);
    return route.abort("internetdisconnected");
  };
  for (const pattern of SUPABASE) await page.route(pattern, refuse);
  await page.route("**/*", async (route) => {
    if (!new URL(route.request().url()).host.startsWith("localhost")) {
      return route.fallback();
    }
    try {
      await route.fulfill({ response: await route.fetch() });
    } catch {
      await route.abort();
    }
  });
  return {
    refused,
    lift: async (context) => {
      // By handler, not by pattern: the fixture router is registered on the
      // same globs, and unrouting a glob alone would take it down too.
      for (const pattern of SUPABASE) await page.unroute(pattern, refuse);
      await context.setOffline(false);
    },
  };
}

/** Wait until the phone has written the lock's answer to disk. */
async function lockAnswerIsOnThePhone(page: Page) {
  await expect
    .poll(
      () =>
        page.evaluate(() =>
          (window.localStorage.getItem("wops-query-cache") ?? "").includes("myPinStatus"),
        ),
      { timeout: 20_000, message: "the lock's answer never reached the phone's saved copy" },
    )
    .toBe(true);
}

/**
 * This account's lock answer, and the dead zone over everything. Call after
 * useSupabaseFixtures and before the page navigates.
 */
async function useNoSignalRelaunch(page: Page, hasPin: boolean): Promise<DeadZone> {
  await pinStatusIs(page, hasPin);
  return goToTheDeadZone(page);
}

const theApp = (page: Page) => page.locator("nav.tabbar");
const theLock = (page: Page) => page.locator(".pin-gate");

test("(a) a PIN account reopened with no signal is asked for its PIN, and the lock stays shut", async ({
  page,
  context,
}) => {
  await useSupabaseFixtures(page, { role: "installer" });
  await pinStatusIs(page, true);
  await page.goto("/");
  await expect(page.getByText("Enter your 4-digit PIN")).toBeVisible();
  await lockAnswerIsOnThePhone(page);
  await page.close();

  const again = await context.newPage();
  await useSupabaseFixtures(again, { role: "installer" });
  const { refused } = await useNoSignalRelaunch(again, true);
  await context.setOffline(true);
  await again.goto("/");

  // The PIN pad, from the saved answer — not a spinner, and not the app.
  await expect(again.getByText("Enter your 4-digit PIN")).toBeVisible({ timeout: 5_000 });
  await expect(again.getByText("Checking device lock…")).toHaveCount(0);
  await expect(theApp(again)).toHaveCount(0);

  // The PIN is checked by the server only, so with no signal the lock says so
  // plainly and stays shut.
  for (const digit of "4821") await again.getByRole("button", { name: digit, exact: true }).click();
  await expect(again.getByText(/No signal\. Your PIN is checked online/)).toBeVisible();
  await expect(again.getByRole("button", { name: "Try again" })).toBeVisible();
  await expect(theApp(again)).toHaveCount(0);

  expect(refused, "nothing was refused — the app was not actually cut off").toContain(
    "/rest/v1/rpc/check_my_pin",
  );
});

test("(b) a no-PIN account reopened with no signal goes straight in", async ({ page, context }) => {
  await useSupabaseFixtures(page, { role: "installer" });
  await pinStatusIs(page, false);
  await page.goto("/");
  await expect(theApp(page)).toBeAttached();
  await lockAnswerIsOnThePhone(page);
  await page.close();

  const again = await context.newPage();
  await useSupabaseFixtures(again, { role: "installer" });
  const { refused } = await useNoSignalRelaunch(again, false);
  await context.setOffline(true);
  await again.goto("/");

  await expect(theApp(again)).toBeAttached({ timeout: 5_000 });
  await expect(theLock(again)).toHaveCount(0);
  expect(refused.length, "nothing was refused — the app was not actually cut off").toBeGreaterThan(0);
});

test("(c) a phone that never got an answer says so, stays locked, and Try again works once signal is back", async ({
  page,
  context,
}) => {
  await useSupabaseFixtures(page, { role: "installer" });
  const deadZone = await useNoSignalRelaunch(page, false);
  await context.setOffline(true);
  await page.goto("/");

  await expect(page.getByText("You're offline")).toBeVisible({ timeout: 15_000 });
  await expect(
    page.getByText("Connect to the internet once so Forge can check your device lock"),
  ).toBeVisible();
  await expect(page.getByText("Checking device lock…")).toHaveCount(0);
  await expect(theApp(page)).toHaveCount(0);
  expect(deadZone.refused).toContain("/rest/v1/rpc/my_pin_status");

  await deadZone.lift(context);
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(theApp(page)).toBeAttached({ timeout: 15_000 });
  await expect(theLock(page)).toHaveCount(0);
});
