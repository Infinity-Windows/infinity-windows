// Offline install outbox: persist the full install intent (RPC args + media
// blobs + points) in IndexedDB BEFORE touching the network, then flush in
// ordered, idempotent steps. Crews in dead zones no longer lose installs.

import { awardPoints, type PointEntry } from "../points";
import {
  computeBackoffMs,
  errorMessage,
  isNetworkError,
  isRetryableError,
  MAX_ATTEMPTS,
} from "../offline/outbox-core";
import { supabase } from "../supabase";
import { submitInstallEvent, type SubmitInstallParams } from "./api";
import { enqueueUpload, flushQueue, type QueuedUploadMeta } from "./queue";

export type InstallOutboxStep =
  | "queued"
  | "rpc_done"
  | "points_done"
  | "media_done";

export interface InstallOutboxMediaMeta {
  bucket: "install-media" | "plansets";
  path: string;
  contentType: string;
  kind: "photo" | "voice_memo" | "video";
  /** Additive geo/feed fields captured at snap time (photos only). */
  lat?: number | null;
  lng?: number | null;
  accuracyM?: number | null;
  takenAt?: string | null;
}

export interface InstallOutboxPoints {
  profileId: string;
  entries: PointEntry[];
  ref: string;
  status: "pending" | "confirmed" | "void";
}

export interface InstallOutboxPayload {
  /** Client-generated key — survives retries; used to detect already-queued. */
  clientKey: string;
  openingId: string;
  projectId: string;
  openingCode: string;
  assignedWindowId: string | null;
  createdBy: string | null;
  submitParams: SubmitInstallParams;
  points: InstallOutboxPoints | null;
  media: InstallOutboxMediaMeta[];
  createdAt: string;
}

export interface InstallOutboxRecord {
  id: string;
  payload: InstallOutboxPayload;
  step: InstallOutboxStep;
  installEventId: string | null;
  /**
   * How many flush attempts have hit an error on this record. Capped at
   * MAX_ATTEMPTS (shared with the sibling outbox in ../offline/outbox-core)
   * so a permanently broken install — bad data, a window that got deleted —
   * stops retrying instead of quietly hammering the network every 30s
   * forever with nobody ever told.
   */
  attemptCount: number;
  /**
   * Earliest time (ms epoch) this record may be attempted again.
   *
   * Same field name and meaning as `nextAttemptAt` on the sibling outbox's
   * entries (../offline/outbox-core), so the two queues can be read as one
   * idea rather than two.
   *
   * WHY it exists (2026-09-04): this queue counted a failure and tried again
   * on the very next pass, with no wait at all. The pass runs every thirty
   * seconds AND on every "online" event, so eight failures — the cap — fit
   * inside about four minutes of ordinary "bars but no data", and a FINISHED
   * install dead-lettered on the phone of somebody standing in a house with
   * one bar. Spacing the same eight attempts on the sibling's curve (10s, 20s,
   * 40s, 80s, 160s, then the five-minute ceiling twice) buys about fifteen
   * minutes of bad signal instead of four.
   */
  nextAttemptAt: number;
  /** Plain-language reason for the last failure, or null if it hasn't failed. */
  lastError: string | null;
  /**
   * "failed" once attempts are exhausted or the error is permanent. The
   * record is kept either way — never deleted on failure — so it can be seen
   * and retried (or explicitly discarded) by a person instead of vanishing.
   */
  status: "pending" | "failed";
}

const DB_NAME = "wops-install-outbox";
const STORE = "installs";
const CURRENT_VERSION = 1;

const syncListeners = new Set<() => void>();

/** Notify Layout / OpeningSheet that pending sync counts may have changed. */
export function notifySyncListeners(): void {
  for (const cb of syncListeners) {
    try {
      cb();
    } catch {
      // listener errors must not break flush
    }
  }
}

export function subscribeSyncListeners(cb: () => void): () => void {
  syncListeners.add(cb);
  return () => {
    syncListeners.delete(cb);
  };
}

