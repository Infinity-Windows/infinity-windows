// Pure, framework-free core of the global offline write outbox. NO IndexedDB,
// NO Supabase, NO React in this file — everything here is deterministic and
// unit-testable so the queue's guarantees (dedupe, backoff, FIFO drain,
// dead-letter, replay) can be proven without a browser or a network.
//
// The runtime (outbox.ts) wires this core to an IndexedDB-backed store and a
// map of Supabase op handlers. The install-flow outbox (lib/install/*) is a
// separate module and is intentionally left untouched.

/**
 * Every kind of write the outbox can carry.
 *
 * Adding one means three edits: this union, `OP_REGISTRY` further down, and a
 * handler in outboxHandlers.ts. You cannot forget the second — the registry
 * `satisfies Record<OutboxOp, true>`, so a name here with no entry there is a
 * compile error, not a write that vanishes off disk in the field.
 */
export type OutboxOp =
  | "clock_in"
  | "clock_out"
  | "break_start"
  | "break_stop"
  | "daily_log"
  | "photo_upload"
  | "receipt_upload"
  | "pin_undo"
  | "pin_reset_project"
  | "pin_reset_opening"
  // Warehouse ticket 10: a conex is a metal box with no bars. Nobody walks
  // outside to make the app happy — they do the work and skip the scan, and
  // then the record is gone forever. These three queue instead.
  | "store_packages"
  | "checkout_packages"
  | "take_supply"
  // The other three writes made standing in that same box (audit F3): tagging
  // a package at the truck, setting one aside for a job, and moving a whole
  // container. Same rule — the server first, the queue only when there is no
  // signal.
  | "bind_package"
  | "stage_packages"
  | "move_container"
  // Ticket 14: areas get set standing INSIDE the box — the one place with no
  // signal. Setting a pointer twice lands on the same pointer, so a resend is
  // harmless by nature.
  | "set_package_area"
  // A note gets added standing in the same box an area does, for the same
  // reason. Setting the same text twice lands on the same value.
  | "set_package_note"
  // Ticket 15: confirming pre-labeled packages off the truck. The yard is the
  // signal dead zone; the server counts an already-received package without
  // writing a second history line, so a resend is not a second truck.
  | "receive_minted"
  // Takeoffs (2026-08-18): pickup happens standing at the racks. The status
  // flip is the server-side idempotency guard — a resend finds picked_up and
  // changes nothing — so the queue can retry it blind.
  | "pickup_takeoff"
  // Ticket 11 (2026-08-19): a damage report's photo. arrive_packages itself
  // is a direct call, not queued — only the blob is slow or big enough to be
  // worth surviving a dead conex wall. The path is minted client-side and
  // handed to arrive_packages BEFORE this is ever queued, so the issue row
  // and the object this eventually uploads always agree on where the photo
  // is, with no second round trip needed once the upload lands.
  | "issue_photo_upload"
  // Wave P: a snapped receipt. Unlike photo_upload/receipt_upload (which
  // write straight to `attachments`), this uploads the photo AND files the
  // receipts row in one handler — the id is minted client-side
  // (crypto.randomUUID()) before either the upload or file_receipt exists on
  // the server, exactly like issue_photo_upload's path-first pattern above,
  // so a resend after a lost reply lands on the same row (file_receipt is
  // idempotent on id).
  | "receipt_capture"
  // The upload flow's one skippable question (bill-to-customer + a job
  // picked AFTER the photo was already snapped) — see enqueueReceiptAnswer.
  // Always `dependsOn` its receipt_capture entry: asking the server to
  // update a receipt that has not been filed yet would fail every time.
  | "receipt_answer"
  // Wave Q: a finished video quiz attempt. Unlike most of this queue, the
  // caller tries submit_video_quiz directly FIRST (videoQuiz.ts's
  // submitVideoQuiz, the offlineWrites.ts pattern) so an installer sees
  // their score immediately when there is signal — this op only exists for
  // the fallback, when that direct call fails with a network-shaped error.
  | "video_quiz_submit";

/**
 * queued   — waiting to be sent (respecting nextAttemptAt backoff)
 * sending  — a drain is currently attempting this entry
 * failed   — dead-letter: exhausted retries or hit a permanent error; needs
 *            human attention. Never silently dropped.
 */
