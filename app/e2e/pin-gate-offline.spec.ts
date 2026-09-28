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
// And the owner's shift-long offline unlock (lib/offlinePin.ts): a PIN the
// server accepted on this phone opens the lock with no signal for twelve hours
// — the phone keeps a slow fingerprint of it, never the PIN —
//   (d) the same PIN opens it, a wrong one is counted;
//   (e) twelve hours on it is gone, and the lock stays shut and says so;
//   (f) signing out wipes it.
//
// And from Codex's review of #651 (2026-09-25):
//   (g) an unlock belongs to one sign-in: signing out ends this tab's unlock,
//       so signing back in on the same tab asks for the PIN again;
//   (h) a server that answers the PIN-status question with neither a yes nor
//       a no (a stale schema cache) keeps the lock shut, and says so without
//       claiming the phone is offline;
//   (i) an unlock this tab kept for somebody else — or the bare "1" an older
//       build left, still there after the app updates itself in place — opens
//       nothing.
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
import { OFFLINE_PIN_ITERATIONS, OFFLINE_PIN_KEY, OFFLINE_PIN_TTL_MS } from "../src/lib/offlinePin";
import { TEST_USER, useSupabaseFixtures } from "./support/supabaseFixtures";
import { typePin } from "./support/pinFixtures";

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

/** The server's check, for an account whose PIN is `pin`. */
async function usePinCheck(page: Page, pin: string) {
  await page.route("**/rest/v1/rpc/check_my_pin", (route) => {
    const body = route.request().postDataJSON() as { p_pin?: string } | null;
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(body?.p_pin === pin),
    });
  });
}

type KeptUnlock = Record<string, unknown> & { salt: string; hash: string; issuedAt: number; expiresAt: number };

/** What the phone keeps for the offline unlock, or null. */
function storedOfflineUnlock(page: Page): Promise<KeptUnlock | null> {
  return page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? "null"), OFFLINE_PIN_KEY);
}

/** Wait for the fingerprint a yes from the server leaves behind. */
async function offlineUnlockOnThePhone(page: Page): Promise<KeptUnlock> {
  await expect
    .poll(() => storedOfflineUnlock(page), { timeout: 20_000, message: "no offline unlock was kept" })
    .not.toBeNull();
  return (await storedOfflineUnlock(page))!;
}

/**
 * Unlock with signal — the one thing that makes an offline unlock. Call after
 * useSupabaseFixtures and usePinCheck(page, "4821").
 */
