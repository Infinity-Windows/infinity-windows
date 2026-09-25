// Pure, framework-free core of the global offline write outbox. NO IndexedDB,
// NO Supabase, NO React in this file — everything here is deterministic and
// unit-testable so the queue's guarantees (dedupe, backoff, FIFO drain,
// dead-letter, replay) can be proven without a browser or a network.
//
// The runtime (outbox.ts) wires this core to an IndexedDB-backed store and a
// map of Supabase op handlers. The install-flow outbox (lib/install/*) is a
// separate module that shares this file's retry policy and, since K0.6, hands
// its media to the runtime once the install itself has landed.

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
  // then the record is gone forever. These queue instead.
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
  // The ORIGINAL file a PDF receipt came from (2026-09-05). The receipt's own
  // photo is page one, rendered on the phone, and it travels in the
  // receipt_capture entry above exactly as a snapped photo always has — this
  // is the second entry that puts the PDF itself in the bucket and records it
  // on the row. Always `dependsOn` its receipt_capture entry, the same reason
  // receipt_answer is: set_receipt_document cannot name a receipt that has not
  // been filed. A separate entry rather than a sixth field on the capture
  // payload, because that payload is sitting in IndexedDB on phones right now,
  // minted by a bundle that never heard of a document.
  | "receipt_document_upload"
  // Wave Q: a finished video quiz attempt. Unlike most of this queue, the
  // caller tries submit_video_quiz directly FIRST (videoQuiz.ts's
  // submitVideoQuiz, the offlineWrites.ts pattern) so an installer sees
  // their score immediately when there is signal — this op only exists for
  // the fallback, when that direct call fails with a network-shaped error.
  | "video_quiz_submit"
  // S4 (job facts, 20261001000000): a single job-facts field, saved on blur.
  // A foreman fills these in standing at the site with whatever signal the
  // job has, one field at a time, so every save has to survive the same dead
  // zones a photo does. upsert_build_facts is idempotent on (project, field)
  // — saving the same value twice lands on the same row — so a resend is
  // harmless.
  | "save_build_facts"
  | "hex_portal_case"
  | "hex_portal_outcome"
  // A lesson write-up draft (20261026000000). Carries the revision the phone
  // last saw and a fixed action id, so a resend is the same save and a save
  // made stale by another screen dead-letters with its words intact.
  | "hex_learning_draft"
  // Today's toolbox talk, signed with no signal (20261033000000). clock_in
  // refuses the day's first punch until the signature is on record, so this
  // rides the clock lane AHEAD of every punch (see laneOf), and a clock-in
  // tapped after it `dependsOn` it. Keyed by the phone's client id in the
  // payload; the signature image and the PDF go to paths made from that id,
  // with upsert, so a resend lands on the same files and the same row.
  | "toolbox_sign";

/**
 * queued   — waiting to be sent (respecting nextAttemptAt backoff)
 * sending  — a drain is currently attempting this entry
 * failed   — dead-letter: exhausted retries or hit a permanent error; needs
 *            human attention. Never silently dropped.
 */
export type OutboxStatus = "queued" | "sending" | "failed";

/**
 * The four clock punches. They are the one kind of write here whose timing
 * is the record — a clock-out that lands twenty minutes late is twenty
 * minutes of somebody's pay — so the drain sends them ahead of everything
 * else (K0.3), and the clock screens read them back to show a punch that is
 * still on the phone as real (K0.1).
 */
export function isClockOp(op: OutboxOp): boolean {
  return op === "clock_in" || op === "clock_out" || op === "break_start" || op === "break_stop";
}

/**
 * The drain's lanes, in the order they go (K0.3; offline toolbox signing,
 * 2026-09-25):
 *   0 — today's toolbox talk signatures. clock_in refuses the day's first
 *       punch without one on record, so a signature made with no signal must
 *       reach the server before any punch — even one queued before it. A
 *       signature never depends on a punch, so sending it first can only
 *       help.
 *   1 — the four clock punches, in tap order.
 *   2 — everything else (photos, logs, warehouse moves).
 */
export function laneOf(op: OutboxOp): 0 | 1 | 2 {
  if (op === "toolbox_sign") return 0;
  return isClockOp(op) ? 1 : 2;
}