export type OutboxStatus = "queued" | "sending" | "failed";

export interface OutboxEntry {
  /** Client-generated stable id — the idempotency key. Survives retries. */
  id: string;
  op: OutboxOp;
  /** JSON-serializable op arguments. Blobs (photos) live beside the entry. */
  payload: Record<string, unknown>;
  createdAt: number;
  attemptCount: number;
  lastError: string | null;
  status: OutboxStatus;
  /** Earliest time (ms epoch) this entry may be attempted again (backoff). */
  nextAttemptAt: number;
  /**
   * Optional ordering dependency: this entry may not be attempted until the
   * entry with this client id has left the queue (e.g. clock-out waits for its
   * offline clock-in to sync first). Purely advisory to the drain planner.
   */
  dependsOn?: string | null;
  /** True once a blob is stored alongside this entry (photo/receipt). */
  hasBlob?: boolean;
}

export interface OutboxInput {
  op: OutboxOp;
  payload: Record<string, unknown>;
  dependsOn?: string | null;
  hasBlob?: boolean;
}

/** Retry policy. Deliberately small + capped so the queue drains promptly. */
export const MAX_ATTEMPTS = 8;
export const BACKOFF_BASE_MS = 5_000; // 5s, 10s, 20s … capped
export const BACKOFF_CAP_MS = 5 * 60_000; // 5 min ceiling

const SERIALIZE_VERSION = 1;

/**
 * Exponential backoff for the Nth attempt (0-based). Deterministic by default;
 * pass a jitter fraction (0..1) to spread retries across many clients.
 */
export function computeBackoffMs(attemptCount: number, jitter = 0): number {
  const raw = BACKOFF_BASE_MS * 2 ** Math.max(0, attemptCount);
  const capped = Math.min(raw, BACKOFF_CAP_MS);
  if (jitter <= 0) return capped;
  const spread = capped * jitter;
  return Math.round(capped - spread + Math.random() * spread * 2);
}

/** Build a fresh queued entry. `id` is the idempotency key (crypto.randomUUID). */
export function makeEntry(
  input: OutboxInput,
  id: string,
  now: number,
): OutboxEntry {
  return {
    id,
    op: input.op,
    payload: input.payload,
    createdAt: now,
    attemptCount: 0,
    lastError: null,
    status: "queued",
    nextAttemptAt: now,
    dependsOn: input.dependsOn ?? null,
    hasBlob: input.hasBlob ?? false,
  };
}

/**
 * The SQLSTATE, where the failure carries one.
 *
 * Every error supabase-js hands back from PostgREST has `code` on it, and it
 * is a far better signal than the sentence: the sentence is written by
 * whoever raised it and changes whenever we reword a message.
 */
export function errorCode(err: unknown): string | null {
  if (err == null || typeof err !== "object") return null;
  const code = (err as { code?: unknown }).code;
  return typeof code === "string" && code.trim() !== "" ? code.trim() : null;
}

/**
 * Is this SQLSTATE one that will still be refused on the tenth try?
 *
 * P0001 is a RAISE EXCEPTION from one of our own functions — a rule we wrote
 * said no, and it will say no again. Class 22 is bad input, class 23 is a
 * constraint violation, class 42 is syntax / undefined object / permission
 * denied. None of those are fixed by waiting.
 *
 * Deliberately NOT here: class 08 (connection), 53 (out of resources), 57
 * (operator intervention, which includes a restarting database) and 5xx HTTP
 * — those are exactly the ones a retry does fix.
 *
 * PostgREST's own codes (PGRST…) don't match this shape and fall through to
 * the message heuristics below, as they did before.
 */
export function isPermanentSqlState(code: string | null | undefined): boolean {
  if (!code) return false;
  const c = code.trim().toUpperCase();
  if (c === "P0001") return true;
  return /^(22|23|42)[0-9A-Z]{3}$/.test(c);
}

/**
 * Classify a drain failure. Network / transient errors are retried with
 * backoff; permanent errors (validation, auth, conflict) go straight to the
 * dead-letter so we don't hammer the server forever. Anything unknown is
 * treated as retryable — losing a field write is worse than a wasted retry.
 *
 * The SQLSTATE check was added 2026-09-02: `finish_unit` refused an install
 * with P0001 "this opening needs flashing submitted before the install is
 * filed", none of the message patterns below matched it, so the queue called
 * it retryable — the installer got "saved on this device, will sync when
 * you're back in signal", the phone tried eight more times over four minutes,
 * and the real reason never reached anybody.
 */