/** Pure: next step after a successful stage. */
export function nextInstallStep(step: InstallOutboxStep): InstallOutboxStep | "complete" {
  switch (step) {
    case "queued":
      return "rpc_done";
    case "rpc_done":
      return "points_done";
    case "points_done":
      return "media_done";
    case "media_done":
      return "complete";
  }
}

/** Pure: which network stage to attempt for this record. */
export function stageToAttempt(
  step: InstallOutboxStep,
): "rpc" | "points" | "media" | null {
  switch (step) {
    case "queued":
      return "rpc";
    case "rpc_done":
      return "points";
    case "points_done":
      return "media";
    case "media_done":
      return null;
  }
}

/**
 * Pure: may this record be attempted on this pass, or is it still inside the
 * wait a failure bought it?
 *
 * A record that has given up is never due — it is waiting on a person, and
 * the flush skips it for that reason rather than this one.
 */
export function isInstallDue(record: InstallOutboxRecord, now: number): boolean {
  return record.status !== "failed" && record.nextAttemptAt <= now;
}

/**
 * Pure: the record after one failed attempt.
 *
 * This is the install queue's own `applyFailure` (../offline/outbox-core has
 * the sibling's). It cannot simply call that one — an install record carries a
 * step, an event id and a payload that an outbox entry does not — but the
 * POLICY is deliberately identical: the same cap, the same backoff curve, the
 * same rule that a permanent refusal skips straight to failed instead of
 * burning through eight tries first.
 *
 * A record that has given up keeps whatever next-attempt time it had. It is
 * waiting on a person now, not on a clock, and Retry sets its own.
 */
export function applyInstallFailure(
  record: InstallOutboxRecord,
  err: unknown,
  now: number,
): InstallOutboxRecord {
  const attemptCount = record.attemptCount + 1;
  const givenUp = !isRetryableError(err) || attemptCount >= MAX_ATTEMPTS;
  return {
    ...record,
    attemptCount,
    lastError: errorMessage(err) || "Couldn't sync this install.",
    status: givenUp ? "failed" : "pending",
    nextAttemptAt: givenUp
      ? record.nextAttemptAt
      : now + computeBackoffMs(attemptCount),
  };
}

export function serializeInstallOutbox(record: InstallOutboxRecord): string {
  return JSON.stringify({ v: CURRENT_VERSION, ...record });
}

export function deserializeInstallOutbox(json: string): InstallOutboxRecord | null {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string") return null;
  if (
    r.step !== "queued" &&
    r.step !== "rpc_done" &&
    r.step !== "points_done" &&
    r.step !== "media_done"
  ) {
    return null;
  }
  if (typeof r.payload !== "object" || r.payload === null) return null;
  const p = r.payload as Record<string, unknown>;
  if (
    typeof p.clientKey !== "string" ||
    typeof p.openingId !== "string" ||
    typeof p.projectId !== "string" ||
    typeof p.openingCode !== "string" ||
    typeof p.submitParams !== "object" ||
    p.submitParams === null
  ) {
    return null;
  }
  return {
    id: r.id,
    step: r.step,
    installEventId: typeof r.installEventId === "string" ? r.installEventId : null,
    // Older rows written before failure-tracking existed have none of these
    // fields — default them to "never failed yet" rather than rejecting the
    // row (that would silently lose a real pending install).
    attemptCount: typeof r.attemptCount === "number" ? r.attemptCount : 0,
    // Records written before the retry spacing existed carry no
    // nextAttemptAt. 0 is the epoch — long past — so an install already
    // sitting on somebody's phone is due on the very next pass instead of
    // waiting forever for a time it was never given.
    nextAttemptAt: typeof r.nextAttemptAt === "number" ? r.nextAttemptAt : 0,
    lastError: typeof r.lastError === "string" ? r.lastError : null,
    status: r.status === "failed" ? "failed" : "pending",
    payload: {
      clientKey: p.clientKey,
      openingId: p.openingId,
      projectId: p.projectId,
      openingCode: p.openingCode,
      assignedWindowId:
        typeof p.assignedWindowId === "string" ? p.assignedWindowId : null,
      createdBy: typeof p.createdBy === "string" ? p.createdBy : null,
      submitParams: p.submitParams as SubmitInstallParams,
      points: (p.points as InstallOutboxPoints | null) ?? null,
      media: Array.isArray(p.media) ? (p.media as InstallOutboxMediaMeta[]) : [],
      createdAt:
        typeof p.createdAt === "string" ? p.createdAt : new Date().toISOString(),
    },
  };
}

