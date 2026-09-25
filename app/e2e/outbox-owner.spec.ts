// A queued write goes out only as the person who saved it (2026-09-25).
//
// Codex's reproduction from the review of #654 (finding 3), turned into the
// safe outcome: A queues a clock-in with no signal, signs out, and B signs in
// on the same phone. Before, the drain sent A's punch with B's token — the
// real clock_in files the shift for auth.uid(), so A's morning became B's
// shift. Now A's punch waits, untouched and shown as someone else's, B's own
// punch goes out as B, and when A signs back in A's punch goes out as A.
//
// Everything runs in the real app against the fixture router, the way
// Codex's proof did: the real outbox module, the real supabase client, real
// sign-out and sign-in. The fixture keeps the session pinned in localStorage
// for every other spec; this one hands it back to real storage after load so
// a sign-out and a sign-in actually change who is signed in.

import { expect, test, type Page } from "@playwright/test";
import { TEST_USER, useSupabaseFixtures } from "./support/supabaseFixtures";
import { hideWrongProjectBanner, json, stubGeolocationDenied } from "./support/specHelpers";

const AUTH_KEY = "sb-e2efixture-auth-token";
const A_SESSION = {
  access_token: "e2e-fixture-access-token",
  token_type: "bearer",
  expires_in: 3600,
  expires_at: 2_066_000_000,
  refresh_token: "e2e-fixture-refresh-token",
  user: TEST_USER,
};
const B_USER = { ...TEST_USER, id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", email: "person-b@example.test" };
const B_SESSION = { ...A_SESSION, access_token: "person-B-token", refresh_token: "person-B-refresh", user: B_USER };

interface Sent {
  authorization: string | undefined;
  clientId: unknown;
}

async function server(page: Page) {
  const clockIns: Sent[] = [];
  await page.route("**/auth/v1/token**", async (route) => {
    const body = (route.request().postDataJSON() ?? {}) as { email?: string };
    return json(route, body.email === B_USER.email ? B_SESSION : A_SESSION, null);
  });
  await page.route("**/auth/v1/logout**", (route) => route.fulfill({ status: 204, body: "" }));
  await page.route(
    (url) => /\/rest\/v1\/rpc\/clock_in(\?|$)/.test(url.href),
    async (route) => {
      const body = (route.request().postDataJSON() ?? {}) as Record<string, unknown>;
      clockIns.push({ authorization: route.request().headers()["authorization"], clientId: body.p_client_id });
      return json(route, { id: `shift-${clockIns.length}`, status: "open" }, null);
    },
  );
  return clockIns;
}

/** Hand the pinned fixture session back to real storage, so sign-out and sign-in work. */
async function realSessionStorage(page: Page) {
  await page.evaluate(
    ({ key, session }) => {
      const w = window as unknown as { __nativeGetItem: Storage["getItem"] };
      Storage.prototype.getItem = w.__nativeGetItem;
      localStorage.setItem(key, JSON.stringify(session));
    },
    { key: AUTH_KEY, session: A_SESSION },
  );
}

/** Sign out, then sign in as `email`, with the real client. */
async function switchPerson(page: Page, email: string | null) {
  await page.evaluate(async (email) => {
    const { supabase } = await import("/src/lib/supabase.ts" as string);
    const out = await supabase.auth.signOut();
    if (out.error) throw out.error;
    if (email) {
      const signIn = await supabase.auth.signInWithPassword({ email, password: "fixture" });
      if (signIn.error) throw signIn.error;
    }
  }, email);
}

async function queueClockIn(page: Page, clientId: string) {
  await page.evaluate(async (clientId) => {
    const outbox = await import("/src/lib/offline/outbox.ts" as string);
    await outbox.enqueueClockIn({
      projectId: "ebf64f94-0413-4434-aeb3-1aff228fb5b3",
      costCodeId: "22222222-bbbb-4bbb-8bbb-222222222222",
      punch: { clientId, tappedAt: new Date().toISOString(), clockCheckedAt: null, clockSkewMs: null },
    });
  }, clientId);
}

async function setOnline(page: Page, online: boolean) {
  await page.evaluate((online) => Object.defineProperty(navigator, "onLine", { configurable: true, value: online }), online);
}

async function drain(page: Page) {
  await page.evaluate(async () => {
    const outbox = await import("/src/lib/offline/outbox.ts" as string);
    await outbox.drain();
  });
}

async function queued(page: Page) {
  return page.evaluate(async () => {
    const outbox = await import("/src/lib/offline/outbox.ts" as string);
    type Row = { payload: { clientId?: unknown }; ownerId?: string; status: string; attemptCount: number };
    return ((await outbox.listAll()) as Row[]).map((e) => ({ clientId: e.payload.clientId, ownerId: e.ownerId ?? null, status: e.status, attempts: e.attemptCount }));
  });
}

test.use({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });

test("A's queued clock-in is never sent as B: it waits, B's own goes as B, and A's goes as A when A is back", async ({ page }) => {
  await page.addInitScript(() => {
    (window as unknown as { __nativeGetItem: Storage["getItem"] }).__nativeGetItem = Storage.prototype.getItem;
  });
  await useSupabaseFixtures(page, { role: "installer" });
  await hideWrongProjectBanner(page);
  await stubGeolocationDenied(page);
  const clockIns = await server(page);

  await page.goto("/");
  await expect(page.locator(".clockin-block")).toBeVisible();
  await realSessionStorage(page);

  // A, with no signal, clocks in: on the phone, and A's.
  await setOnline(page, false);
  await queueClockIn(page, "punch-of-A");
  await expect(page.locator(".tab.clock-on")).toBeVisible();

  // A hands the phone to B.
  await switchPerson(page, B_USER.email);
  await setOnline(page, true);
  await drain(page);

  // Nothing of A's left the phone — not with B's token, not at all.
  expect(clockIns).toEqual([]);
  expect(await queued(page)).toEqual([{ clientId: "punch-of-A", ownerId: TEST_USER.id, status: "queued", attempts: 0 }]);
  // B is not shown on the clock by A's punch, and the pill says whose it is.
  await expect(page.locator(".tab.clock-on")).toHaveCount(0);
  await expect(page.locator(".sync-pill").first()).toContainText("1 saved by someone else");

  // B's own clock-in goes out, as B.
  await queueClockIn(page, "punch-of-B");
  await expect.poll(() => clockIns.length).toBe(1);
  expect(clockIns[0]).toEqual({ authorization: "Bearer person-B-token", clientId: "punch-of-B" });
  expect((await queued(page)).map((q) => q.clientId)).toEqual(["punch-of-A"]);

  // A signs back in: A's punch goes out, as A.
  await switchPerson(page, TEST_USER.email);
  await drain(page);
  await expect.poll(() => clockIns.length).toBe(2);
  expect(clockIns[1]).toEqual({ authorization: `Bearer ${A_SESSION.access_token}`, clientId: "punch-of-A" });
  expect(await queued(page)).toEqual([]);
  await expect(page.locator(".sync-pill").first()).not.toContainText("someone else");
});

test("signed out with a punch still on the phone: nothing goes out as nobody, and it is still there for A", async ({ page }) => {
  await page.addInitScript(() => {
    (window as unknown as { __nativeGetItem: Storage["getItem"] }).__nativeGetItem = Storage.prototype.getItem;
  });
  await useSupabaseFixtures(page, { role: "installer" });
  await hideWrongProjectBanner(page);
  await stubGeolocationDenied(page);
  const clockIns = await server(page);

  await page.goto("/");
  await expect(page.locator(".clockin-block")).toBeVisible();
  await realSessionStorage(page);

  await setOnline(page, false);
  await queueClockIn(page, "punch-of-A");
  await switchPerson(page, null);
  await setOnline(page, true);
  await drain(page);
  expect(clockIns).toEqual([]);

  await switchPerson(page, TEST_USER.email);
  await drain(page);
  await expect.poll(() => clockIns.length).toBe(1);
  expect(clockIns[0]).toEqual({ authorization: `Bearer ${A_SESSION.access_token}`, clientId: "punch-of-A" });
});
