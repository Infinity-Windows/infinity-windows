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
  injuryNote?: string | null;
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
      injuryNote: input.injuryNote ?? null,
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
  /** A package this photo hangs off (pick 28) — attachments.package_id,
   * widened onto attachments_target by 20260936000000_package_photos. */
  packageId?: string | null;
  lat?: number | null;
  lng?: number | null;
  accuracyM?: number | null;
  /** ISO capture time; distinct from the server's created_at. */
  takenAt?: string | null;
  caption?: string | null;
  blob: Blob;
}

export function enqueueUpload(input: UploadInput): Promise<string> {
  // An attachment must hang off something — `attachments_target` says so, and
  // it is the whole reason a job photo needed 20260989000000 to add the job
  // itself to that list. A row with every target null is a 23514 the queue can
  // only retry into a dead letter, hours after the person was told it saved.
  // Refusing here costs one photo and one honest sentence; letting it through
  // costs the photo silently. Every caller sets one of these today (the job
  // photo sheet a job, PackageSheet a package, ModelStudio a job) — this is
  // the guard for the next caller that forgets.
  if (
    !input.windowId &&
    !input.installEventId &&
    !input.projectId &&
    !input.packageId
  ) {
    return Promise.reject(
      new Error("This photo needs a job before it can be saved. Pick one, then take it again."),
    );
  }
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
        packageId: input.packageId ?? null,
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

export interface ReceiptCaptureInput {
  /** Client-minted (crypto.randomUUID()) — see receiptPhotoPath. */
  id: string;
  bucket?: string;
  path: string;
  contentType: string;
  projectId?: string | null;
  pendingJobName?: string | null;
  note?: string | null;
  blob: Blob;
}

/**
 * Queue a snapped receipt: uploads the photo AND files the receipts row in
 * one entry (mirrors enqueueUpload's upload-then-write shape, but writes
 * `receipts` via file_receipt rather than `attachments`). Returns the
 * outbox entry's own id, for a follow-up enqueueReceiptAnswer's `dependsOn`.
 */
export function enqueueReceiptCapture(input: ReceiptCaptureInput): Promise<string> {
  return enqueue(
    {
      op: "receipt_capture",
      hasBlob: true,
      payload: {
        id: input.id,
        bucket: input.bucket ?? "install-media",
        path: input.path,
        contentType: input.contentType,
        projectId: input.projectId ?? null,
        pendingJobName: input.pendingJobName ?? null,
        note: input.note ?? null,
      },
    },
    input.blob,
  );
}

/**
 * Queue the upload flow's one skippable question — a job picked (or typed
 * as a waiting-job name) and/or the bill-to-customer answer, made AFTER the
 * photo was already snapped. `dependsOn` the enqueueReceiptCapture entry's
 * id, so this never asks the server to update a row that has not landed.
 */
export function enqueueReceiptAnswer(input: {
  receiptId: string;
  dependsOn: string;
  projectId?: string | null;
  pendingJobName?: string | null;
  isPassthrough?: boolean | null;
  /** Wave Z: which kind of purchase, picked in the same one question. */
  costCodeId?: string | null;
}): Promise<string> {
  return enqueue({
    op: "receipt_answer",
    dependsOn: input.dependsOn,
    payload: {
      receiptId: input.receiptId,
      projectId: input.projectId ?? null,
      pendingJobName: input.pendingJobName ?? null,
      isPassthrough: input.isPassthrough ?? null,
      costCodeId: input.costCodeId ?? null,
    },
  });
}

/**
 * Queue a finished video quiz attempt for later. Only called as the FALLBACK
 * after a direct submit_video_quiz call fails with a network-shaped error
 * (see videoQuiz.ts's submitVideoQuiz) — there is no score to show yet once
 * this has queued, only "will send when you're back in signal".
 */
export function enqueueVideoQuizSubmit(input: {
  videoId: string;
  answers: number[];
}): Promise<string> {
  return enqueue({
    op: "video_quiz_submit",
    payload: { videoId: input.videoId, answers: input.answers },
  });
}

/**
 * One job-day's log, waiting for signal.
 *
 * REWRITTEN 2026-09-05, and the old shape was never sendable. It carried
 * `{projectId, profileId, logDate, notes, createdBy}` and its handler upserted
 * those straight into `daily_logs` — three of those columns do not exist on
 * that table, and `daily_logs` has no insert policy at all (file_daily_log is
 * the only writer there is). It also had zero callers, so nothing ever proved
 * it. Now it carries every field the RPC takes, and the handler calls the RPC.
 */
export interface DailyLogInput {
  projectId: string;
  logDate: string;
  headline: string | null;
  notes: string;
  dayFlow: "smooth" | "fine" | "stuck" | null;
  /** The four optional one-liners (DailyLogReflection), carried opaquely.
   * Deliberately not that exact type: outbox.ts is the queue and never reads
   * this, and importing it back from lib/dailyLogs.ts — which imports
   * enqueueDailyLog from here — would draw a circle for no gain. The handler,
   * which does read it, names the real type. */
  reflection: object | null;
  weather: string | null;
  /** For the "— added later from <name>'s phone" line, if this one races. */
  authorName?: string | null;
}

export function enqueueDailyLog(input: DailyLogInput): Promise<string> {
  return enqueue({
    op: "daily_log",
    payload: {
      projectId: input.projectId,
      logDate: input.logDate,
      headline: input.headline,
      notes: input.notes,
      dayFlow: input.dayFlow,
      reflection: input.reflection,
      weather: input.weather,
      authorName: input.authorName ?? null,
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
  /**
   * What the phone believed about each package when it was ticked: its status
   * and the container it was in. REQUIRED — an entry queued without it cannot
   * be checked against reality when it finally goes up, which is the whole of
   * warehouse audit F2. The type is the guard; a spread would not be.
   */
  expected: Record<string, { status: string; container: string | null }>,
): Promise<string> {
  return enqueue({
    op: "store_packages",
    payload: { packageIds, containerId, expected },
  });
}

/** Queue "these packages left, for this reason, to this job". */
export function enqueueCheckoutPackages(input: {
  packageIds: string[];
  reason: string;
  projectId: string;
}): Promise<string> {
  return enqueue({ op: "checkout_packages", payload: { ...input } });
}

/**
 * Queue "somebody took this many of this supply for this job".
 *
 * clientId is REQUIRED, and that is the whole point of it (F1). A take with no
 * key subtracts again on every retry, so the compiler has to be the thing that
 * stops an unkeyed one being queued — this used to type-check without it and
 * survive only because the body spreads `input` wholesale.
 */
export function enqueueTakeSupply(input: {
  supplyId: string;
  projectId: string;
  qty: number;
  clientId: string;
}): Promise<string> {
  return enqueue({ op: "take_supply", payload: { ...input } });
}

/**
 * What a queued tag carries.
 *
 * Spelled out field by field rather than typed off lib/storage's input, so
 * this file stays free of the storage module — and, more to the point, so the
 * payload is written out in one place a reader can check against the handler
 * that reads it back. The two lists are held in step by a test, because a
 * field renamed on one side and not the other loses the tag with no error.
 */
export interface BindPackageInput {
  packageId: string;
  projectId: string | null;
  /** Company stock, said on purpose (ticket 17). */
  boneyard?: boolean;
  category?: string | null;
  note?: string | null;
  marks?: string[];
  deliveryId?: string | null;
  partIndex?: number | null;
  partTotal?: number | null;
  partType?: string | null;
  mfrMark?: string | null;
}

/** Queue "this sticker belongs to this package, on this job". */
export function enqueueBindPackage(input: BindPackageInput): Promise<string> {
  return enqueue({
    op: "bind_package",
    payload: {
      packageId: input.packageId,
      projectId: input.projectId,
      boneyard: input.boneyard ?? false,
      category: input.category ?? null,
      note: input.note ?? null,
      marks: input.marks ?? [],
      deliveryId: input.deliveryId ?? null,
      partIndex: input.partIndex ?? null,
      partTotal: input.partTotal ?? null,
      partType: input.partType ?? null,
      mfrMark: input.mfrMark ?? null,
    },
  });
}

/** Queue "these packages went on this job's own shelf to go out together". */
export function enqueueStagePackages(
  packageIds: string[],
  projectId: string,
  /**
   * What the phone believed about each package when it was ticked: its status,
   * the container it was in, and the shelf it was on. REQUIRED, for the same
   * reason the check-in note above is — a set-aside queued without it cannot
   * be checked against reality when it finally goes up, and a set-aside that
   * lost the race records a package on a job's bay while it is physically in a
   * conex or on a truck. The type is the guard; a spread would not be.
   *
   * The shelf is in the note and is not in check-in's, because "already staged
   * on a DIFFERENT job's bay" leaves status and container untouched and moves
   * only the shelf — the one stale belief a status/container note would wave
   * through.
   */
  expected: Record<
    string,
    { status: string; container: string | null; location: string | null }
  >,
): Promise<string> {
  return enqueue({
    op: "stage_packages",
    payload: { packageIds, projectId, expected },
  });
}

/** Queue "this container moved, and everything inside it went with it". */
export function enqueueMoveContainer(input: {
  containerId: string;
  parentContainerId?: string | null;
  locationId?: string | null;
}): Promise<string> {
  return enqueue({
    op: "move_container",
    payload: {
      containerId: input.containerId,
      parentContainerId: input.parentContainerId ?? null,
      locationId: input.locationId ?? null,
    },
  });
}

/** Queue "I picked up this takeoff" — the take rides the server side. */
export function enqueuePickupTakeoff(input: { takeoffId: string }): Promise<string> {
  return enqueue({ op: "pickup_takeoff", payload: { takeoffId: input.takeoffId } });
}

/** Queue "these pre-labeled packages came off the truck" (ticket 15). */
export function enqueueReceiveMinted(input: { packageIds: string[] }): Promise<string> {
  return enqueue({ op: "receive_minted", payload: { packageIds: input.packageIds } });
}

/** Queue "this package sits at the front of its box" (ticket 14). Setting a
 * pointer twice lands on the same pointer, so a resend is harmless. */
export function enqueueSetPackageArea(input: {
  packageId: string;
  area: string | null;
}): Promise<string> {
  return enqueue({
    op: "set_package_area",
    payload: { packageId: input.packageId, area: input.area },
  });
}

/** Queue "here's a note on this piece". Setting the same text twice lands on
 * the same value, so a resend is harmless. */
export function enqueueSetPackageNote(input: {
  packageId: string;
  note: string | null;
}): Promise<string> {
  return enqueue({
    op: "set_package_note",
    payload: { packageId: input.packageId, note: input.note },
  });
}

/**
 * Queue a damage report's photo (ticket 11). The issue itself is written by
 * the direct arrivePackages() call in lib/storage.ts, which already knows
 * this exact bucket/path — see damagePhotoPath — before this is ever queued.
 * This call only has to get the bytes there. A conex has no bars: the note
 * and the issue go up right away, and the picture catches up whenever the
 * phone finds signal.
 */
export function enqueueIssuePhoto(input: {
  bucket: string;
  path: string;
  contentType: string;
  blob: Blob;
}): Promise<string> {
  return enqueue(
    {
      op: "issue_photo_upload",
      hasBlob: true,
      payload: {
        bucket: input.bucket,
        path: input.path,
        contentType: input.contentType,
      },
    },
    input.blob,
  );
}

// ORDERING: none of these three sets `dependsOn`, and the one chain worth
// worrying about — tag a package offline, then check it into a conex offline,
// which MUST reach the server in that order or the check-in silently stores
// nothing — cannot be built through the app today. The check-in list is the
// only place a package is picked for storing (ContainerDetail.tsx), and it is
// filtered from listActivePackages(), which asks the server for
// `.neq("status", "blank")`. A package whose tag is only queued is still
// blank on the server, and nothing writes it into that cache by hand — the
// tag screen only invalidates the query, which offline re-serves the same
// stale list. So a tag-queued package is not offerable for check-in, and the
// out-of-order pair cannot be made.
//
// If a scan-to-check-in path is ever added — a scanner puts a serial straight
// into the picker without asking the server — that stops being true, and this
// is what would have to be wired: `dependsOn` takes an entry id, and unlike
// the clock chain no resolver is needed, because a package id is minted on
// the client and is the same value on both entries. Look up the queued
// bind_package entry carrying that packageId and hand its id to
// enqueueStorePackages as `dependsOn`.

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