async function unlockWithSignal(page: Page) {
  await pinStatusIs(page, true);
  await page.goto("/");
  await typePin(page, "4821");
  await expect(theApp(page)).toBeAttached();
  const kept = await offlineUnlockOnThePhone(page);
  // The lock's own answer ("has a PIN") reaches the phone on the cache's
  // write throttle; a relaunch before it lands is the never-checked case (c).
  await lockAnswerIsOnThePhone(page);
  return kept;
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

test("(d) a PIN the server accepted on this phone opens the lock with no signal, and a wrong one is counted", async ({
  page,
  context,
}) => {
  await useSupabaseFixtures(page, { role: "installer" });
  await usePinCheck(page, "4821");
  const kept = await unlockWithSignal(page);

  // A slow, salted fingerprint for this person — never the PIN.
  expect(kept).toMatchObject({ v: 1, userId: TEST_USER.id, iterations: OFFLINE_PIN_ITERATIONS, failures: 0 });
  expect(kept.expiresAt - kept.issuedAt).toBe(OFFLINE_PIN_TTL_MS);
  expect(Buffer.from(kept.salt, "base64")).toHaveLength(16);
  expect(Buffer.from(kept.hash, "base64")).toHaveLength(32);
  const everything = await page.evaluate(() =>
    [localStorage, sessionStorage].flatMap((s) => Object.keys(s).map((k) => s.getItem(k) ?? "")),
  );
  for (const value of everything) {
    expect(value).not.toBe("4821");
    expect(value).not.toContain('"4821"');
  }
  await page.close();

  const again = await context.newPage();
  await useSupabaseFixtures(again, { role: "installer" });
  const { refused } = await useNoSignalRelaunch(again, true);
  await context.setOffline(true);
  await again.goto("/");
  await expect(again.getByText("Enter your 4-digit PIN")).toBeVisible();

  await typePin(again, "1111");
  await expect(again.getByText("Wrong PIN. Tries left without signal: 4")).toBeVisible();
  await expect(theApp(again)).toHaveCount(0);

  await typePin(again, "4821");
  await expect(theApp(again)).toBeAttached();
  // The server was asked first both times, and could not answer.
  expect(refused.filter((path) => path === "/rest/v1/rpc/check_my_pin")).toHaveLength(2);
});

test("(e) twelve hours after the last check with signal the offline unlock is gone, and the lock stays shut", async ({
  page,
  context,
}) => {
  await useSupabaseFixtures(page, { role: "installer" });
  await usePinCheck(page, "4821");
  const kept = await unlockWithSignal(page);
  await page.close();

  // Thirteen hours later, by the phone's own clock.
  const again = await context.newPage();
  await again.clock.setFixedTime(new Date(kept.issuedAt + 13 * 60 * 60 * 1000));
  await useSupabaseFixtures(again, { role: "installer" });
  await useNoSignalRelaunch(again, true);
  await context.setOffline(true);
  await again.goto("/");
  await expect(again.getByText("Enter your 4-digit PIN")).toBeVisible();
  // The salt and hash were deleted at launch; only "it ran out" is left.
  await expect.poll(() => storedOfflineUnlock(again)).toEqual({ v: 1, userId: TEST_USER.id, expired: true });

  await typePin(again, "4821");
  await expect(again.getByText("Your offline unlock has expired — connect to check your PIN.")).toBeVisible();
  await expect(again.getByRole("button", { name: "Try again" })).toBeVisible();
  await expect(theApp(again)).toHaveCount(0);
});

test("(f) signing out wipes the offline unlock from the phone", async ({ page }) => {
  await useSupabaseFixtures(page, { role: "installer" });
  await usePinCheck(page, "4821");
  await unlockWithSignal(page);
  await page.getByRole("button", { name: "Open menu" }).click();
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect.poll(() => storedOfflineUnlock(page)).toBeNull();
});

test("(g) signing out ends this tab's unlock: signing back in on the same tab asks for the PIN again", async ({
  page,
}) => {
  await useSupabaseFixtures(page, { role: "installer" });
  await usePinCheck(page, "4821");
  await unlockWithSignal(page);
  expect(await page.evaluate(() => sessionStorage.getItem("wops-pin-unlocked"))).toBe(TEST_USER.id);

  await page.getByRole("button", { name: "Open menu" }).click();
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect.poll(() => page.evaluate(() => sessionStorage.getItem("wops-pin-unlocked"))).toBeNull();

  // Same tab, signing in again: the unlock went with the sign-out.
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByPlaceholder("Email").fill(TEST_USER.email);
  await page.getByPlaceholder("Password").fill("any password the fixture accepts");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByText("Enter your 4-digit PIN")).toBeVisible({ timeout: 15_000 });
  await expect(theApp(page)).toHaveCount(0);

  await typePin(page, "4821");
  await expect(theApp(page)).toBeAttached();
});

test("(h) a PIN-status read answered with neither yes nor no keeps the lock shut, and Try again works", async ({
  page,
}) => {
  await useSupabaseFixtures(page, { role: "installer" });
  let answer: "missing" | "no PIN" = "missing";
  await page.route("**/rest/v1/rpc/my_pin_status", (route) =>
    answer === "missing"
      ? route.fulfill({
          status: 404,
          contentType: "application/json",
          body: JSON.stringify({
            code: "PGRST202",
            message: "Could not find the function public.my_pin_status without parameters in the schema cache",
          }),
        })
      : route.fulfill({ status: 200, contentType: "application/json", body: "false" }),
  );
  await page.goto("/");

  await expect(page.getByText("Forge couldn't check your PIN. Try again.")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("You're offline")).toHaveCount(0);
  await expect(theApp(page)).toHaveCount(0);

  answer = "no PIN";
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(theApp(page)).toBeAttached({ timeout: 15_000 });
});

test("(i) an unlock this tab kept for somebody else, or an older build's bare \"1\", opens nothing", async ({
  context,
}) => {
  for (const kept of ["1", "00000000-0000-4000-8000-0000000000b2"]) {
    // A fresh tab each time: sessionStorage belongs to one tab.
    const page = await context.newPage();
    await useSupabaseFixtures(page, { role: "installer" });
    await pinStatusIs(page, true);
    await page.addInitScript((value) => {
      if (!sessionStorage.getItem("seeded")) {
        sessionStorage.setItem("seeded", "1");
        sessionStorage.setItem("wops-pin-unlocked", value);
      }
    }, kept);
    await page.goto("/");
    await expect(page.getByText("Enter your 4-digit PIN"), `kept: ${kept}`).toBeVisible();
    await expect(theApp(page)).toHaveCount(0);
    await page.close();
  }
});
