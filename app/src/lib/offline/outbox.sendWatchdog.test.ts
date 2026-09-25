// The send watchdog on the real runtime (2026-09-25): the real outbox module
// on its in-memory store, the real photo handler, the server stubbed. The
// core's own tests (outbox.watchdog.test.ts) prove the mechanics with fake
// handlers; this proves the wiring the phone actually runs — the limits
// drain() hands the core, the line /diagnostics gets, and that the photo the
// watchdog gave up on lands once, on the same path and the same row key.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OutboxEntry } from "./outbox-core";
import { PHOTO_UPLOAD_TIMEOUT_MS, REQUEST_TIMEOUT_MS, TIMED_UPLOAD_BUCKETS } from "./weakSignal";

const upload = vi.fn();
const upsert = vi.fn();
vi.mock("../supabase", () => {
  // The outbox sends a write only as the person who queued it, through a
  // client bound to that person's token (2026-09-25): here, the same stub.
  const supabase = {
    storage: {
      from: (bucket: string) => ({
        upload: (path: string, blob: Blob, opts: Record<string, unknown>) => upload(bucket, path, blob, opts),
      }),
    },
    from: (table: string) => ({
      upsert: (row: Record<string, unknown>, opts: Record<string, unknown>) => upsert(table, row, opts),
      insert: () => Promise.resolve({ error: null }),
    }),
    auth: {
      getSession: async () => ({
        data: { session: { access_token: "test-token", user: { id: "test-user", email: "installer@example.test" } } },
        error: null,
      }),
    },
  };
  return { supabase, clientWithToken: () => supabase, supabaseConfigured: true };
});
vi.mock("../signedIn", () => ({
  signedInEmail: () => "installer@example.test",
  signedInUserId: () => "test-user",
  subscribeSignedIn: () => () => {},
}));
const logged = vi.fn();
vi.mock("./telemetry", () => ({ logOfflineEvent: (e: unknown) => logged(e) }));

const outbox = await import("./outbox");

const PROJECT = "11111111-1111-4111-8111-111111111111";
const PHOTO = new Blob([new Uint8Array(700 * 1024)], { type: "image/jpeg" });

function setOnline(value: boolean) {
  Object.defineProperty(navigator, "onLine", { value, configurable: true });
}

function photoEntry(bucket: string): OutboxEntry {
  return {
    id: "e1",
    op: bucket === "issue-photos" ? "issue_photo_upload" : "photo_upload",
    payload: { bucket, path: "x.jpg" },
    createdAt: 0,
    attemptCount: 0,
    lastError: null,
    status: "queued",
    nextAttemptAt: 0,
    hasBlob: true,
  };
}

beforeEach(() => {
  vi.useFakeTimers({ now: new Date("2026-09-25T06:00:00Z") });
  upload.mockReset();
  upsert.mockReset();
  logged.mockReset();
});
afterEach(() => {
  vi.useRealTimers();
  setOnline(true);
});

describe("the send watchdog on the phone's runtime", () => {
  it("gives up on a photo whose upload reply never arrives, sends the next one, says so in Recent events, and lands the first on its retry — once", async () => {
    setOnline(false);
    const first = await outbox.enqueueUpload({ kind: "photo", path: `${PROJECT}/feed/1.jpg`, contentType: "image/jpeg", projectId: PROJECT, createdBy: "installer@example.test", blob: PHOTO });
    // A beat between the two shots: the queue sends oldest first, and two
    // photos queued in the same (fake) millisecond would go in id order.
    await vi.advanceTimersByTimeAsync(1_000);
    const second = await outbox.enqueueUpload({ kind: "photo", path: `${PROJECT}/feed/2.jpg`, contentType: "image/jpeg", projectId: PROJECT, createdBy: "installer@example.test", blob: PHOTO });
    expect(outbox.getCounts().photos).toBe(2);

    // The first upload reaches the bucket and its reply never finishes.
    let calls = 0;
    upload.mockImplementation(() => (++calls === 1 ? new Promise(() => {}) : Promise.resolve({ data: {}, error: null })));
    upsert.mockResolvedValue({ error: null });

    setOnline(true);
    const drained = outbox.drain();
    // Back on Wi-Fi, the triggers keep coming while it is stuck; before the
    // watchdog each of these returned at once behind the `draining` flag.
    await vi.advanceTimersByTimeAsync(30_000);
    void outbox.drain();

    const limit = outbox.sendDeadlineMs(photoEntry("install-media"), PHOTO.size);
    await vi.advanceTimersByTimeAsync(limit);
    await drained;

    expect(upsert).toHaveBeenCalledTimes(1);
    expect(upsert.mock.calls[0][1]).toMatchObject({ client_id: second, storage_path: `install-media/${PROJECT}/feed/2.jpg` });
    expect(outbox.getCounts().photos).toBe(1);
    expect(logged).toHaveBeenCalledWith(
      expect.objectContaining({ type: "timeout", scope: "outbox", message: expect.stringMatching(/^photo_upload took over 360 s to send/) }),
    );

    // The retry, after its backoff.
    await vi.advanceTimersByTimeAsync(10_000);
    await outbox.drain();
    expect(outbox.getCounts().photos).toBe(0);

    // Same path both times, as an overwrite; one row per photo, keyed.
    const firstPaths = upload.mock.calls.filter((c) => c[1] === `${PROJECT}/feed/1.jpg`);
    expect(firstPaths).toHaveLength(2);
    for (const c of firstPaths) expect(c[3]).toMatchObject({ upsert: true });
    expect(upsert).toHaveBeenCalledTimes(2);
    expect(upsert.mock.calls.map((c) => c[1].client_id)).toEqual([second, first]);
    for (const c of upsert.mock.calls) expect(c[2]).toEqual({ onConflict: "client_id" });
  });
});

describe("the watchdog's limits", () => {
  it("gives a database-only send two minutes, and a send that has not read its file yet the same", () => {
    const json: OutboxEntry = { ...photoEntry("install-media"), op: "clock_in", hasBlob: false, payload: {} };
    expect(outbox.sendDeadlineMs(json, null)).toBe(2 * 60_000);
    expect(outbox.sendDeadlineMs(photoEntry("install-media"), null)).toBe(2 * 60_000);
    // Above every request deadline the busiest handler can stack up.
    expect(outbox.SEND_DEADLINE_MS).toBeGreaterThan(6 * REQUEST_TIMEOUT_MS);
  });

  it("is never tighter than the upload deadline a bucket already has", () => {
    for (const bucket of TIMED_UPLOAD_BUCKETS) {
      const ms = outbox.sendDeadlineMs(photoEntry(bucket), 25 * 1024 * 1024);
      expect(ms).toBeGreaterThan(PHOTO_UPLOAD_TIMEOUT_MS + 2 * outbox.SEND_DEADLINE_MS - 1);
    }
    expect(outbox.sendDeadlineMs(photoEntry("install-media"), 700 * 1024)).toBe(6 * 60_000);
  });

  it("scales with the file where the bucket has no upload deadline of its own", () => {
    // A 4 MB damage photo straight off the camera, at 4 KB/s: 1024 s to send.
    expect(outbox.sendDeadlineMs(photoEntry("issue-photos"), 4 * 1024 * 1024)).toBe(4 * 60_000 + 1_024_000);
    expect(outbox.sendDeadlineMs(photoEntry("issue-photos"), 40 * 1024)).toBe(4 * 60_000 + 10_000);
  });
});
