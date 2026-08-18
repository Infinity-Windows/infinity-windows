// Runtime for the global offline write outbox. Ties the pure core + IndexedDB
// store + Supabase handlers together, exposes enqueue helpers for each write,
// and keeps the queue draining whenever connectivity returns.
//
// This is deliberately a SEPARATE module from the install-flow outbox
// (lib/install/*), which is untouched.

import {
  retryEntry,
  type OutboxEntry,
  countsByOp,
  drainStore,
  makeEntry,
  requeueStranded,
  type OpCounts,
  type OutboxInput,
  type OutboxStore,
} from "./outbox-core";
import { createDefaultStore } from "./outboxStore";
import {
  createShiftResolver,
  createSupabaseHandlers,
  pendingShiftRef,
  type ShiftResolver,
} from "./outboxHandlers";

/** Cap on a single queued blob (photo/receipt). Bigger uploads fail loudly. */
export const MAX_BLOB_BYTES = 25 * 1024 * 1024; // 25 MB

const store: OutboxStore = createDefaultStore();
const resolver: ShiftResolver = createShiftResolver();
const handlers = createSupabaseHandlers(resolver);

const listeners = new Set<() => void>();
const syncedListeners = new Set<() => void>();
let cachedCounts: OpCounts = countsByOp([]);
let draining = false;
let wired = false;

function newId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `id-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function isOnline(): boolean {
  return typeof navigator === "undefined" || navigator.onLine !== false;
}

/** Recompute cached counts and notify subscribers (pill, hooks). */
async function refresh(): Promise<void> {
  try {
    cachedCounts = countsByOp(await store.getAll());
  } catch {
    /* keep last known counts */
  }
  for (const cb of listeners) {
    try {
      cb();
    } catch {
      /* a listener must never break the queue */
    }
  }
}

export function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/**
 * Fires after a drain that actually sent something, so the UI can refetch the
 * real server state (e.g. replace an optimistic pending shift with the synced
 * one). Separate from `subscribe`, which fires on every count change.
 */
export function subscribeSynced(cb: () => void): () => void {
  syncedListeners.add(cb);
  return () => syncedListeners.delete(cb);
}

export function getCounts(): OpCounts {
  return cachedCounts;
}

/** Thrown when a blob is too big to safely persist offline. Handled at call sites. */
export class BlobTooLargeError extends Error {
  readonly bytes: number;
  constructor(bytes: number) {
    super(
      `This file is too large to save offline (${Math.round(bytes / 1024 / 1024)} MB). Please try a smaller photo.`,
    );
    this.name = "BlobTooLargeError";
    this.bytes = bytes;
  }
}

export class OutboxStorageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OutboxStorageError";
  }
}

/**
 * Add a write to the outbox. Idempotent by client id — enqueuing the same id
 * twice is a no-op. Returns the entry id (the idempotency key). Immediately
 * attempts a drain when online so healthy connections write straight through.
 */
export async function enqueue(
  input: OutboxInput,
  blob?: Blob | null,
): Promise<string> {
  const id = newId();
  if (blob != null) {
    if (blob.size > MAX_BLOB_BYTES) throw new BlobTooLargeError(blob.size);
  }
  const entry = makeEntry(input, id, Date.now());
  try {
    await store.put(entry, blob ?? null);
  } catch (err) {
    // Almost always a storage-quota error — surface clearly instead of crashing.
    throw new OutboxStorageError(
      `Couldn't save this offline (storage may be full): ${(err as Error)?.message ?? err}`,
    );
  }
  await refresh();
  // Fire-and-forget immediate drain; the write is already durably queued.
  if (isOnline()) void drain();
  return id;
}

/** Drain the queue once. Safe to call often; only one drain runs at a time. */
export async function drain(): Promise<void> {
  if (draining || !isOnline()) return;
  draining = true;
  try {
    const res = await drainStore(store, handlers, {
      onChange: () => void refresh(),
    });
    if (res.sent > 0) {
      for (const cb of syncedListeners) {
        try {
          cb();
        } catch {
          /* a listener must never break the queue */
        }
      }
    }
  } catch {
    /* transient — next trigger retries */
  } finally {
    draining = false;
    await refresh();
  }
}

