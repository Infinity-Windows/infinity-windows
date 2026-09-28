// A returning, fixture-signed-in phone carrying real IndexedDB work through
// the installed app's offline cold start and a production-build update.
// Supabase is a non-resolving fixture host; this proves browser behavior, not
// a real crew login, native iPhone storage, or a production server receipt.
import { expect, test, type Page } from "@playwright/test";
import { TEST_USER, useSupabaseFixtures } from "./support/supabaseFixtures";
import { TINY_PNG_BASE64, hideWrongProjectBanner, json, stubGeolocationDenied } from "./support/specHelpers";
import {
  cutTheNetwork,
  failedAppFiles,
  harnessState,
  nudgeUpdateCheck,
  runningEntry,
  serveBuild,
  serviceWorkerReady,
} from "./support/pwa";

const PROJECT = "ebf64f94-0413-4434-aeb3-1aff228fb5b3";
const COST_CODE = "11111111-aaaa-4aaa-8aaa-111111111111";
const SHIFT = "55555555-eeee-4eee-8eee-555555555555";
const PHOTO = "ab000000-0000-4000-8000-000000000001";

async function seedPhoto(page: Page) {
  // Capture UI has its own e2e coverage. This seed isolates whether a photo
  // already saved on the phone keeps its exact bytes and owner through update.
  await page.evaluate(async ({ id, email, project, png }) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("wops-write-outbox", 1);
      request.onupgradeneeded = () => request.result.createObjectStore("entries", { keyPath: "id" });
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const bytes = Uint8Array.from(atob(png), (c) => c.charCodeAt(0));
    const meta = {
      v: 1, id, op: "photo_upload",
      payload: {
        bucket: "install-media", path: `${project}/feed/photo-${id}.png`,
        contentType: "image/png", projectId: project, createdBy: email, kind: "photo",
      },
      createdAt: Date.now() - 60_000, attemptCount: 0, lastError: null,
      status: "queued", nextAttemptAt: 0, dependsOn: null, hasBlob: true,
    };
    const tx = db.transaction("entries", "readwrite");
    tx.objectStore("entries").put({ id, meta: JSON.stringify(meta), blob: new Blob([bytes], { type: "image/png" }) });
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  }, { id: PHOTO, email: TEST_USER.email, project: PROJECT, png: TINY_PNG_BASE64 });
}

async function queuedIds(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("wops-write-outbox", 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const tx = db.transaction("entries", "readonly");
    const request = tx.objectStore("entries").getAll();
    const rows = await new Promise<{ id: string }[]>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    db.close();
    return rows.map((row) => row.id).sort();
  });
}

async function queuedSnapshot(page: Page) {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("wops-write-outbox", 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const request = db.transaction("entries", "readonly").objectStore("entries").getAll();
    const rows = await new Promise<{ id: string; meta: string; blob?: Blob }[]>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    db.close();
    return Promise.all(rows.map(async (row) => {
      const meta = JSON.parse(row.meta) as {
        op: string;
        payload?: { createdBy?: string; projectId?: string; tappedAt?: string; clientId?: string };
      };
      return {
        id: row.id, op: meta.op, owner: meta.payload?.createdBy ?? null,
        projectId: meta.payload?.projectId ?? null,
        tappedAt: meta.payload?.tappedAt ?? null, clientId: meta.payload?.clientId ?? null,
        blobType: row.blob?.type ?? null,
        blobBytes: row.blob ? Array.from(new Uint8Array(await row.blob.arrayBuffer())) : [],
      };
    })).then((snapshot) => snapshot.sort((a, b) => a.id.localeCompare(b.id)));
  });
}

