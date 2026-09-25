// A phone whose sign-in ran out overnight, opened where there is no signal
// (2026-09-24).
//
// The access token a phone signs in with lasts an hour. Somebody who last
// used the app yesterday opens it this morning on a site with no bars, and
// before the app can talk to anyone it has to renew that token — which it
// cannot do without signal. It used to take that failure for "nobody is
// signed in": the phone sat on "Connecting…" for half a minute and then
// showed Sign in / Request access, and the crew member had no clock (and no
// anything) until signal came back. Separately, any launch with no signal
// wrote "no profile" over the saved one, and the screens that need it — the
// clock block first — emptied out.
//
// What these prove:
//   (a) an expired sign-in with no signal opens signed in, on the saved
//       profile; a clock-in waits on the phone; when signal returns the
//       sign-in is renewed and the clock-in goes out under the NEW sign-in —
//       and nothing, at any point, is sent to the database as nobody;
//   (b) a sign-in that is still good, opened with no signal, keeps the saved
//       profile instead of replacing it with nothing;
//   (c) a sign-in the server has ended (revoked, signed out elsewhere) still
//       signs the phone out, and the sign-in screen says so plainly.
//
// How the dead zone is made (the same one pin-gate-offline.spec.ts uses):
// every Supabase call is aborted by routes registered after the fixtures, the
// browser is set offline, and the app's own files come through route.fetch()
// — performed by the Playwright process, standing in for the service worker a
// dev server does not have. A relaunch is a fresh page in the same context:
// same localStorage (the phone), fresh memory (a new launch).
import { expect, test, type BrowserContext, type Page, type Route } from "@playwright/test";
import {
  FIXTURE_AUTH_KEY,
  FIXTURE_SESSION,
  useSupabaseFixtures,
} from "./support/supabaseFixtures";
import { hideWrongProjectBanner, json, stubGeolocationDenied } from "./support/specHelpers";

const SUPABASE = ["**/rest/v1/**", "**/auth/v1/**", "**/storage/v1/**", "**/functions/v1/**"];

/**
 * What a request sent as NOBODY carries: the public key where a person's
 * token should be (playwright.config.ts sets that key). The real database
 * answers the clock_in RPC for nobody with 42501, which the offline queue
 * rightly takes as permanent — so one of these in the wrong place loses a
 * punch for good.
 */
const NOBODY = "Bearer sb_publishable_e2e_fixture_not_a_secret";

/** What the auth server hands back once signal returns: a new pair. */
const RENEWED = {
  ...FIXTURE_SESSION,
  access_token: "e2e-renewed-access-token",
  refresh_token: "e2e-renewed-refresh-token",
  expires_at: 2_066_000_000,
};

const BLACK22 = "ebf64f94-0413-4434-aeb3-1aff228fb5b3";
const INSTALL = "22222222-bbbb-4bbb-8bbb-222222222222";

const COST_CODES = [
  {
    id: INSTALL,
    code: "100",
    label: "Install — windows",
    description: null,
    active: true,
    sort_order: 10,
    is_general: false,
  },
];

const hoursAgo = (h: number) => new Date(Date.now() - h * 3600_000).toISOString();

/** Yesterday's punch: the job and code the clock primes itself with today. */
const RECENT_SHIFTS = [
  {
    project_id: BLACK22,
    cost_code_id: INSTALL,
    clock_in_at: hoursAgo(20),
    projects: { job_code: "BLACK22", name: "Black Desert" },
  },
];

interface Seen {
  path: string;
  authorization: string | null;
}

interface ClockServer {
  /** Every clock_in that reached the database, and whose token it carried. */
  clockIns: { body: Record<string, unknown>; authorization: string | null }[];
}

/**
 * The reads the clock needs and the clock_in RPC, answered the way the real
 * database would: a clock_in sent as nobody is refused with 42501.
 * Registered after useSupabaseFixtures, so these win.
 */