// --- IndexedDB ---

interface InstallStoreRow {
  id: string;
  meta: string;
  blobs: Blob[];
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) {
        req.result.createObjectStore(STORE, { keyPath: "id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function requestAsPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function putRecord(record: InstallOutboxRecord, blobs: Blob[]): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(STORE, "readwrite");
  tx.objectStore(STORE).put({
    id: record.id,
    meta: serializeInstallOutbox(record),
    blobs,
  } satisfies InstallStoreRow);
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

async function removeRecord(id: string): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(STORE, "readwrite");
  tx.objectStore(STORE).delete(id);
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

async function listRows(): Promise<InstallStoreRow[]> {
  const db = await openDb();
  const rows = await requestAsPromise(
    db.transaction(STORE).objectStore(STORE).getAll(),
  );
  db.close();
  return rows as InstallStoreRow[];
}

/**
 * Count of installs still actively trying to sync. A failed install is NOT
 * "pending" — it has stopped retrying and needs a person — so it must not
 * count here, or the header pill would claim work is in flight when it has
 * actually given up. Counts by deserializing rather than IDB's cheap
 * `count()` because "pending" depends on a field inside the stored record,
 * not the row's existence.
 */
export async function pendingInstallCount(): Promise<number> {
  const rows = await listRows();
  let n = 0;
  for (const row of rows) {
    const record = deserializeInstallOutbox(row.meta);
    if (record && record.status !== "failed") n++;
  }
  return n;
}

/** Count of installs that gave up and are waiting on a person. Kept separate
 * from pendingInstallCount() so a screen can show "3 syncing" and "1 stuck"
 * as two different, honest numbers instead of one blended count. */
export async function failedInstallCount(): Promise<number> {
  const rows = await listRows();
  let n = 0;
  for (const row of rows) {
    const record = deserializeInstallOutbox(row.meta);
    if (record?.status === "failed") n++;
  }
  return n;
}

export interface EnqueueInstallInput {
  openingId: string;
  projectId: string;
  openingCode: string;
  assignedWindowId: string | null;
  createdBy: string | null;
  submitParams: SubmitInstallParams;
  points: InstallOutboxPoints | null;
  media: Array<InstallOutboxMediaMeta & { blob: Blob }>;
}

/**
 * Persist the full install intent locally FIRST. Returns the outbox id.
 * Call flushInstallOutbox() afterward to attempt the network path.
 */
export async function enqueueInstall(
  input: EnqueueInstallInput,
): Promise<InstallOutboxRecord> {
  const id = crypto.randomUUID();
  const clientKey = crypto.randomUUID();
  const media = input.media.map(({ blob: _b, ...meta }) => meta);
  const blobs = input.media.map((m) => m.blob);
  const record: InstallOutboxRecord = {
    id,
    step: "queued",
    installEventId: null,
    attemptCount: 0,
    // Due immediately: the first attempt is the one the person tapping Submit
    // is standing there waiting on.
    nextAttemptAt: Date.now(),
    lastError: null,
    status: "pending",
    payload: {
      clientKey,
      openingId: input.openingId,
      projectId: input.projectId,
      openingCode: input.openingCode,
      assignedWindowId: input.assignedWindowId,
      createdBy: input.createdBy,
      submitParams: input.submitParams,
      points: input.points,
      media,
      createdAt: new Date().toISOString(),
    },
  };
  await putRecord(record, blobs);
  notifySyncListeners();
  return record;
}

/**
 * The tail of the chain of flushes. Every call to `flushInstallOutbox` links
 * onto it, so two flushes never walk the store at the same time AND a caller
 * always gets a pass of its own.
 *
 * It used to be a boolean: a flush that arrived while one was running
 * returned `failedNow: []` on the spot, having attempted nothing. The 30s
 * background flush (lib/install/queue.ts) means that is not a rare window —
 * tap Submit while one is in flight and the sheet was told "queued", showed
 * "saved on this device", and the refusal that was coming landed in the next
 * background pass, which throws its refusals away. That is the exact bug this
 * branch exists to kill, reintroduced through the back door (review,
 * 2026-09-02). Waiting costs a person a second; not waiting costs them the
 * answer.
 */
let flushChain: Promise<void> = Promise.resolve();

/**
 * Refusals nobody has collected yet, keyed by outbox record id.
 *
 * A verdict belongs to the person who tapped Submit, but the pass that finds
 * it is not always the one they started: the background flush can pick up a
 * record a fraction of a second after `enqueueInstall` writes it, and it
 * discards what it finds. Parking the error here lets `submitInstallViaOutbox`
 * collect its OWN record's refusal whichever pass produced it. Bounded by the
 * outbox: keyed by record id, so a retry overwrites rather than adds, and
 * collecting removes.
 */
const unclaimedRefusals = new Map<string, unknown>();

/** Take this record's refusal, if one is waiting. Removes it. */
function claimRefusal(id: string): InstallRefusal | null {
  if (!unclaimedRefusals.has(id)) return null;
  const error = unclaimedRefusals.get(id);
  unclaimedRefusals.delete(id);
  return { id, error };
}

/**
 * An install the server refused outright, on its very first try, with signal.
 *
 * This is not "couldn't send it yet" — it is a verdict, and the person who
 * tapped Submit two seconds ago is standing there waiting to hear it. The
 * record still parks in Stuck writes either way; this only decides whether
 * they are told the real reason now or shown the "saved on this device" toast
 * and left to find out four minutes later that nothing saved.
 */
export interface InstallRefusal {
  /** Which outbox record was refused — the caller matches its own. */
  id: string;
  /** The raw error, so the caller can run it through formatApiError. */
  error: unknown;
}

export interface InstallFlushResult {
  synced: number;
  remaining: number;
  /**
   * Refusals from THIS pass, first attempt only. A list because a flush walks
   * every stored record and IndexedDB hands them back in key order, so the
   * one that just failed is not necessarily the one the caller enqueued.
   *
   * A submitter reads its own verdict through `claimRefusal` instead, which
   * survives the pass boundary; this list is what one pass saw.
   */
  failedNow: InstallRefusal[];
}

/**
 * Replay pending installs in order: RPC → points → enqueue media → drop.
 * Each step is marked complete before the next so a retry never re-runs a
 * finished stage. Media then rides the existing upload queue.
 *
 * Serialized: a call that arrives while another flush is running waits for it
 * and then does its own pass, rather than returning "nothing failed" without
 * having tried anything. See `flushChain`.
 */
export function flushInstallOutbox(): Promise<InstallFlushResult> {
  const run = flushChain.then(() => runFlushPass());
  // The chain must survive a pass that threw, or every later flush would be
  // stuck behind a rejected promise for the rest of the session.
  flushChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/**
 * Ask the auth client for the session once, before a pass touches the network.
 *
 * A phone that has been out of signal for an hour comes back holding an access
 * token the server will refuse. `getSession()` hands back the stored one and
 * refreshes it only when it has actually expired, so this costs a healthy
 * phone nothing and saves the one case that used to lose an install.
 *
 * Never throws, and never awaited more than once per pass: a refresh that
 * fails is not a reason to skip the drain. The writes still get their attempt,
 * and a token that genuinely will not work comes back as an ordinary retryable
 * error on the next one.
 */
async function refreshSessionQuietly(): Promise<void> {
  try {
    await supabase.auth.getSession();
  } catch {
    // Deliberately silent — see above. Killing the pass would be worse than
    // attempting it with the token we already have.
  }
}

async function runFlushPass(): Promise<InstallFlushResult> {
  let synced = 0;
  const failedNow: InstallRefusal[] = [];
  try {
    const rows = await listRows();
    // One clock reading for the whole pass, so two records that failed
    // together are judged against the same instant.
    const now = Date.now();
    const due: Array<{ row: InstallStoreRow; record: InstallOutboxRecord }> = [];
    for (const row of rows) {
      const record = deserializeInstallOutbox(row.meta);
      if (!record) {
        await removeRecord(row.id);
        continue;
      }
      // Already given up on — needs a person to hit retry or discard, not
      // another silent automatic attempt every 30s.
      if (record.status === "failed") continue;
      // Still inside the wait its last failure bought it. Skipping is the
      // whole point of the wait: without it, eight tries fit inside four
      // minutes of flaky signal and a finished install dead-letters.
      if (!isInstallDue(record, now)) continue;
      due.push({ row, record });
    }

    // Once, and only when there is something to send.
    if (due.length > 0) await refreshSessionQuietly();

    for (const { row, record } of due) {
      let current = record;
      const blobs = row.blobs ?? [];
      try {
        // RPC
        if (stageToAttempt(current.step) === "rpc") {
          const event = await submitInstallEvent(current.payload.submitParams);
          current = {
            ...current,
            step: "rpc_done",
            installEventId: event.id,
          };
          await putRecord(current, blobs);
        }

        // Points (optional — never block media if award fails, matching prior
        // OpeningSheet `.catch(() => {})` behavior; avoid double-award by
        // advancing the step even on failure).
        if (stageToAttempt(current.step) === "points") {
          const pts = current.payload.points;
          if (pts && pts.entries.length > 0) {
            try {
              await awardPoints(pts.profileId, pts.entries, pts.ref, pts.status);
            } catch {
              // Left unawarded; step still advances so media can sync.
            }
          }
          current = { ...current, step: "points_done" };
          await putRecord(current, blobs);
        }

        // Hand media to the upload queue, then drop the install record
        if (stageToAttempt(current.step) === "media") {
          const eventId = current.installEventId;
          for (let i = 0; i < current.payload.media.length; i++) {
            const meta = current.payload.media[i];
            const blob = blobs[i];
            if (!meta || !blob) continue;
            await enqueueUpload(
              {
                bucket: meta.bucket,
                path: meta.path,
                contentType: meta.contentType,
                kind: meta.kind,
                installEventId: eventId,
                windowId: current.payload.assignedWindowId,
                createdBy: current.payload.createdBy,
                projectId: current.payload.projectId,
                lat: meta.lat ?? null,
                lng: meta.lng ?? null,
                accuracyM: meta.accuracyM ?? null,
                takenAt: meta.takenAt ?? null,
              } satisfies Omit<QueuedUploadMeta, "id" | "createdAt">,
              blob,
            );
          }
          current = { ...current, step: "media_done" };
          await putRecord(current, blobs);
          await removeRecord(current.id);
          synced++;
        }
      } catch (err) {
        // A permanent error (bad data, a deleted window) will never succeed
        // no matter how many times we retry it, so it skips straight to
        // failed instead of burning through MAX_ATTEMPTS first. Anything else
        // is re-queued with a wait in front of it — see applyInstallFailure,
        // and the four-minute incident recorded on `nextAttemptAt` above.
        const permanent = !isRetryableError(err);
        current = applyInstallFailure(current, err, now);
        // Keep it either way — a failed row is never deleted, only marked,
        // so a person can see it and retry or discard it later. The step is
        // untouched, so a retry resumes instead of repeating a stage (like
        // the RPC) that already landed on the server.
        await putRecord(current, blobs);
        // First try, with signal, and the server said no on the merits: hand
        // the error back so the sheet can print the actual sentence. A dead
        // zone is a different thing entirely and still gets the calm queued
        // toast — being offline is not a verdict on anybody's install.
        if (permanent && current.attemptCount === 1 && !isNetworkError(err)) {
          failedNow.push({ id: current.id, error: err });
          // Also parked where the submitter can collect it, because the pass
          // that finds a refusal is not always the pass they started.
          unclaimedRefusals.set(current.id, err);
        }
      }
    }
  } finally {
    notifySyncListeners();
  }
  return { synced, remaining: await pendingInstallCount(), failedNow };
}

// --- stuck installs: seeing them, and doing something about them ---------
//
// Mirrors listFailed / retryFailed / discardFailed in lib/offline/outbox.ts —
// same shape of question (what gave up, can I try it again, can I throw it
// away) for the sibling outbox that carries installs instead of shifts/photos.

/** Every install that gave up, newest first. */
export async function listFailedInstalls(): Promise<InstallOutboxRecord[]> {
  const rows = await listRows();
  const failed: InstallOutboxRecord[] = [];
  for (const row of rows) {
    const record = deserializeInstallOutbox(row.meta);
    if (record && record.status === "failed") failed.push(record);
  }
  return failed.sort(
    (a, b) => Date.parse(b.payload.createdAt) - Date.parse(a.payload.createdAt),
  );
}

/**
 * Put one failed install back in the queue and try it now.
 *
 * Resets attemptCount/lastError but leaves `step` alone, so the retry resumes
 * from whatever stage it reached before it died instead of repeating a stage
 * (like the RPC that marks the window installed) that already landed.
 *
 * It also clears the automatic wait (`nextAttemptAt`), the same way the
 * sibling queue's `retryEntry` does. A person tapped Retry and is watching:
 * leaving a five-minute backoff in front of their tap would look like the
 * button does nothing.
 */
export async function retryFailedInstall(id: string): Promise<void> {
  const rows = await listRows();
  const row = rows.find((r) => r.id === id);
  if (!row) return;
  const record = deserializeInstallOutbox(row.meta);
  if (!record || record.status !== "failed") return;
  const revived: InstallOutboxRecord = {
    ...record,
    status: "pending",
    attemptCount: 0,
    nextAttemptAt: Date.now(),
    lastError: null,
  };
  await putRecord(revived, row.blobs ?? []);
  notifySyncListeners();
  await flushInstallOutbox();
}

/**
 * Throw one away for good.
 *
 * Deliberately explicit and one at a time: this destroys the record of a
 * window someone actually installed, so it has to be a decision a person
 * makes, never something a cleanup sweep does on its own.
 */
export async function discardFailedInstall(id: string): Promise<void> {
  await removeRecord(id);
  notifySyncListeners();
}

/**
 * Enqueue then immediately attempt flush (online path). Returns whether the
 * install RPC completed this call, or is waiting for signal — and, when the
 * server refused THIS install outright, the error that says why.
 *
 * `refused` is matched by record id rather than taken as "whatever failed in
 * that flush": a flush walks every stored install, and an old stuck one from
 * another window must never be reported as the reason this Submit didn't go
 * through.
 *
 * It is collected from the pending-refusals map rather than from this flush's
 * own `failedNow`, because the pass that discovers the verdict is not always
 * the one this call started — the 30s background flush can reach the record
 * first. Either way the answer belongs to the person standing there.
 */
export async function submitInstallViaOutbox(
  input: EnqueueInstallInput,
): Promise<{
  queued: boolean;
  remainingInstalls: number;
  remainingUploads: number;
  refused: InstallRefusal | null;
}> {
  const record = await enqueueInstall(input);
  const flush = await flushInstallOutbox();
  const uploads = await flushQueue();
  return {
    queued: flush.remaining > 0,
    remainingInstalls: flush.remaining,
    remainingUploads: uploads.remaining,
    refused: claimRefusal(record.id),
  };
}