export function isRetryableError(err: unknown): boolean {
  if (err == null) return true;
  const permanent = (err as { permanent?: unknown }).permanent;
  if (permanent === true) return false;
  if (isPermanentSqlState(errorCode(err))) return false;
  const msg = errorMessage(err).toLowerCase();
  // Postgres/PostgREST permanent-ish signals.
  if (/duplicate key|already exists|violates|invalid input|permission denied|not authorized|forbidden|jwt|row-level security/.test(msg)) {
    return false;
  }
  return true;
}

/**
 * Heuristic: did this failure come from being offline / a flaky connection
 * (so we should queue) rather than a real server rejection (so we should
 * surface it)? Used by write call sites to decide "queue vs error".
 */
export function isNetworkError(err: unknown): boolean {
  if (typeof navigator !== "undefined" && navigator.onLine === false) return true;
  if (err instanceof TypeError) return true; // fetch() network failure
  const msg = errorMessage(err).toLowerCase();
  return /failed to fetch|networkerror|network error|load failed|fetch failed|timeout|timed out|offline|connection/.test(
    msg,
  );
}

export function errorMessage(err: unknown): string {
  if (err == null) return "";
  if (typeof err === "string") return err;
  if (err instanceof Error) return err.message;
  const o = err as { message?: unknown; error_description?: unknown };
  if (typeof o.message === "string") return o.message;
  if (typeof o.error_description === "string") return o.error_description;
  try {
    return JSON.stringify(err);
  } catch {
    return "Unknown error";
  }
}

/**
 * Transition an entry after a failed send attempt. Increments the attempt
 * count, records the error, and either re-queues with backoff or moves it to
 * the dead-letter (`failed`) once attempts are exhausted or the error is
 * permanent. Pure — returns a new entry.
 */
export function applyFailure(
  entry: OutboxEntry,
  err: unknown,
  now: number,
): OutboxEntry {
  const attemptCount = entry.attemptCount + 1;
  const retryable = isRetryableError(err);
  const exhausted = attemptCount >= MAX_ATTEMPTS;
  const dead = !retryable || exhausted;
  return {
    ...entry,
    attemptCount,
    lastError: errorMessage(err) || "Send failed",
    status: dead ? "failed" : "queued",
    nextAttemptAt: dead ? entry.nextAttemptAt : now + computeBackoffMs(attemptCount),
  };
}

/** Mark an entry as actively sending (persisted so a reload knows the state). */
export function markSending(entry: OutboxEntry): OutboxEntry {
  return { ...entry, status: "sending" };
}

/** Re-queue an entry that was left mid-flight (`sending`) by a reload/crash. */
export function requeueStranded(entry: OutboxEntry, now: number): OutboxEntry {
  if (entry.status !== "sending") return entry;
  return { ...entry, status: "queued", nextAttemptAt: now };
}

export function isDeadLetter(entry: OutboxEntry): boolean {
  return entry.status === "failed";
}

export function isPending(entry: OutboxEntry): boolean {
  return entry.status === "queued" || entry.status === "sending";
}

/** De-duplicate by client id, keeping the first (FIFO) occurrence. */
export function dedupe(entries: OutboxEntry[]): OutboxEntry[] {
  const seen = new Set<string>();
  const out: OutboxEntry[] = [];
  for (const e of entries) {
    if (seen.has(e.id)) continue;
    seen.add(e.id);
    out.push(e);
  }
  return out;
}

/**
 * Which entries are due to attempt right now, in FIFO (createdAt) order.
 * Skips entries that are: not `queued`, not yet past their backoff window, or
 * blocked behind an unresolved `dependsOn` that is still in the queue.
 */
export function dueEntries(entries: OutboxEntry[], now: number): OutboxEntry[] {
  const present = new Map(entries.map((e) => [e.id, e]));
  return entries
    .filter((e) => e.status === "queued")
    .filter((e) => e.nextAttemptAt <= now)
    .filter((e) => {
      if (!e.dependsOn) return true;
      const dep = present.get(e.dependsOn);
      // If the dependency is gone from the queue it has been sent → unblock.
      // If it is still present (queued/sending/failed) → keep waiting.
      return dep == null;
    })
    .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
}