/** Re-queue anything left mid-flight by a reload, then drain. Call on startup. */
export async function recoverAndDrain(): Promise<void> {
  try {
    const all = await store.getAll();
    const now = Date.now();
    for (const e of all) {
      const fixed = requeueStranded(e, now);
      if (fixed !== e) await store.put(fixed);
    }
  } catch {
    /* ignore */
  }
  await refresh();
  await drain();
}

let intervalId: ReturnType<typeof setInterval> | null = null;

/**
 * Wire the background drainer once per session: on reconnect, on tab focus,
 * and on a slow interval (flaky LTE can keep `onLine` true while writes fail).
 */
export function initOutboxAutoFlush(): void {
  if (wired || typeof window === "undefined") return;
  wired = true;

  window.addEventListener("online", () => void drain());
  document.addEventListener?.("visibilitychange", () => {
    if (document.visibilityState === "visible") void drain();
  });
  window.addEventListener("focus", () => void drain());

  intervalId = setInterval(() => {
    if (isOnline()) void drain();
  }, 30_000);

  void recoverAndDrain();
}

/** For tests / teardown. */
export function stopOutboxAutoFlush(): void {
  if (intervalId != null) clearInterval(intervalId);
  intervalId = null;
  wired = false;
}

// --- op-specific enqueue helpers ----------------------------------------

export interface ClockInInput {
  projectId: string | null;
  costCodeId: string | null;
  lat?: number | null;
  lng?: number | null;
  /** Optional worker note for the office, carried through to sync. */
  note?: string | null;
}

/** Enqueue a clock-in. Returns the entry id, usable as a pending shift ref. */
export function enqueueClockIn(input: ClockInInput): Promise<string> {
  return enqueue({
    op: "clock_in",
    payload: {
      projectId: input.projectId,
      costCodeId: input.costCodeId,
      lat: input.lat ?? null,
      lng: input.lng ?? null,
      note: input.note ?? null,
    },
  });
}

export interface ClockOutInput {
  /** Real shift id, or an offline clock-in entry id (see pendingRefForShift). */
  shiftRef: string;
  injured: boolean;
  timeConfirmed: boolean;
  breakSeconds: number;
  lat?: number | null;
  lng?: number | null;
}

export function enqueueClockOut(input: ClockOutInput): Promise<string> {
  const dependsOn = refDependency(input.shiftRef);
  return enqueue({
    op: "clock_out",
    dependsOn,
    payload: {
      shiftRef: input.shiftRef,
      injured: input.injured,
      timeConfirmed: input.timeConfirmed,
      breakSeconds: input.breakSeconds,
      lat: input.lat ?? null,
      lng: input.lng ?? null,
    },
  });
}

export function enqueueBreakStart(shiftRef: string, breakType: string): Promise<string> {
  return enqueue({
    op: "break_start",
    dependsOn: refDependency(shiftRef),
    payload: { shiftRef, breakType },
  });
}

export function enqueueBreakStop(shiftRef: string): Promise<string> {
  return enqueue({
    op: "break_stop",
    dependsOn: refDependency(shiftRef),
    payload: { shiftRef },
  });
}

export interface UploadInput {
  kind: "photo" | "receipt";
  bucket?: string;
  path: string;
  contentType: string;
  windowId?: string | null;
  installEventId?: string | null;
  createdBy?: string | null;
  /** Job this media belongs to (feed + per-job filtering). */
  projectId?: string | null;
  lat?: number | null;
  lng?: number | null;
  accuracyM?: number | null;
  /** ISO capture time; distinct from the server's created_at. */
  takenAt?: string | null;
  caption?: string | null;
  blob: Blob;
}

export function enqueueUpload(input: UploadInput): Promise<string> {
  return enqueue(
    {
      op: input.kind === "receipt" ? "receipt_upload" : "photo_upload",
      hasBlob: true,
      payload: {
        bucket: input.bucket ?? "install-media",
        path: input.path,
        contentType: input.contentType,
        // attachments.kind has no 'receipt' — receipts store as 'document'.
        kind: input.kind === "receipt" ? "document" : "photo",
        windowId: input.windowId ?? null,
        installEventId: input.installEventId ?? null,
        createdBy: input.createdBy ?? null,
        projectId: input.projectId ?? null,
        lat: input.lat ?? null,
        lng: input.lng ?? null,
        accuracyM: input.accuracyM ?? null,
        takenAt: input.takenAt ?? null,
        caption: input.caption ?? null,
      },
    },
    input.blob,
  );
}

