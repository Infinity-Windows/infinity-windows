// A clock punch made with no signal counts as real, and goes out before the
// photos (Release 0, K0.1 and K0.3).
//
// The double punch this closes: an installer taps Clock in on one bar, the
// punch goes into the outbox, and the next server read comes back empty — so
// every screen said "off the clock", the person tapped Clock in again, and
// the server got two shifts when the truck found signal. Two things are
// proved here against the real app, the way a phone would do them:
//
//   1. clock in with no signal → the nav and the sheet show the person ON the
//      clock, from this phone's own copy, with "saved on this phone"; a
//      reload with no signal still shows it and offers no Start; when signal
//      returns exactly ONE clock_in reaches the server and the server's
//      shift takes over without the screens ever dropping to "off the clock";
//   2. three photos waiting in the queue, then a clock-out with no signal →
//      when signal returns the clock-out is the FIRST write out of the phone.
//
// The dead zone is made the way offline-spec-card.spec.ts makes it: every
// Supabase call is refused outright (a Playwright route answers before the
// network, so setOffline alone would let the fixture router keep answering),
// the app's own files are passed through by route.fetch() so a reload works
// with the context offline, and the refusals are counted so a run where the
// app quietly reached the server cannot pass.

import { expect, test, type Page } from "@playwright/test";
import { TEST_USER, useSupabaseFixtures } from "./support/supabaseFixtures";
import {
  TINY_PNG_BASE64,
  hideWrongProjectBanner,
  json,
  stubGeolocationDenied,
} from "./support/specHelpers";

const BLACK22 = "ebf64f94-0413-4434-aeb3-1aff228fb5b3";
const GENERAL = "11111111-aaaa-4aaa-8aaa-111111111111";
const SHIFT_ID = "55555555-eeee-4eee-8eee-555555555555";

const COST_CODES = [
  { id: GENERAL, code: "000", label: "General", description: null, active: true, sort_order: 5, is_general: true },
];

const hoursAgo = (h: number) => new Date(Date.now() - h * 3600_000).toISOString();

/** Yesterday's punch, so the landing block primes itself with BLACK22 + General. */
const RECENT_SHIFTS = [
  { project_id: BLACK22, cost_code_id: GENERAL, clock_in_at: hoursAgo(26), projects: { job_code: "BLACK22", name: "Black Desert" } },
];

type Row = Record<string, unknown>;

function shiftRow(over: Row = {}): Row {
  return {
    id: SHIFT_ID,
    profile_id: TEST_USER.id,
    project_id: BLACK22,
    cost_code_id: GENERAL,
    clock_in_at: hoursAgo(2),
    clock_out_at: null,
    break_seconds: 0,
    break_started_at: null,
    break_type: null,
    injured: null,
    time_confirmed: null,
    status: "open",
    created_at: hoursAgo(2),
    note: null,
    clocked_in_by: null,
    clocked_out_by: null,
    projects: { job_code: "BLACK22", name: "Black Desert" },
    cost_codes: { code: "000", label: "General" },
    profiles: { display_name: "E2E Fixture" },
    editor: null,
    voider: null,
    ...over,
  };
}

/** The signal switch, and the count of calls refused while it was off. */
class Signal {
  dead = false;
  refused = 0;
}

/** Every write that reached the server, in the order it arrived. */
interface Server {
  clockIns: Row[];
  writes: string[];
}

/**
 * The clock's server, registered AFTER the shared fixtures so these win, and
 * the dead zone registered last of all so it wins over everything while the
 * signal is off and falls through to the handlers below when it is on.
 */