/**
 * Everything transitively waiting on an entry that has permanently failed.
 *
 * A clock-out depends on its clock-in, so it may not be sent first — correct.
 * But `dueEntries` asks "is the dependency still in the queue", and a
 * PERMANENTLY FAILED clock-in is still sitting there, just marked failed. So
 * the clock-out waited forever: never attempted, never counted as failed,
 * never shown anywhere, and with no screen to clear it. A lost punch is a
 * payroll dispute, so the failure has to travel to everything it strands.
 *
 * Transitive on purpose — B waits on A and C waits on B, so A dying kills
 * both. Pure; returns the entries to write, not a mutation.
 */
export function cascadeFailure(
  entries: OutboxEntry[],
  failedId: string,
): OutboxEntry[] {
  const dead = new Set([failedId]);
  const out: OutboxEntry[] = [];
  // Oldest first, so a chain is walked in the order it was built.
  const ordered = [...entries].sort((a, b) => a.createdAt - b.createdAt);
  let changed = true;
  while (changed) {
    changed = false;
    for (const e of ordered) {
      if (e.status === "failed" || dead.has(e.id)) continue;
      if (!e.dependsOn || !dead.has(e.dependsOn)) continue;
      dead.add(e.id);
      out.push({
        ...e,
        status: "failed",
        lastError:
          e.lastError ??
          "The clock-in this was waiting on failed, so this could never be sent.",
      });
      changed = true;
    }
  }
  return out;
}

/**
 * Put a dead-lettered entry back in the queue for another attempt.
 *
 * Clears the error and the attempt count: a human looked at it and decided it
 * is worth trying again, so it should get a full run of retries rather than
 * dying on the next one.
 */
export function retryEntry(entry: OutboxEntry, now: number): OutboxEntry {
  return {
    ...entry,
    status: "queued",
    attemptCount: 0,
    lastError: null,
    nextAttemptAt: now,
  };
}

// --- pending counts + the sync-status pill copy (p1-12) -----------------

export interface OpCounts {
  clock: number;
  photos: number;
  receipts: number;
  logs: number;
  other: number;
  deadLetter: number;
  /** Warehouse writes made with no signal (ticket 10). Counted SEPARATELY
   * from `other` rather than sharing it: the warehouse page says "3 not sent
   * yet" and must not be quoting somebody's queued pin-reset. */
  warehouse: number;
}

const EMPTY_COUNTS: OpCounts = {
  clock: 0,
  photos: 0,
  receipts: 0,
  logs: 0,
  other: 0,
  deadLetter: 0,
  warehouse: 0,
};

/** Roll a queue up into per-category pending counts for the status pill. */
export function countsByOp(entries: OutboxEntry[]): OpCounts {
  const c: OpCounts = { ...EMPTY_COUNTS };
  for (const e of entries) {
    if (e.status === "failed") {
      c.deadLetter += 1;
      continue;
    }
    switch (e.op) {
      case "clock_in":
      case "clock_out":
      case "break_start":
      case "break_stop":
        c.clock += 1;
        break;
      case "photo_upload":
      case "issue_photo_upload":
        c.photos += 1;
        break;
      case "receipt_upload":
        c.receipts += 1;
        break;
      case "daily_log":
        c.logs += 1;
        break;
      case "store_packages":
      case "checkout_packages":
      case "take_supply":
      case "bind_package":
      case "stage_packages":
      case "move_container":
      case "set_package_area":
      case "set_package_note":
      case "receive_minted":
      case "pickup_takeoff":
        c.warehouse += 1;
        break;
      default:
        c.other += 1;
    }
  }
  return c;
}

/**
 * The buckets that are still going to be sent. `deadLetter` is not one of
 * them — it has stopped trying and is counted on its own.
 */
type PendingCategory = Exclude<keyof OpCounts, "deadLetter">;

/**
 * What each pending bucket calls itself on the pill face, in reading order.
 *
 * Typed as a Record over EVERY pending bucket on purpose. A bucket counted in
 * OpCounts but never named here doesn't break anything loudly — it just adds
 * to the total while contributing no words, so a phone holding nothing but
 * that kind of write drew a pill with a spinning icon and no text at all.
 * That is exactly how the warehouse bucket shipped in ticket 10, and audit F3
 * routed three more ops into it, so a blank pill went from rare to routine.
 * Now leaving a bucket unnamed is a compile error.
 */
