// Pure, framework-free core of the global offline write outbox. NO IndexedDB,
// NO Supabase, NO React in this file — everything here is deterministic and
// unit-testable so the queue's guarantees (dedupe, backoff, FIFO drain,
// dead-letter, replay) can be proven without a browser or a network.
//
// The runtime (outbox.ts) wires this core to an IndexedDB-backed store and a
// map of Supabase op handlers. The install-flow outbox (lib/install/*) is a
// separate module and is intentionally left untouched.

/** Every kind of write the outbox can carry. Add new ops here + a handler. */
export type OutboxOp =
  | "clock_in"
  | "clock_out"
  | "break_start"
  | "break_stop"
  | "daily_log"
  | "photo_upload"
  | "receipt_upload";

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
 * Classify a drain failure. Network / transient errors are retried with
 * backoff; permanent errors (validation, auth, conflict) go straight to the
 * dead-letter so we don't hammer the server forever. Anything unknown is
 * treated as retryable — losing a field write is worse than a wasted retry.
 */
export function isRetryableError(err: unknown): boolean {
  if (err == null) return true;
  const permanent = (err as { permanent?: unknown }).permanent;
  if (permanent === true) return false;
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

// --- pending counts + the sync-status pill copy (p1-12) -----------------

export interface OpCounts {
  clock: number;
  photos: number;
  receipts: number;
  logs: number;
  other: number;
  deadLetter: number;
}

const EMPTY_COUNTS: OpCounts = {
  clock: 0,
  photos: 0,
  receipts: 0,
  logs: 0,
  other: 0,
  deadLetter: 0,
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
        c.photos += 1;
        break;
      case "receipt_upload":
        c.receipts += 1;
        break;
      case "daily_log":
        c.logs += 1;
        break;
      default:
        c.other += 1;
    }
  }
  return c;
}

export function totalPending(c: OpCounts): number {
  return c.clock + c.photos + c.receipts + c.logs + c.other;
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
  const parts: string[] = [];
  if (c.clock > 0) parts.push(`Clock ${c.clock}`);
  if (c.photos > 0) parts.push(`Photos ${c.photos}`);
  if (c.receipts > 0) parts.push(`Receipts ${c.receipts}`);
  if (c.logs > 0) parts.push(c.logs === 1 ? "1 log queued" : `${c.logs} logs queued`);
  if (c.other > 0) parts.push(`${c.other} queued`);
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

const OPS: ReadonlySet<string> = new Set<OutboxOp>([
  "clock_in",
  "clock_out",
  "break_start",
  "break_stop",
  "daily_log",
  "photo_upload",
  "receipt_upload",
]);

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
      if (next.status === "failed") deadLettered += 1;
      else retried += 1;
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
