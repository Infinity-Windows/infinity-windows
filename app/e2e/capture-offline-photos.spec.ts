// Photos taken with the Capture button in a dead zone reach the server once
// signal comes back — the owner's own drill, 2026-09-24 (PECAN14, iPhone):
//
//   airplane mode → clock in → five photos through Capture (+) → airplane off
//
// and thirteen minutes later the pill still said "Photos 5" with nothing on
// the server. This walks the same taps against the real app: the clock-in is
// made through the clock sheet with no signal, the photos go through the
// Capture sheet's own shutter (a file pick — headless Chromium has no camera),
// optionally a reload while still offline (the force-quit), then signal
// returns and every photo must land: the bytes in the bucket, then the row.
//
// The dead zone is made the way queued-clock.spec.ts makes it: every Supabase
// call is refused outright, the app's own files are passed through so a reload
// works offline, and the refusals are counted so a run where the app quietly
// reached the server cannot pass.

import { expect, test, type Page } from "@playwright/test";
import { TEST_USER, jobFixtures, useSupabaseFixtures } from "./support/supabaseFixtures";
import { hideWrongProjectBanner, json, pngFile, stubGeolocationDenied } from "./support/specHelpers";

const BLACK22 = jobFixtures().find((j) => j.jobCode === "BLACK22")!;
const PROJECT_ID = BLACK22.projectId;
const GENERAL = "11111111-aaaa-4aaa-8aaa-111111111111";
const SHIFT_ID = "55555555-eeee-4eee-8eee-555555555555";

const PROJECT = { id: PROJECT_ID, job_code: "BLACK22", name: "Black Desert", address: null, status: "active" };
const COST_CODES = [
  { id: GENERAL, code: "000", label: "General", description: null, active: true, sort_order: 5, is_general: true },
];
const hoursAgo = (h: number) => new Date(Date.now() - h * 3600_000).toISOString();
const RECENT_SHIFTS = [
  { project_id: PROJECT_ID, cost_code_id: GENERAL, clock_in_at: hoursAgo(26), projects: { job_code: "BLACK22", name: "Black Desert" } },
];

type Row = Record<string, unknown>;