async function clockServer(page: Page): Promise<ClockServer> {
  const server: ClockServer = { clockIns: [] };
  let openShift: Record<string, unknown> | null = null;

  // No talk today, so the toolbox gate stays out of the way.
  await page.route("**/rest/v1/safety_talks**", (r) => {
    const accept = r.request().headers()["accept"] ?? "";
    return accept.includes("pgrst.object") ? json(r, null, 0) : json(r, [], 0);
  });
  await page.route("**/rest/v1/toolbox_completions**", (r) => {
    const accept = r.request().headers()["accept"] ?? "";
    return accept.includes("pgrst.object") ? json(r, null, 0) : json(r, [], 0);
  });
  await page.route("**/rest/v1/cost_codes**", (r) => json(r, COST_CODES, COST_CODES.length));
  await page.route("**/rest/v1/project_cost_codes**", (r) => json(r, [], 0));
  // One table, two readers — the open-shift lookup filters on status.
  await page.route("**/rest/v1/time_shifts**", (r) => {
    const url = new URL(r.request().url());
    if ((url.searchParams.get("status") ?? "").startsWith("in.")) {
      return json(r, openShift ? [openShift] : [], openShift ? 1 : 0);
    }
    return json(r, RECENT_SHIFTS, RECENT_SHIFTS.length);
  });
  await page.route(
    (url) => /\/rest\/v1\/rpc\/clock_in(\?|$)/.test(url.href),
    (r) => {
      const authorization = r.request().headers()["authorization"] ?? null;
      const body = (r.request().postDataJSON() ?? {}) as Record<string, unknown>;
      server.clockIns.push({ body, authorization });
      if (!authorization || authorization === NOBODY) {
        return r.fulfill({
          status: 401,
          contentType: "application/json",
          body: JSON.stringify({ code: "42501", message: "permission denied for function clock_in" }),
        });
      }
      openShift = {
        id: "55555555-eeee-4eee-8eee-555555555555",
        profile_id: FIXTURE_SESSION.user.id,
        project_id: body.p_project_id ?? null,
        cost_code_id: body.p_cost_code_id ?? null,
        clock_in_at: new Date().toISOString(),
        clock_out_at: null,
        break_seconds: 0,
        break_started_at: null,
        break_type: null,
        injured: null,
        time_confirmed: null,
        status: "open",
        created_at: new Date().toISOString(),
        note: null,
        clocked_in_by: null,
        clocked_out_by: null,
        projects: { job_code: "BLACK22", name: "Black Desert" },
        cost_codes: { code: "100", label: "Install — windows" },
        profiles: { display_name: "E2E Fixture" },
        editor: null,
        voider: null,
      };
      return json(r, openShift, null);
    },
  );
  return server;
}

/** The auth server's answer to "renew this sign-in", switchable mid-test. */
async function tokenEndpoint(page: Page) {
  const state = { answer: "renew" as "renew" | "refuse", asked: 0 };
  await page.route("**/auth/v1/token**", (route) => {
    state.asked += 1;
    if (state.answer === "refuse") {
      // What the auth server says about a refresh token it has revoked.
      return route.fulfill({
        status: 400,
        contentType: "application/json",
        headers: { "access-control-expose-headers": "x-supabase-api-version", "x-supabase-api-version": "2024-01-01" },
        body: JSON.stringify({
          code: "refresh_token_not_found",
          error_code: "refresh_token_not_found",
          message: "Invalid Refresh Token: Refresh Token Not Found",
        }),
      });
    }
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(RENEWED) });
  });
  return state;
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
      // The page may have dropped the request itself (a navigation): then it
      // is already handled, and there is nothing left to refuse.
      await route.abort().catch(() => {});
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

/**
 * Every request to the database, the file store or a function, and the token
 * it carried — including the ones the dead zone refuses. Registered LAST so
 * it sees each request first, then hands it on unchanged.
 */
async function watchWhoIsAsking(page: Page): Promise<Seen[]> {
  const seen: Seen[] = [];
  const watch = (route: Route) => {
    seen.push({
      path: new URL(route.request().url()).pathname,
      authorization: route.request().headers()["authorization"] ?? null,
    });
    return route.fallback();
  };
  for (const pattern of ["**/rest/v1/**", "**/storage/v1/**", "**/functions/v1/**"]) {
    await page.route(pattern, watch);
  }
  return seen;
}

const sentAsNobody = (seen: Seen[]) =>
  seen.filter((s) => s.authorization === NOBODY || (!s.authorization && !s.path.startsWith("/functions/")));

/** The phone's saved copy of one query, as the persister last wrote it. */
async function savedQuery(page: Page, root: string) {
  return page.evaluate((r) => {
    const raw = window.localStorage.getItem("wops-query-cache");
    if (!raw) return null;
    const parsed = JSON.parse(raw) as {
      clientState?: {
        queries?: { queryKey: unknown[]; state: { data: unknown; dataUpdatedAt: number; fetchFailureCount: number } }[];
      };
    };
    const hit = (parsed.clientState?.queries ?? []).find((q) => q.queryKey[0] === r);
    return hit ? hit.state : null;
  }, root);
}