async function clockServer(page: Page, signal: Signal, start: { openShift: Row | null }): Promise<Server> {
  const server: Server = { clockIns: [], writes: [] };
  let openShift = start.openShift;

  // No talk today, nothing signed: the plain Start clock, no toolbox gate.
  await page.route("**/rest/v1/safety_talks**", (r) => {
    const accept = r.request().headers()["accept"] ?? "";
    return accept.includes("pgrst.object") ? json(r, null, 0) : json(r, [], 0);
  });
  await page.route("**/rest/v1/toolbox_completions**", (r) => json(r, [], 0));
  await page.route("**/rest/v1/cost_codes**", (r) => json(r, COST_CODES, COST_CODES.length));
  await page.route("**/rest/v1/project_cost_codes**", (r) => json(r, [], 0));
  // The open-shift lookup and the recent-jobs list share a table; the status
  // filter tells them apart (see clock-in-once.spec.ts).
  await page.route("**/rest/v1/time_shifts**", (r) => {
    const url = new URL(r.request().url());
    if ((url.searchParams.get("status") ?? "").startsWith("in.")) {
      return json(r, openShift ? [openShift] : [], openShift ? 1 : 0);
    }
    return json(r, RECENT_SHIFTS, RECENT_SHIFTS.length);
  });
  // The phone's clock check (K0.5) — answered, so no wrong-clock banner.
  await page.route(
    (url) => /\/rest\/v1\/rpc\/server_now(\?|$)/.test(url.href),
    (r) => json(r, new Date().toISOString(), null),
  );
  await page.route(
    (url) => /\/rest\/v1\/rpc\/clock_in(\?|$)/.test(url.href),
    (r) => {
      const body = (r.request().postDataJSON() ?? {}) as Row;
      server.clockIns.push(body);
      server.writes.push("clock_in");
      openShift = shiftRow({
        client_id: body.p_client_id ?? null,
        project_id: body.p_project_id ?? null,
        cost_code_id: body.p_cost_code_id ?? null,
        clock_in_at: new Date().toISOString(),
        created_at: new Date().toISOString(),
        note: body.p_note ?? null,
      });
      return json(r, openShift, null);
    },
  );
  await page.route(
    (url) => /\/rest\/v1\/rpc\/clock_out(\?|$)/.test(url.href),
    (r) => {
      server.writes.push("clock_out");
      const closed = shiftRow({ ...(openShift ?? {}), clock_out_at: new Date().toISOString(), status: "submitted" });
      openShift = null;
      return json(r, closed, null);
    },
  );
  // A queued photo: the bytes to the bucket, then the attachments row.
  await page.route("**/storage/v1/object/install-media/**", (r) => {
    server.writes.push("upload");
    return json(r, { Key: "install-media/e2e" }, null);
  });
  await page.route("**/rest/v1/attachments**", (r) => {
    if (r.request().method() === "POST") {
      server.writes.push("attachment");
      return r.fulfill({ status: 201, contentType: "application/json", body: "[]" });
    }
    return json(r, [], 0);
  });

  // The dead zone. Auth is left alone: the session lives in localStorage and
  // the fixture's answer to /auth/v1/user is not a network call either way.
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.host.startsWith("localhost")) {
      if (!signal.dead) return route.fallback();
      try {
        await route.fulfill({ response: await route.fetch() });
      } catch {
        await route.abort();
      }
      return;
    }
    if (signal.dead && /\/(rest|storage|functions)\/v1\//.test(url.pathname)) {
      signal.refused += 1;
      return route.abort("internetdisconnected");
    }
    return route.fallback();
  });

  return server;
}

/**
 * Three photos already waiting in the outbox, written straight into its
 * IndexedDB store the way photos-upload.spec.ts seeds one — the capture
 * flow is proved elsewhere; what matters here is three uploads queued
 * BEFORE the clock-out.
 */
async function seedQueuedPhotos(page: Page, count: number) {
  await page.evaluate(
    async ({ count, email, project, png }) => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open("wops-write-outbox", 1);
        request.onupgradeneeded = () => request.result.createObjectStore("entries", { keyPath: "id" });
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const bytes = Uint8Array.from(atob(png), (c) => c.charCodeAt(0));
      const tx = db.transaction("entries", "readwrite");
      for (let i = 1; i <= count; i++) {
        const id = `ab000000-0000-4000-8000-00000000000${i}`;
        const entry = {
          v: 1,
          id,
          op: "photo_upload",
          payload: {
            bucket: "install-media",
            path: `${project}/feed/photo-${i}.png`,
            contentType: "image/png",
            projectId: project,
            createdBy: email,
            kind: "photo",
          },
          createdAt: Date.now() - 60_000 + i,
          attemptCount: 0,
          lastError: null,
          status: "queued",
          nextAttemptAt: 0,
          dependsOn: null,
          hasBlob: true,
        };
        tx.objectStore("entries").put({ id, meta: JSON.stringify(entry), blob: new Blob([bytes], { type: "image/png" }) });
      }
      await new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
      db.close();
    },
    { count, email: TEST_USER.email, project: BLACK22, png: TINY_PNG_BASE64 },
  );
}

/** Signal comes back: the browser's own `online` event is what wakes the outbox. */
async function signalReturns(page: Page, signal: Signal) {
  signal.dead = false;
  await page.context().setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
}

test.use({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });

test("a clock-in made with no signal shows as clocked in, survives a reload, and reaches the server exactly once", async ({
  page,
  context,
}) => {
  await useSupabaseFixtures(page, { role: "installer" });
  await hideWrongProjectBanner(page);
  await stubGeolocationDenied(page);
  const signal = new Signal();
  const server = await clockServer(page, signal, { openShift: null });

  await page.goto("/");
  const block = page.locator(".clockin-block");
  await expect(block).toBeVisible();
  const big = block.locator(".clock-btn.primary.big");
  await expect(big).toHaveText(/Start clock/);
  await expect(big).toBeEnabled();
  await expect(page.locator(".tab.clock-on")).toHaveCount(0);

  // Into the dead zone.
  signal.dead = true;
  await context.setOffline(true);

  // The block's own punch is refused with no signal and hands off to the
  // sheet, pre-filled; one more tap on Start queues it on this phone.
  await big.click();
  const sheet = page.locator(".clock-sheet");
  await expect(sheet).toBeVisible();
  await sheet.locator(".clock-btn.primary.big").click();

  // On the clock, from the phone's own copy — the nav says so, and the sheet
  // opened from it says where the punch stands and offers no Start.
  const clockTab = page.locator(".tab.clock-on");
  await expect(clockTab).toBeVisible();
  await clockTab.click();
  await expect(sheet).toBeVisible();
  await expect(sheet.locator(".clock-queue-line[data-kind=clock_in]")).toContainText("saved on this phone");
  await expect(sheet.locator(".clock-btn.primary.big")).toHaveCount(0);
  await expect(sheet.getByText("Where are you working?")).toHaveCount(0);
  await sheet.locator(".clock-sheet-x").click();
  expect(server.clockIns).toHaveLength(0);

  // A reload with no signal: the queue is on disk, so the person is still on
  // the clock and nothing offers a clock-in.
  await page.reload();
  await expect(clockTab).toBeVisible();
  await expect(page.locator(".clockin-block")).toHaveCount(0);
  await clockTab.click();
  await expect(sheet).toBeVisible();
  await expect(sheet.locator(".clock-queue-line[data-kind=clock_in]")).toContainText("saved on this phone");
  await expect(sheet.locator(".clock-btn.primary.big")).toHaveCount(0);
  expect(server.clockIns).toHaveLength(0);
  expect(signal.refused, "nothing was refused — the app was never cut off").toBeGreaterThan(0);

  // Signal returns: the one queued punch goes out, once, and the server's
  // shift takes over — the sheet stays on the clock the whole way.
  await signalReturns(page, signal);
  await expect.poll(() => server.clockIns.length).toBe(1);
  await expect(sheet.locator(".clock-queue-line")).toHaveCount(0);
  await expect(sheet.getByText("Where are you working?")).toHaveCount(0);
  await expect(clockTab).toBeVisible();
  expect(server.clockIns[0].p_client_id).toEqual(expect.any(String));
  expect(server.clockIns[0].p_project_id).toBe(BLACK22);

  // Still exactly one shift after the dust settles and another reload.
  await page.waitForTimeout(2_000);
  await page.reload();
  await expect(clockTab).toBeVisible();
  expect(server.clockIns).toHaveLength(1);
});

test("a clock-out queued behind three photos is the first thing sent when signal returns", async ({
  page,
  context,
}) => {
  await useSupabaseFixtures(page, { role: "installer" });
  await hideWrongProjectBanner(page);
  await stubGeolocationDenied(page);
  const signal = new Signal();
  const server = await clockServer(page, signal, { openShift: shiftRow() });

  await page.goto("/");
  const clockTab = page.locator(".tab.clock-on");
  await expect(clockTab).toBeVisible();

  signal.dead = true;
  await context.setOffline(true);

  // Three photos already waiting, then the clock-out, all with no signal.
  await seedQueuedPhotos(page, 3);
  await clockTab.click();
  const sheet = page.locator(".clock-sheet");
  await expect(sheet).toBeVisible();
  await sheet.locator(".clock-btn.out").click();
  await expect(sheet).toHaveCount(0);

  // Off the clock on this phone, and the landing says the clock-out is
  // saved here and waiting — no second Clock out anywhere.
  await expect(clockTab).toHaveCount(0);
  const line = page.locator(".clockin-block .clock-queue-line[data-kind=clock_out]");
  await expect(line).toContainText("saved on this phone");
  expect(server.writes).toEqual([]);

  await signalReturns(page, signal);
  await expect.poll(() => server.writes.filter((w) => w === "upload").length).toBe(3);
  expect(server.writes[0]).toBe("clock_out");
  expect(server.writes.filter((w) => w === "clock_out")).toHaveLength(1);
  await expect(page.locator(".clock-queue-line")).toHaveCount(0);
});