const PART_LABELS: Record<PendingCategory, (n: number) => string> = {
  clock: (n) => `Clock ${n}`,
  photos: (n) => `Photos ${n}`,
  receipts: (n) => `Receipts ${n}`,
  logs: (n) => (n === 1 ? "1 log queued" : `${n} logs queued`),
  warehouse: (n) => `Warehouse ${n}`,
  other: (n) => `${n} queued`,
};

const PENDING_CATEGORIES = Object.keys(PART_LABELS) as PendingCategory[];

export function totalPending(c: OpCounts): number {
  return PENDING_CATEGORIES.reduce((sum, key) => sum + c[key], 0);
}

/**
 * The pill face's words, one per non-empty bucket. Summed and named off the
 * same list, so "something is pending" and "the pill has words" can never
 * disagree again.
 */
function pendingParts(c: OpCounts): string[] {
  const parts: string[] = [];
  for (const key of PENDING_CATEGORIES) {
    if (c[key] > 0) parts.push(PART_LABELS[key](c[key]));
  }
  return parts;
}

export type PillTone = "synced" | "syncing" | "attention";

export interface PillSummary {
  tone: PillTone;
  /** Short label for the pill face, e.g. "Clock 1 · Photos 3 · 2 logs". */
  label: string;
  /** Full sentence for screen readers / aria-live. */
  detail: string;
}

/**
 * Build the pill's text from counts. Status is conveyed by text + tone (never
 * color alone) so it stays accessible. Dead-letters take priority as "needs
 * attention"; otherwise we list pending work, or a calm "all synced".
 */
export function pillSummary(c: OpCounts): PillSummary {
  const parts = pendingParts(c);
  const pending = totalPending(c);

  if (c.deadLetter > 0) {
    const label =
      parts.length > 0
        ? `${parts.join(" · ")} · needs attention`
        : "Needs attention";
    return {
      tone: "attention",
      label,
      detail: `${c.deadLetter} ${c.deadLetter === 1 ? "item" : "items"} couldn't sync and need attention.${pending > 0 ? ` ${pending} still waiting to sync.` : ""}`,
    };
  }
  if (pending === 0) {
    return { tone: "synced", label: "All synced", detail: "All changes are saved and synced." };
  }
  return {
    tone: "syncing",
    label: parts.join(" · "),
    detail: `${pending} ${pending === 1 ? "change" : "changes"} saved and waiting to sync.`,
  };
}

// --- serialization (persistence round-trip) ------------------------------

export function serializeEntry(entry: OutboxEntry): string {
  return JSON.stringify({ v: SERIALIZE_VERSION, ...entry });
}

/**
 * Every op the queue can carry, written out ONCE and checked against the
 * `OutboxOp` union by the compiler.
 *
 * This list is load-bearing and was easy to miss: an op added to `OutboxOp`
 * but NOT added here serializes fine, lands in IndexedDB, and then
 * deserializes to `null` forever — the queue can't see it, the drainer never
 * sends it, and the write is silently lost with no error anywhere and every
 * test still green. It has cost real writes here already.
 *
 * `satisfies Record<OutboxOp, true>` is what stops it happening again, and it
 * catches BOTH directions before the code ever runs:
 *   - an op added to the union and not to this list → "Property 'x' is
 *     missing in type ... but required in type Record<OutboxOp, true>";
 *   - a name typed here that is not in the union → "Object literal may only
 *     specify known properties".
 * `OPS` and `ALL_OPS` are then derived from it, so there is no second list
 * left to drift. If you are adding an op: add it to `OutboxOp` above, add it
 * here, and register a handler in outboxHandlers.ts.
 */
const OP_REGISTRY = {
  clock_in: true,
  clock_out: true,
  break_start: true,
  break_stop: true,
  daily_log: true,
  photo_upload: true,
  receipt_upload: true,
  pin_undo: true,
  pin_reset_project: true,
  pin_reset_opening: true,
  store_packages: true,
  checkout_packages: true,
  take_supply: true,
  bind_package: true,
  stage_packages: true,
  move_container: true,
  set_package_area: true,
  set_package_note: true,
  receive_minted: true,
  pickup_takeoff: true,
  issue_photo_upload: true,
  receipt_capture: true,
  receipt_answer: true,
  video_quiz_submit: true,
} as const satisfies Record<OutboxOp, true>;