/** A write that goes ahead of the photos: a clock punch, or a signature. */
export function isClockLaneOp(op: OutboxOp): boolean {
  return laneOf(op) < 2;
}

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

/**
 * The drain stopped waiting for a send (the send watchdog, 2026-09-25 — see
 * drainStore). An ordinary retryable failure: the entry goes back in the
 * queue with its backoff, counts one attempt, and the message is what the
 * stuck-writes screen shows if it ever runs out of attempts. Plain words, and
 * none of the words isRetryableError reads as permanent.
 */
export class SendTookTooLongError extends Error {
  constructor() {
    super("This was taking too long to send, so the phone stopped waiting and will try it again.");
    this.name = "SendTookTooLongError";
  }
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
  //
  // `jwt` sat in this list until 2026-09-04 and had to come out. An expired
  // access token is the most TEMPORARY failure there is — refreshing it fixes
  // it — but the word made it permanent, so a phone coming back from a long
  // dead zone with a stale token dead-lettered a FINISHED install on its very
  // first attempt, and the sheet reported that one-second problem to the
  // installer as a verdict on their work.
  //
  // Nothing is lost by dropping it: the SQLSTATE check above already catches
  // every refusal that matters — a real permission failure arrives as 42501,
  // one of our own rules as P0001 — and those are the codes an auth problem
  // that is NOT about a stale token comes back with.
  //
  // A stale token fixes itself on the retry, without any help from us:
  // supabase-js asks auth for the session before every request it sends, and
  // that call refreshes a token that has expired. Calling it retryable is
  // therefore not just safer, it is accurate — the next attempt goes out with
  // a good token.
  if (/duplicate key|already exists|violates|invalid input|permission denied|not authorized|forbidden|row-level security/.test(msg)) {
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
 * Which entries are due to attempt right now: toolbox talk signatures, then
 * clock punches, then everything else, FIFO (createdAt) within each (laneOf). Skips entries that are: not
 * `queued`, not yet past their backoff window, or blocked behind an
 * unresolved `dependsOn` that is still in the queue.
 *
 * Punches first (K0.3, 2026-09-23): the drain is one lane, so a clock-out
 * tapped after three photos used to sit behind three two-minute uploads on a
 * bad link — and on a link that bad the photos often failed, which pushed the
 * punch to the next pass and the one after. The four clock ops now jump the
 * queue. Order AMONG punches is still tap order, so a clock-in goes before
 * the break and the break before the clock-out, and `dependsOn` is judged
 * before the sort, so a clock-out still waits for the clock-in it hangs off.
 *
 * Signatures ahead of punches (offline toolbox signing, 2026-09-25): a
 * clock-in that reaches the server before today's signature is refused on the
 * toolbox gate, so a signature goes first even when a punch was queued before
 * it (a re-signature after the first was thrown away, a clock-in tapped
 * yesterday and sent today). A clock-in tapped after a signature also
 * `dependsOn` it, which is what holds it while the signature is retrying.
 */
export function dueEntries(entries: OutboxEntry[], now: number): OutboxEntry[] {
  const present = new Map(entries.map((e) => [e.id, e]));
  const lane = (e: OutboxEntry) => laneOf(e.op);
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
    .sort(
      (a, b) => lane(a) - lane(b) || a.createdAt - b.createdAt || a.id.localeCompare(b.id),
    );
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
  // A refused toolbox talk signature is the one failure that HOLDS what waits
  // on it instead of failing it (offline toolbox signing, 2026-09-25). The
  // clock-in behind it was never sent and must not be sent — the server would
  // only refuse it on "complete today's toolbox talk" — but it is still a
  // real tap, paid from its tap time once the signature goes through. So it
  // stays queued, blocked by its dependsOn: Try again on the signature sends
  // both, in order; Throw away releases it to be judged by the server.
  if (entries.find((e) => e.id === failedId)?.op === "toolbox_sign") return [];
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
  /**
   * Voice memos (K0.6, 2026-09-23). A unit's memo rides `photo_upload` with
   * `kind: "voice_memo"` — same handler, same client id, same attachments
   * row — but an installer who recorded a memo and reads "Photos 1" on the
   * pill goes looking for a photo that does not exist. Its own bucket, so the
   * pill says what is actually waiting.
   */
  memos: number;
  receipts: number;
  logs: number;
  other: number;
  deadLetter: number;
  /** Warehouse writes made with no signal (ticket 10). Counted SEPARATELY
   * from `other` rather than sharing it: the warehouse page says "3 not sent
   * yet" and must not be quoting somebody's queued pin-reset. */
  warehouse: number;
  /** Toolbox talk signatures still on the phone (2026-09-25). Their own
   * bucket, not `clock`: "Clock 2" over one punch and one signature would
   * send a person looking for a second punch that does not exist. */
  toolbox: number;
}

const EMPTY_COUNTS: OpCounts = {
  clock: 0,
  photos: 0,
  memos: 0,
  receipts: 0,
  logs: 0,
  other: 0,
  deadLetter: 0,
  warehouse: 0,
  toolbox: 0,
};

/** The media kind an upload entry carries; a photo unless it says otherwise. */
export function uploadKind(entry: OutboxEntry): "photo" | "voice_memo" | "video" | "document" {
  const kind = entry.payload.kind;
  return kind === "voice_memo" || kind === "video" || kind === "document" ? kind : "photo";
}

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
      case "toolbox_sign":
        c.toolbox += 1;
        break;
      case "photo_upload":
        if (uploadKind(e) === "voice_memo") c.memos += 1;
        else c.photos += 1;
        break;
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
  toolbox: (n) => `Toolbox talk ${n}`,
  photos: (n) => `Photos ${n}`,
  memos: (n) => `Memos ${n}`,
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
  receipt_document_upload: true,
  video_quiz_submit: true,
  save_build_facts: true,
  hex_portal_case: true,
  hex_portal_outcome: true,
  hex_learning_draft: true,
  toolbox_sign: true,
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

/**
 * Is `current` still the entry `expected` was read as? Compared the way every
 * read sees an entry — through deserializeEntry, so a "sending" mark counts as
 * the queued entry it marked — and field for field, attempt count, error and
 * backoff included. Both absent counts as the same.
 *
 * What makes the drain's writes conditional (OutboxStore.swap): a write based
 * on an old read must never land over a newer one (Codex review of #658).
 */
export function sameState(current: OutboxEntry | null, expected: OutboxEntry | null): boolean {
  if (current === null || expected === null) return current === expected;
  const a = deserializeEntry(serializeEntry(current));
  const b = deserializeEntry(serializeEntry(expected));
  return a !== null && b !== null && serializeEntry(a) === serializeEntry(b);
}

// --- generic drain over any store + handler map --------------------------

export interface OutboxStore {
  getAll(): Promise<OutboxEntry[]>;
  /** Persist an entry (and optionally its blob). Insert or replace by id. */
  put(entry: OutboxEntry, blob?: Blob | null): Promise<void>;
  getBlob(id: string): Promise<Blob | null>;
  /** Insert unless the id exists; returns the existing entry, or null when
   * inserted. Atomic. Optional: only a caller-minted stable id uses it. */
  insertIfAbsent?(entry: OutboxEntry, blob: Blob | null): Promise<OutboxEntry | null>;
  delete(id: string): Promise<void>;
  count(): Promise<number>;
  /**
   * Replace the entry under `id` with `next` — or delete it, when `next` is
   * null — ONLY if what is stored now is still `expected` (sameState), in one
   * atomic step; resolves whether it wrote. A stored photo stays with its
   * entry. Every write the drain makes about an entry goes through here, so a
   * write based on an old read — a "sending" mark that the phone's database
   * finally answers after the watchdog recorded the attempt, a failure record
   * for an entry that has since been sent or thrown away — changes nothing.
   */
  swap(id: string, expected: OutboxEntry | null, next: OutboxEntry | null): Promise<boolean>;
}

/**
 * A handler performs the real network write for one op. Throws on failure.
 * Whatever it resolves with is handed to `onSent` beside the entry — the
 * clock handlers resolve with the shift row the server answered, so the
 * screens can show the confirmed punch without waiting for a re-read.
 */
export type OpHandler = (
  entry: OutboxEntry,
  ctx: {
    getBlob: () => Promise<Blob | null>;
    /**
     * Aborted once the drain has stopped waiting for this send (the send
     * watchdog). The drain ignores whatever the handler does after that, and
     * the entry is retried from the queue; a handler checks this before a
     * second write that must not land late, beside its own retry. Absent when
     * a handler is called outside a drain.
     */
    signal?: AbortSignal;
  },
) => Promise<unknown>;

export type OpHandlers = Partial<Record<OutboxOp, OpHandler>>;

export interface DrainResult {
  attempted: number;
  sent: number;
  retried: number;
  deadLettered: number;
  remaining: number;
}

/**
 * The drain's clock. Tests hand in a fixed number so a run is deterministic;
 * a function is a live clock that advances while handlers run; nothing means
 * the wall clock. Read once per pass to decide what is due, and again at each
 * failure so a retry is measured from when it failed.
 */
export interface DrainOpts {
  now?: number | (() => number);
  onChange?: () => void;
  /**
   * A server write succeeded and its local queue entry was removed. `result`
   * is whatever the handler resolved with (a clock handler's shift row).
   */
  onSent?: (entry: OutboxEntry, result: unknown) => void;
  /**
   * The send watchdog: how long one send may run before the drain stops
   * waiting for it. Asked once as the send starts (`blobBytes` null) and again
   * once the send has read its file back, with the file's size, so a big photo
   * on one bar gets the time its size needs. Omitted, a drain waits for every
   * send for as long as it takes — which is how a single send that never
   * answered used to hold the queue until the app was relaunched.
   */
  sendDeadlineMs?: (entry: OutboxEntry, blobBytes: number | null) => number;
  /** The watchdog gave up waiting on this send; it will be retried. */
  onAbandoned?: (entry: OutboxEntry, deadlineMs: number) => void;
}

/** What one send came to — decided once, by whichever of the send or the
 * watchdog got there first. */
type SendOutcome =
  | { kind: "sent"; result: unknown }
  | { kind: "failed"; error: unknown }
  | { kind: "abandoned"; deadlineMs: number }
  /** The entry changed between the pass's read and this send: not sent. */
  | { kind: "stale" };

/** setTimeout's own ceiling (2^31-1 ms); anything longer fires at once. */
const MAX_TIMER_MS = 2_147_483_647;

function clockOf(opts: DrainOpts): () => number {
  const n = opts.now;
  if (typeof n === "function") return n;
  if (typeof n === "number") return () => n;
  return () => Date.now();
}

/**
 * Attempt every due entry once — punches first, then the rest, FIFO within
 * each (see dueEntries). Success → delete; failure → backoff or dead-letter.
 * This is the whole drainer, decoupled from IndexedDB/Supabase so it can be
 * exercised with an in-memory store and fake handlers.
 *
 * Before each NON-clock entry the store is read again for punches that became
 * due while the pass was running (K0.3): tapped during a photo upload, or a
 * clock-out just unblocked by the clock-in this pass sent. The pass works from
 * a snapshot, and without this a punch tapped while photo one of three was
 * uploading waited for photos two and three as well — one re-read of a small
 * store per upload is nothing next to the upload.
 *
 * THE SEND WATCHDOG (2026-09-25, `opts.sendDeadlineMs`). One send at a time is
 * the design, so one send that never answers used to hold the whole queue —
 * and three steps inside a send had no time limit: reading the reply once it
 * has started to arrive (timedFetch's deadline ends at the headers), the
 * sign-in check supabase-js makes before every request, and opening the
 * phone's database to read the photo back. The owner's phone sat on "Photos 5"
 * for thirteen minutes back on Wi-Fi with nothing sent and nothing on the
 * stuck-writes screen. Now each send races a deadline. If the deadline wins,
 * the drain records an ordinary retryable failure (SendTookTooLongError, one
 * attempt, the usual backoff), says so through onAbandoned, and moves on to
 * the next entry — clock punches first, as always.
 *
 * The abandoned attempt is not cancelled — nothing here can cancel a fetch
 * that supabase-js owns — so it may wake up later. Whatever it does then is
 * ignored by the queue: its outcome is never recorded (no second "sent", no
 * failure written over the retry's record, no entry brought back), a file
 * read that answers late refuses to hand the photo over, a late "sending"
 * mark does not start the handler, and `ctx.signal` is aborted so a handler
 * can decline its own second write. What it may already have sent to the
 * server is covered the way a reply lost to a dead zone always has been:
 * every handler's write is keyed or checked so a resend lands once.
 */
export async function drainStore(
  store: OutboxStore,
  handlers: OpHandlers,
  opts: DrainOpts = {},
): Promise<DrainResult> {
  const clock = clockOf(opts);
  const now = clock();
  const all = await store.getAll();
  const due = dueEntries(all, now);
  let attempted = 0;
  let sent = 0;
  let retried = 0;
  let deadLettered = 0;
  const tried = new Set<string>();

  /**
   * Record a failed (or abandoned) send: backoff or dead-letter.
   *
   * Stamp the failure from the clock NOW, not from the pass's opening read. A
   * pass can hold a 25 MB photo upload for half a minute; a write that fails
   * after it would otherwise get a retry time already in the past, and
   * drainUntilSettled's next pass would try it again at once — burning one of
   * its MAX_ATTEMPTS on the same dead signal.
   */
  const recordFailure = async (entry: OutboxEntry, err: unknown): Promise<void> => {
    const next = applyFailure(entry, err, clock());
    // Only over the entry this attempt read: if it was sent, thrown away or
    // changed meanwhile, that newer state stands and this record is dropped.
    if (!(await store.swap(entry.id, entry, next))) return;
    if (next.status === "failed") {
      deadLettered += 1;
      // Anything waiting on this can never be sent now. Fail it here rather
      // than leaving it queued forever, invisible and uncounted.
      const snapshot = await store.getAll();
      const stranded = cascadeFailure(snapshot, next.id);
      for (const s of stranded) {
        const was = snapshot.find((e) => e.id === s.id) ?? null;
        if (await store.swap(s.id, was, s)) deadLettered += 1;
      }
    } else retried += 1;
  };

  /**
   * Run one send — mark it sending, then the handler — racing the watchdog
   * when one is asked for. Resolves with whichever finished first; the loser
   * is ignored (see the watchdog note above).
   */
  const sendWithin = (entry: OutboxEntry, handler: OpHandler): Promise<SendOutcome> => {
    const abort = new AbortController();
    const { signal } = abort;
    /** Told the file's size once the send has read it (the watchdog re-arms). */
    let onBlob: ((blob: Blob | null) => void) | null = null;

    const send = async (): Promise<SendOutcome> => {
      // Marked only if the entry is still what this pass read. A mark the
      // phone's database answers after the watchdog has recorded the attempt
      // finds that newer record and writes nothing — it used to put back the
      // pre-attempt copy, wiping the attempt, its reason and its backoff.
      if (!(await store.swap(entry.id, entry, markSending(entry)))) return { kind: "stale" };
      // The mark landed after the drain gave up (the phone's database answered
      // late): starting the handler now would send beside the retry.
      if (signal.aborted) return { kind: "abandoned", deadlineMs: 0 };
      try {
        const result = await handler(entry, {
          getBlob: async () => {
            const blob = await store.getBlob(entry.id);
            // A read that answered after the drain gave up must not hand the
            // photo over: the retry uploads it, not this attempt.
            if (signal.aborted) throw new SendTookTooLongError();
            onBlob?.(blob);
            return blob;
          },
          signal,
        });
        return { kind: "sent", result };
      } catch (error) {
        return { kind: "failed", error };
      }
    };

    const deadlineFor = opts.sendDeadlineMs;
    if (!deadlineFor) return send();

    return new Promise<SendOutcome>((resolve, reject) => {
      const startedAt = Date.now();
      let limit = deadlineFor(entry, null);
      let timer: ReturnType<typeof setTimeout> | undefined;
      let decided = false;
      const giveUp = () => {
        if (decided) return;
        decided = true;
        abort.abort();
        resolve({ kind: "abandoned", deadlineMs: limit });
      };
      const arm = () => {
        if (timer !== undefined) clearTimeout(timer);
        timer = undefined;
        if (!Number.isFinite(limit)) return;
        const left = Math.max(0, startedAt + limit - Date.now());
        timer = setTimeout(giveUp, Math.min(left, MAX_TIMER_MS));
      };
      onBlob = (blob) => {
        if (decided || !blob) return;
        const sized = deadlineFor(entry, blob.size);
        if (sized === limit) return;
        limit = sized;
        arm();
      };
      arm();
      send().then(
        (outcome) => {
          if (decided) return; // woke up after the drain moved on: ignored
          decided = true;
          if (timer !== undefined) clearTimeout(timer);
          resolve(outcome);
        },
        (err) => {
          // The store itself failed (not the handler): the drain gives up on
          // this pass, exactly as it did before the watchdog.
          if (decided) return;
          decided = true;
          if (timer !== undefined) clearTimeout(timer);
          reject(err);
        },
      );
    });
  };

  const attempt = async (entry: OutboxEntry): Promise<void> => {
    tried.add(entry.id);
    attempted += 1;
    const handler = handlers[entry.op];
    if (!handler) {
      // No handler registered → dead-letter so it surfaces rather than looping.
      const dead: OutboxEntry = { ...entry, status: "failed", lastError: `No handler for op "${entry.op}"` };
      if (await store.swap(entry.id, entry, dead)) deadLettered += 1;
      return;
    }
    const outcome = await sendWithin(entry, handler);
    if (outcome.kind === "stale") {
      // Changed under this pass (another tab, a person): the next pass reads
      // it fresh. Nothing was sent.
    } else if (outcome.kind === "sent") {
      // The server has it. Delete the entry this attempt marked — not one
      // that has changed since.
      await store.swap(entry.id, entry, null);
      sent += 1;
      // Confirmation is different from an absent entry (which may have been
      // discarded). A UI observer must never turn a successful write into a retry.
      try { opts.onSent?.(entry, outcome.result); } catch { /* best-effort observer */ }
    } else if (outcome.kind === "failed") {
      await recordFailure(entry, outcome.error);
    } else {
      await recordFailure(entry, new SendTookTooLongError());
      try { opts.onAbandoned?.(entry, outcome.deadlineMs); } catch { /* best-effort observer */ }
    }
    opts.onChange?.();
  };

  for (const entry of due) {
    if (tried.has(entry.id)) continue;
    if (!isClockLaneOp(entry.op)) {
      // Punches — and today's toolbox talk signatures, which go ahead of
      // them — that became due while this pass was running.
      const punches = dueEntries(await store.getAll(), clock()).filter(
        (e) => isClockLaneOp(e.op) && !tried.has(e.id),
      );
      for (const punch of punches) await attempt(punch);
    }
    await attempt(entry);
  }

  return {
    attempted,
    sent,
    retried,
    deadLettered,
    remaining: await store.count(),
  };
}

/**
 * Ceiling on passes in one drain — a guard, not a budget. Every pass after the
 * first runs only because the one before it SENT something, so a drain ends on
 * its own as soon as the queue stops changing; this only stops a handler that
 * keeps queueing more work from holding the drain open forever.
 */
export const MAX_DRAIN_PASSES = 25;

/**
 * Drain until a pass changes nothing.
 *
 * One pass works from a snapshot of the queue, and two things happen during a
 * pass that the snapshot cannot see. Sending an entry unblocks whatever
 * `dependsOn` it — a PDF receipt's original file waits on its receipt row, a
 * clock-out on its clock-in — and `dueEntries` had already set those aside as
 * blocked. And a write queued WHILE the pass was attempting an earlier one is
 * in the store but not in the snapshot: the original file is queued while the
 * receipt is still uploading, by design, and an answer to "bill this to the
 * customer?" is given while the photo is. Either way the entry used to sit
 * until the next trigger — the 30-second interval, in practice — so on every
 * phone a receipt's PDF landed half a minute after the receipt did. A pass
 * that sent something is now followed by another, until one sends nothing;
 * a retried (backed-off) or still-blocked entry cannot keep it going.
 */
export async function drainUntilSettled(
  store: OutboxStore,
  handlers: OpHandlers,
  opts: DrainOpts = {},
): Promise<DrainResult> {
  const total: DrainResult = { attempted: 0, sent: 0, retried: 0, deadLettered: 0, remaining: 0 };
  for (let pass = 0; pass < MAX_DRAIN_PASSES; pass++) {
    const res = await drainStore(store, handlers, opts);
    total.attempted += res.attempted;
    total.sent += res.sent;
    total.retried += res.retried;
    total.deadLettered += res.deadLettered;
    total.remaining = res.remaining;
    if (res.sent === 0 || res.remaining === 0) break;
  }
  return total;
}