function shiftRow(over: Row = {}): Row {
  return {
    id: SHIFT_ID,
    profile_id: TEST_USER.id,
    project_id: PROJECT_ID,
    cost_code_id: GENERAL,
    clock_in_at: hoursAgo(1),
    clock_out_at: null,
    break_seconds: 0,
    break_started_at: null,
    break_type: null,
    injured: null,
    time_confirmed: null,
    status: "open",
    created_at: hoursAgo(1),
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

class Signal {
  dead = false;
  refused = 0;
}

interface Server {
  writes: string[];
  uploads: string[];
  rows: Row[];
}

async function fieldServer(page: Page, signal: Signal): Promise<Server> {
  const server: Server = { writes: [], uploads: [], rows: [] };
  let openShift: Row | null = null;

  await page.route("**/rest/v1/projects**", (r) => json(r, [PROJECT], 1));
  await page.route("**/rest/v1/safety_talks**", (r) => {
    const accept = r.request().headers()["accept"] ?? "";
    return accept.includes("pgrst.object") ? json(r, null, 0) : json(r, [], 0);
  });
  await page.route("**/rest/v1/toolbox_completions**", (r) => json(r, [], 0));
  await page.route("**/rest/v1/cost_codes**", (r) => json(r, COST_CODES, COST_CODES.length));
  await page.route("**/rest/v1/project_cost_codes**", (r) => json(r, [], 0));
  await page.route("**/rest/v1/time_shifts**", (r) => {
    const url = new URL(r.request().url());
    if ((url.searchParams.get("status") ?? "").startsWith("in.")) {
      return json(r, openShift ? [openShift] : [], openShift ? 1 : 0);
    }
    if ((url.searchParams.get("project_id") ?? "").startsWith("in.")) return json(r, [], 0);
    return json(r, RECENT_SHIFTS, RECENT_SHIFTS.length);
  });
  await page.route(
    (url) => /\/rest\/v1\/rpc\/server_now(\?|$)/.test(url.href),
    (r) => json(r, new Date().toISOString(), null),
  );
  await page.route(
    (url) => /\/rest\/v1\/rpc\/clock_in(\?|$)/.test(url.href),
    (r) => {
      const body = (r.request().postDataJSON() ?? {}) as Row;
      server.writes.push("clock_in");
      openShift = shiftRow({
        client_id: body.p_client_id ?? null,
        clock_in_at: new Date().toISOString(),
        created_at: new Date().toISOString(),
      });
      return json(r, openShift, null);
    },
  );
  await page.route("**/storage/v1/object/**", (r) => {
    const url = r.request().url();
    if (url.includes("/object/sign/")) return json(r, { signedURL: "/fixture.jpg" });
    if (r.request().method() === "POST" || r.request().method() === "PUT") {
      server.writes.push("upload");
      server.uploads.push(new URL(url).pathname);
    }
    return json(r, { Key: "install-media/e2e" }, null);
  });
  await page.route("**/rest/v1/attachments**", (r) => {
    if (r.request().method() === "POST") {
      server.writes.push("attachment");
      const body = r.request().postDataJSON();
      for (const row of Array.isArray(body) ? body : [body]) server.rows.push(row as Row);
      return r.fulfill({ status: 201, contentType: "application/json", body: "[]" });
    }
    return json(r, [], 0);
  });

  // The dead zone, registered last so it wins while the signal is off.
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

async function signalReturns(page: Page, signal: Signal) {
  signal.dead = false;
  await page.context().setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
}

const captureFab = (page: Page) => page.getByRole("button", { name: "Quick capture" });
const captureSheet = (page: Page) => page.getByRole("dialog", { name: "Quick capture" });
const photoSheet = (page: Page) => page.getByRole("dialog", { name: "Add job photos" });

/** Clock in through the landing block with no signal (queued-clock.spec.ts). */
async function clockInOffline(page: Page) {
  const block = page.locator(".clockin-block");
  await expect(block).toBeVisible();
  const big = block.locator(".clock-btn.primary.big");
  await expect(big).toHaveText(/Start clock/);
  await big.click();
  const sheet = page.locator(".clock-sheet");
  await expect(sheet).toBeVisible();
  await sheet.locator(".clock-btn.primary.big").click();
  // Before #644 a queued clock-in did not show as clocked in, so wait for the
  // punch to reach the queue rather than for the nav to say so.
  await expect.poll(() => queuedOps(page).then((ops) => ops.filter((o) => o.op === "clock_in").length)).toBe(1);
  if (await sheet.isVisible()) await sheet.locator(".clock-sheet-x").click();
}

/** What the phone's outbox holds right now. */
async function queuedOps(page: Page) {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open("wops-write-outbox", 1);
      req.onupgradeneeded = () => req.result.createObjectStore("entries", { keyPath: "id" });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    const rows = await new Promise<{ meta: string }[]>((resolve, reject) => {
      const req = db.transaction("entries").objectStore("entries").getAll();
      req.onsuccess = () => resolve(req.result as { meta: string }[]);
      req.onerror = () => reject(req.error);
    });
    db.close();
    return rows.map((r) => {
      const m = JSON.parse(r.meta);
      return {
        op: m.op as string,
        status: m.status as string,
        attempts: m.attemptCount as number,
        lastError: m.lastError as string | null,
        dependsOn: m.dependsOn as string | null,
        projectId: (m.payload?.projectId ?? null) as string | null,
      };
    });
  });
}

/** N photos through Capture → Take a photo, one file pick per shot. */
async function capturePhotos(page: Page, n: number) {
  await captureFab(page).click();
  await expect(captureSheet(page)).toBeVisible();
  await captureSheet(page).getByText("Take a photo", { exact: true }).click();
  // Primed from the (queued) shift since #644; before it, the sheet asks.
  const pick = captureSheet(page).getByRole("button", { name: /BLACK22/ }).first();
  await expect(photoSheet(page).or(pick)).toBeVisible();
  if (!(await photoSheet(page).isVisible())) await pick.click();
  await expect(photoSheet(page)).toBeVisible();
  const input = page.locator('input[type="file"][accept="image/*"]').first();
  for (let i = 1; i <= n; i++) {
    await input.setInputFiles(pngFile(`shot-${i}.png`));
    await expect(photoSheet(page).getByText(new RegExp(`${i} photos? waiting to upload`))).toBeVisible();
  }
  await photoSheet(page).getByRole("button", { name: "Close", exact: true }).click();
}


test.use({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });

for (const reload of [false, true]) {
  test(`photos captured with no signal after an offline clock-in upload when signal returns${reload ? " (reloaded offline)" : ""}`, async ({
    page,
    context,
  }) => {
    await useSupabaseFixtures(page, { role: "installer" });
    await hideWrongProjectBanner(page);
    await stubGeolocationDenied(page);
    const signal = new Signal();
    const server = await fieldServer(page, signal);

    await page.goto("/");
    await expect(page.locator(".clockin-block")).toBeVisible();
    // Open Capture once with signal, the way a phone that has been used today
    // already holds the jobs list, then close it.
    await captureFab(page).click();
    await expect(captureSheet(page)).toBeVisible();
    await captureSheet(page).getByRole("button", { name: /Find a job/ }).click();
    await expect(captureSheet(page).getByRole("button", { name: /BLACK22/ }).first()).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(captureSheet(page)).toHaveCount(0);

    // Into the dead zone.
    signal.dead = true;
    await context.setOffline(true);

    await clockInOffline(page);
    await capturePhotos(page, 3);

    // What the phone holds before signal returns: one punch, three photos.
    const queued = await queuedOps(page);
    console.log("queued before signal:", JSON.stringify(queued));
    expect(queued.filter((q) => q.op === "clock_in")).toHaveLength(1);
    expect(queued.filter((q) => q.op === "photo_upload")).toHaveLength(3);
    expect(server.writes).toEqual([]);

    if (reload) {
      await page.reload();
      await expect(page.locator(".tab.clock-on")).toBeVisible();
    }
    expect(signal.refused, "the app was never cut off").toBeGreaterThan(0);

    await signalReturns(page, signal);

    await expect
      .poll(() => server.writes.filter((w) => w === "clock_in").length, { timeout: 30_000 })
      .toBe(1);
    await expect
      .poll(() => server.uploads.length, { timeout: 60_000, message: `writes so far: ${server.writes.join(",")}` })
      .toBe(3);
    await expect.poll(() => server.rows.length, { timeout: 30_000 }).toBe(3);
    expect(server.rows.every((r) => r.project_id === PROJECT_ID)).toBe(true);
    console.log("server writes in order:", server.writes.join(","));
    await expect(page.getByText(/Photos \d/)).toHaveCount(0);
    expect(await queuedOps(page)).toEqual([]);
  });
}