export interface DailyLogInput {
  projectId: string | null;
  profileId: string | null;
  logDate: string;
  notes: string;
  createdBy?: string | null;
}

export function enqueueDailyLog(input: DailyLogInput): Promise<string> {
  return enqueue({
    op: "daily_log",
    payload: {
      projectId: input.projectId,
      profileId: input.profileId,
      logDate: input.logDate,
      notes: input.notes,
      createdBy: input.createdBy ?? null,
    },
  });
}

/**
 * Queue an undo of ONE recorded mark move. Carries the move's id, so a press
 * made with no signal walks back that exact move whenever the phone reconnects.
 */
export function enqueuePinUndo(moveId: string): Promise<string> {
  return enqueue({ op: "pin_undo", payload: { moveId } });
}

/** Queue "put every mark on this job back where the plan put it". */
export function enqueuePinResetProject(projectId: string): Promise<string> {
  return enqueue({ op: "pin_reset_project", payload: { projectId } });
}

/** Queue "put this one mark back where the plan put it". */
export function enqueuePinResetOpening(openingId: string): Promise<string> {
  return enqueue({ op: "pin_reset_opening", payload: { openingId } });
}

/** Build a shift ref that points at a not-yet-synced offline clock-in entry. */
export function pendingRefForShift(clockInEntryId: string): string {
  return pendingShiftRef(clockInEntryId);
}

/** If a shift ref is a pending clock-in, the entry it depends on; else none. */
function refDependency(shiftRef: string): string | null {
  const prefix = "pending:";
  return shiftRef.startsWith(prefix) ? shiftRef.slice(prefix.length) : null;
}

// --- warehouse writes from inside a conex (ticket 10) --------------------
//
// A conex is a metal box with no bars. Nobody is walking outside to make the
// app happy — they will do the work and skip the scan, and then the record is
// gone. These queue and drain when signal returns; the UI shows them as done
// with a "not sent yet" mark, because to the person holding the crate it IS
// done.

/** Queue "these packages went into this container". */
export function enqueueStorePackages(
  packageIds: string[],
  containerId: string,
): Promise<string> {
  return enqueue({ op: "store_packages", payload: { packageIds, containerId } });
}

/** Queue "these packages left, for this reason, to this job". */
export function enqueueCheckoutPackages(input: {
  packageIds: string[];
  reason: string;
  projectId: string;
}): Promise<string> {
  return enqueue({ op: "checkout_packages", payload: { ...input } });
}

/** Queue "somebody took this many of this supply for this job". */
export function enqueueTakeSupply(input: {
  supplyId: string;
  projectId: string;
  qty: number;
}): Promise<string> {
  return enqueue({ op: "take_supply", payload: { ...input } });
}

// --- stuck writes: seeing them, and doing something about them -----------
//
// The core's own note says a dead-lettered entry "needs human attention,
// never silently dropped" — and until now there was no human anywhere in the
// loop. Nothing listed failed writes, nothing could retry one, and a punch
// stranded behind a failed clock-in was invisible AND unfixable. These three
// are what a foreman needs to actually close that loop.

/** Every write that gave up, newest first. */
export async function listFailed(): Promise<OutboxEntry[]> {
  const all = await store.getAll();
  return all
    .filter((e) => e.status === "failed")
    .sort((a, b) => b.createdAt - a.createdAt);
}

/**
 * Put one failed write back in the queue and try it now.
 *
 * Also revives anything that was stranded waiting on it — otherwise retrying
 * a clock-in would leave its clock-out sitting failed, which is exactly the
 * half-fixed state this feature exists to end.
 */
export async function retryFailed(id: string): Promise<void> {
  const all = await store.getAll();
  const target = all.find((e) => e.id === id);
  if (!target) return;
  const now = Date.now();
  await store.put(retryEntry(target, now));
  for (const e of all) {
    if (e.status === "failed" && e.dependsOn === id) {
      await store.put(retryEntry(e, now));
    }
  }
  await refresh();
  if (isOnline()) void drain();
}

/**
 * Throw one away for good.
 *
 * Deliberately explicit and one at a time: this destroys a record of work
 * somebody did, so it must be a decision, never a cleanup sweep.
 */
export async function discardFailed(id: string): Promise<void> {
  await store.delete(id);
  await refresh();
}