/** Every op the queue can carry — the single list tests enumerate. */
export const ALL_OPS: readonly OutboxOp[] = Object.keys(
  OP_REGISTRY,
) as (keyof typeof OP_REGISTRY)[];

/** Ops accepted when reading a row back off disk. Derived, never hand-typed. */
export const OPS: ReadonlySet<string> = new Set<string>(ALL_OPS);

export function deserializeEntry(json: string): OutboxEntry | null {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string" || !OPS.has(r.op as string)) return null;
  if (typeof r.payload !== "object" || r.payload === null) return null;
  const status =
    r.status === "queued" || r.status === "sending" || r.status === "failed"
      ? (r.status as OutboxStatus)
      : "queued";
  const createdAt = typeof r.createdAt === "number" ? r.createdAt : Date.now();
  return {
    id: r.id,
    op: r.op as OutboxOp,
    payload: r.payload as Record<string, unknown>,
    createdAt,
    attemptCount: typeof r.attemptCount === "number" ? r.attemptCount : 0,
    lastError: typeof r.lastError === "string" ? r.lastError : null,
    // A reload while `sending` means the attempt was interrupted — treat as
    // queued so it gets retried rather than stuck.
    status: status === "sending" ? "queued" : status,
    nextAttemptAt:
      typeof r.nextAttemptAt === "number" ? r.nextAttemptAt : createdAt,
    dependsOn: typeof r.dependsOn === "string" ? r.dependsOn : null,
    hasBlob: r.hasBlob === true,
  };
}

// --- generic drain over any store + handler map --------------------------

export interface OutboxStore {
  getAll(): Promise<OutboxEntry[]>;
  /** Persist an entry (and optionally its blob). Insert or replace by id. */
  put(entry: OutboxEntry, blob?: Blob | null): Promise<void>;
  getBlob(id: string): Promise<Blob | null>;
  delete(id: string): Promise<void>;
  count(): Promise<number>;
}

/** A handler performs the real network write for one op. Throws on failure. */
export type OpHandler = (
  entry: OutboxEntry,
  ctx: { getBlob: () => Promise<Blob | null> },
) => Promise<void>;

export type OpHandlers = Partial<Record<OutboxOp, OpHandler>>;

export interface DrainResult {
  attempted: number;
  sent: number;
  retried: number;
  deadLettered: number;
  remaining: number;
}

/**
 * Attempt every due entry once, FIFO. Success → delete; failure → backoff or
 * dead-letter. This is the whole drainer, decoupled from IndexedDB/Supabase so
 * it can be exercised with an in-memory store and fake handlers.
 */
export async function drainStore(
  store: OutboxStore,
  handlers: OpHandlers,
  opts: { now?: number; onChange?: () => void } = {},
): Promise<DrainResult> {
  const now = opts.now ?? Date.now();
  const all = await store.getAll();
  const due = dueEntries(all, now);
  let sent = 0;
  let retried = 0;
  let deadLettered = 0;

  for (const entry of due) {
    const handler = handlers[entry.op];
    if (!handler) {
      // No handler registered → dead-letter so it surfaces rather than looping.
      await store.put({
        ...entry,
        status: "failed",
        lastError: `No handler for op "${entry.op}"`,
      });
      deadLettered += 1;
      continue;
    }
    await store.put(markSending(entry));
    try {
      await handler(entry, { getBlob: () => store.getBlob(entry.id) });
      await store.delete(entry.id);
      sent += 1;
    } catch (err) {
      const next = applyFailure(entry, err, now);
      await store.put(next);
      if (next.status === "failed") {
        deadLettered += 1;
        // Anything waiting on this can never be sent now. Fail it here rather
        // than leaving it queued forever, invisible and uncounted.
        const stranded = cascadeFailure(await store.getAll(), next.id);
        for (const s of stranded) {
          await store.put(s);
          deadLettered += 1;
        }
      } else retried += 1;
    }
    opts.onChange?.();
  }

  return {
    attempted: due.length,
    sent,
    retried,
    deadLettered,
    remaining: await store.count(),
  };
}