test("fixture-signed-in queued clock and photo survive upgrade, offline relaunch, and reconnection", async ({ page, context, request }) => {
  const { builds } = await harnessState(request);
  const state = { backendDown: false, refused: 0, writes: [] as string[], clockOuts: [] as unknown[], photos: [] as unknown[] };
  await useSupabaseFixtures(page, { role: "installer" });
  await hideWrongProjectBanner(page);
  await stubGeolocationDenied(page);

  const openShift = {
    id: SHIFT, profile_id: TEST_USER.id, project_id: PROJECT, cost_code_id: COST_CODE,
    clock_in_at: new Date(Date.now() - 2 * 3600_000).toISOString(), clock_out_at: null,
    break_seconds: 0, break_started_at: null, break_type: null, injured: null,
    time_confirmed: null, status: "open", created_at: new Date(Date.now() - 2 * 3600_000).toISOString(),
    note: null, clocked_in_by: null, clocked_out_by: null,
    projects: { job_code: "BLACK22", name: "Black Desert" },
    cost_codes: { code: "000", label: "General" },
    profiles: { display_name: "E2E Fixture" }, editor: null, voider: null,
  };
  let activeShift: typeof openShift | null = openShift;
  await page.route("**/rest/v1/time_shifts**", (r) => {
    const status = new URL(r.request().url()).searchParams.get("status") ?? "";
    return json(r, status.startsWith("in.") ? (activeShift ? [activeShift] : []) : [], 0);
  });
  await page.route("**/rest/v1/rpc/clock_out**", (r) => {
    state.writes.push("clock_out");
    state.clockOuts.push(r.request().postDataJSON());
    activeShift = null;
    return json(r, { ...openShift, status: "submitted", clock_out_at: new Date().toISOString() }, null);
  });
  await page.route("**/storage/v1/object/install-media/**", (r) => {
    state.writes.push("upload");
    return json(r, { Key: "install-media/e2e" }, null);
  });
  await page.route("**/rest/v1/attachments**", (r) => {
    if (r.request().method() === "POST") {
      state.writes.push("attachment");
      const body = r.request().postDataJSON();
      state.photos.push(...(Array.isArray(body) ? body : [body]));
      return r.fulfill({ status: 201, contentType: "application/json", body: "[]" });
    }
    return json(r, [], 0);
  });
  // Route interception happens after the shared fixture routes. It refuses
  // writes during the dead zone and update, while auth stays fixture-backed.
  await page.route(/https:\/\/e2efixture\.supabase\.co\/(rest|storage|functions)\/v1\//, (r) => {
    if (state.backendDown) {
      state.refused++;
      return r.abort("internetdisconnected");
    }
    return r.fallback();
  });

  await serveBuild(request, "old");
  await page.goto("/");
  await expect(page.locator(".tab.clock-on")).toBeVisible();
  await serviceWorkerReady(page);
  expect(await runningEntry(page)).toBe(builds.old.entry);

  state.backendDown = true;
  await context.setOffline(true);
  await seedPhoto(page);
  await page.locator(".tab.clock-on").click();
  await page.locator(".clock-sheet .clock-btn.out").click();
  await expect(page.locator(".clockin-block .clock-queue-line[data-kind=clock_out]")).toContainText("saved on this phone");
  const pending = await queuedIds(page);
  expect(pending).toHaveLength(2);
  expect(pending).toContain(PHOTO);
  const before = await queuedSnapshot(page);
  expect(before.find((row) => row.id === PHOTO)).toMatchObject({
    op: "photo_upload", owner: TEST_USER.email, projectId: PROJECT,
  });
  expect(before.find((row) => row.id === PHOTO)?.blobType).toBe("image/png");
  expect(before.find((row) => row.id === PHOTO)?.blobBytes.length).toBeGreaterThan(0);
  const clock = before.find((row) => row.id !== PHOTO);
  expect(clock?.op).toBe("clock_out");
  expect(clock?.tappedAt).toEqual(expect.any(String));
  expect(clock?.clientId).toEqual(expect.any(String));
  expect(state.writes).toEqual([]);

  // The app may fetch its update with signal while business writes remain
  // refused. That lets us inspect the queue after takeover and before sync.
  await context.setOffline(false);
  await serveBuild(request, "new");
  await nudgeUpdateCheck(page);
  // Queued work deliberately blocks automatic takeover. The person chooses
  // Refresh after seeing that the work is saved on this phone.
  await expect(page.locator(".pwa-banner-update .pwa-banner-action")).toBeVisible();
  await page.locator(".pwa-banner-update .pwa-banner-action").click();
  await expect.poll(() => runningEntry(page), { timeout: 120_000 }).toBe(builds.new.entry);
  expect(await queuedIds(page)).toEqual(pending);
  expect(await queuedSnapshot(page)).toEqual(before);
  await expect(page.locator(".sync-pill-text:visible").first()).toContainText("Clock 1");
  await expect(page.locator(".sync-pill-text:visible").first()).toContainText("Photos 1");
  expect(state.writes).toEqual([]);

  const failed = failedAppFiles(page);
  await cutTheNetwork(page, context);
  await page.reload();
  expect(await queuedIds(page)).toEqual(pending);
  expect(await queuedSnapshot(page)).toEqual(before);
  await expect(page.locator(".sync-pill-text:visible").first()).toContainText("Clock 1");
  await expect(page.locator(".sync-pill-text:visible").first()).toContainText("Photos 1");
  expect(failed, "the signed-in shell asked for a file missing from the new worker cache").toEqual([]);

  await context.setOffline(false);
  state.backendDown = false;
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect.poll(() => state.clockOuts.length, { timeout: 60_000 }).toBe(1);
  await expect.poll(() => state.photos.length, { timeout: 60_000 }).toBe(1);
  // The photo was queued a minute before the clock-out. The outbox must send
  // the timekeeping change first despite that earlier photo timestamp.
  expect(state.writes[0]).toBe("clock_out");
  expect(await queuedIds(page)).toEqual([]);
  expect(state.refused).toBeGreaterThan(0);
  expect(state.clockOuts[0]).toMatchObject({
    p_tapped_at: clock?.tappedAt, p_client_id: clock?.clientId,
  });
  expect(state.photos[0]).toMatchObject({
    client_id: PHOTO, created_by: TEST_USER.email, project_id: PROJECT, kind: "photo",
  });
  await page.reload();
  expect(state.clockOuts).toHaveLength(1);
  expect(state.photos).toHaveLength(1);
});

test("known #654 gap: a warmed signed-in landing should reopen without a profile response", async ({ page, context, request }) => {
  // #654 owns the profile/session fix. Keep this acceptance check executable
  // against the production bundle without turning #669's release suite red.
  // Remove test.fail when #654 lands, then require the assertion to pass.
  await useSupabaseFixtures(page, { role: "installer" });
  await hideWrongProjectBanner(page);
  await serveBuild(request, "new");
  await page.goto("/");
  await expect(page.locator(".clockin-block")).toBeVisible();
  await serviceWorkerReady(page);
  // Warmth alone does not help when myRealProfile is excluded from the
  // persisted query roots (queryKeys.ts), so the next launch waits on a read.
  const saved = await page.evaluate(() => localStorage.getItem("wops-query-cache") ?? "");
  expect(saved).not.toContain('"myRealProfile"');
  let refused = 0;
  await page.route("**/rest/v1/**", (r) => {
    refused++;
    return r.abort("internetdisconnected");
  });
  await cutTheNetwork(page, context);
  const failed = failedAppFiles(page);
  await page.reload();
  expect(failed, "new-build app files missing from the worker cache").toEqual([]);
  await expect.poll(() => refused).toBeGreaterThan(0);
  test.fail(true, "#654 must make the signed-in landing usable without a profile response");
  await expect(page.locator(".clockin-block"), "the signed-in landing remains visible offline").toBeVisible({ timeout: 8_000 });
});