/** Wait until the phone has written these queries' answers to its saved copy. */
async function savedCopyHolds(page: Page, roots: string[]) {
  for (const root of roots) {
    await expect
      .poll(async () => (await savedQuery(page, root))?.data != null, {
        timeout: 20_000,
        message: `the phone never saved "${root}"`,
      })
      .toBe(true);
  }
}

/**
 * Close the app but stay on its origin, so the phone's storage can be edited
 * with nothing running that could write over the edit. A static file serves:
 * same origin, no app.
 */
async function putThePhoneAway(page: Page) {
  await page.goto("/favicon.svg");
}

/** Overnight: the access token on the phone ran out two hours ago. */
async function expireTheSignIn(page: Page) {
  await page.evaluate((key) => {
    const stored = JSON.parse(window.localStorage.getItem(key) ?? "null");
    if (!stored) throw new Error("no sign-in on the phone to expire");
    stored.expires_at = Math.floor(Date.now() / 1000) - 2 * 3600;
    window.localStorage.setItem(key, JSON.stringify(stored));
  }, FIXTURE_AUTH_KEY);
}

/**
 * Time passes for the saved copy too: every answer on it becomes `hours` old,
 * so the next launch re-asks for them the way a morning launch does. (Left
 * seconds old, React Query would trust them and never ask — and a test of
 * what an offline launch does to the saved copy would test nothing.)
 */
async function ageTheSavedCopy(page: Page, hours: number) {
  await page.evaluate((ms) => {
    const raw = window.localStorage.getItem("wops-query-cache");
    if (!raw) throw new Error("no saved copy on the phone to age");
    const saved = JSON.parse(raw) as { clientState?: { queries?: { state?: { dataUpdatedAt?: number } }[] } };
    for (const q of saved.clientState?.queries ?? []) {
      if (q.state?.dataUpdatedAt) q.state.dataUpdatedAt -= ms;
    }
    window.localStorage.setItem("wops-query-cache", JSON.stringify(saved));
  }, hours * 3600_000);
}

async function storedSignIn(page: Page): Promise<{ access_token: string } | null> {
  return page.evaluate((key) => JSON.parse(window.localStorage.getItem(key) ?? "null"), FIXTURE_AUTH_KEY);
}

/**
 * Yesterday, with signal: the app opened and saved its copy of `saved`. Call
 * after useSupabaseFixtures.
 */
async function yesterdayWithSignal(page: Page, saved: string[]) {
  await hideWrongProjectBanner(page);
  await stubGeolocationDenied(page);
  await clockServer(page);
  await page.goto("/");
  await expect(page.locator(".clockin-block")).toBeVisible();
  await savedCopyHolds(page, saved);
}

test.use({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });

test("(a) an expired sign-in with no signal opens signed in, a clock-in waits on the phone, and goes out under the renewed sign-in when signal returns", async ({
  page,
  context,
}) => {
  test.setTimeout(240_000);
  await useSupabaseFixtures(page, { role: "installer", session: "phone" });
  // What the phone has to have kept to clock in tomorrow with no signal.
  await yesterdayWithSignal(page, ["myProfile", "projects", "recentJobs", "clockCostCodes"]);
  await putThePhoneAway(page);
  await expireTheSignIn(page);
  await ageTheSavedCopy(page, 14);
  await page.close();

  // This morning, on a site with no bars.
  const again = await context.newPage();
  await useSupabaseFixtures(again, { role: "installer", session: "phone" });
  await hideWrongProjectBanner(again);
  await stubGeolocationDenied(again);
  const server = await clockServer(again);
  const auth = await tokenEndpoint(again);
  const deadZone = await goToTheDeadZone(again);
  const seen = await watchWhoIsAsking(again);
  await context.setOffline(true);
  await again.goto("/");

  // Signed in, on the saved profile — not the front door, and not a
  // half-minute of "Connecting…" first. The clock block only renders with a
  // profile, so seeing it IS seeing the saved profile.
  const block = again.locator(".clockin-block");
  await expect(block).toBeVisible({ timeout: 10_000 });
  await expect(again.getByRole("button", { name: "Request access" })).toHaveCount(0);
  await expect(again.getByPlaceholder("Email")).toHaveCount(0);
  await expect(block.locator(".clock-chip.current")).toContainText("BLACK22");
  await expect(block.locator(".clock-costcode-item.selected")).toContainText("Install — windows");

  // Clock in. With no signal the block hands over to the clock sheet, and the
  // sheet saves the punch on the phone. Neither may sit waiting on a renewal
  // that cannot happen.
  await block.locator(".clock-btn.primary.big").click();
  const sheet = again.locator(".clock-sheet");
  await expect(sheet).toBeVisible({ timeout: 10_000 });
  await sheet.locator(".clock-btn.primary.big").click();
  await expect(again.getByText("Clocked in — we'll sync it when you're back online")).toBeVisible({
    timeout: 10_000,
  });
  expect(server.clockIns, "a punch reached the database with no signal").toHaveLength(0);
  expect(deadZone.refused, "the app was not actually cut off").toContain("/auth/v1/token");

  // Signal returns.
  auth.answer = "renew";
  await deadZone.lift(context);

  // The sign-in is renewed, and the waiting clock-in goes out once — under
  // the renewed sign-in, carrying the job and code it was saved with.
  await expect
    .poll(() => server.clockIns.length, { timeout: 180_000, message: "the queued clock-in never went out" })
    .toBeGreaterThan(0);
  expect(server.clockIns).toHaveLength(1);
  expect(server.clockIns[0].authorization).toBe(`Bearer ${RENEWED.access_token}`);
  expect(server.clockIns[0].body.p_project_id).toBe(BLACK22);
  expect(server.clockIns[0].body.p_cost_code_id).toBe(INSTALL);
  expect((await storedSignIn(again))?.access_token).toBe(RENEWED.access_token);

  // And nothing, offline or after, went to the database as nobody.
  expect(sentAsNobody(seen), "a request went out with no one's sign-in on it").toEqual([]);
});

test("(b) a good sign-in opened with no signal keeps the saved profile, so the clock is still there", async ({
  page,
  context,
}) => {
  await useSupabaseFixtures(page, { role: "installer" });
  await yesterdayWithSignal(page, ["myProfile"]);
  await putThePhoneAway(page);
  // Within the hour: the sign-in is still good, the saved answers are not new.
  await ageTheSavedCopy(page, 0.75);
  const before = await savedQuery(page, "myProfile");
  await page.close();

  const again = await context.newPage();
  await useSupabaseFixtures(again, { role: "installer" });
  await hideWrongProjectBanner(again);
  await stubGeolocationDenied(again);
  await clockServer(again);
  const deadZone = await goToTheDeadZone(again);
  await context.setOffline(true);
  await again.goto("/");

  await expect(again.locator(".clockin-block")).toBeVisible({ timeout: 10_000 });

  // The launch tried to re-read the profile and could not. Once that attempt
  // has landed in the saved copy, the saved copy must still be the profile.
  await expect
    .poll(
      async () => {
        const now = await savedQuery(again, "myProfile");
        return Boolean(now && (now.dataUpdatedAt !== before?.dataUpdatedAt || now.fetchFailureCount > 0));
      },
      { timeout: 30_000, message: "the offline launch never tried to re-read the profile" },
    )
    .toBe(true);
  const after = await savedQuery(again, "myProfile");
  expect((after?.data as { display_name?: string } | null)?.display_name).toBe("E2E Fixture");
  await expect(again.locator(".clockin-block")).toBeVisible();
  expect(deadZone.refused.length, "the app was not actually cut off").toBeGreaterThan(0);
});

test("(c) a sign-in the server has ended still signs the phone out, and says so plainly", async ({ page }) => {
  await useSupabaseFixtures(page, { role: "installer", session: "phone" });
  await hideWrongProjectBanner(page);
  const auth = await tokenEndpoint(page);
  auth.answer = "refuse";
  // Ran out overnight, and meanwhile the office removed this login.
  await page.addInitScript((key) => {
    const stored = JSON.parse(window.localStorage.getItem(key) ?? "null");
    if (stored) {
      stored.expires_at = Math.floor(Date.now() / 1000) - 2 * 3600;
      window.localStorage.setItem(key, JSON.stringify(stored));
    }
  }, FIXTURE_AUTH_KEY);
  await page.goto("/");

  await expect(page.getByText("You've been signed out on this phone")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByPlaceholder("Email")).toBeVisible();
  await expect(page.locator(".clockin-block")).toHaveCount(0);
  expect(auth.asked).toBeGreaterThan(0);
  expect(await storedSignIn(page)).toBeNull();
});
