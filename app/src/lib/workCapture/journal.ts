// Bounded browser command journal foundation (dormant — no UI wiring, no
// network calls, no dispatcher). This is the one place a "switch personal
// activity" intent is durably recorded as an immutable, causally-ordered
// command before anything attempts to send it anywhere.
//
// GUARANTEES
// - A dedicated IndexedDB database (`iw-work-capture-journal-v1`, version 1)
//   separate from the production v2 outbox/photo database. Nothing here ever
//   opens, migrates, or touches that database.
// - Every append is one native `readwrite` transaction that rereads the
//   current stream head and inserts the new command + advances the head
//   atomically. Append and receipt-write promises resolve only from
//   `tx.oncomplete` — never from an individual request's `onsuccess` — so a
//   caller can never observe a command as "saved" before the browser has
//   actually committed both the row and the head together.
// - Concurrent calls (same tab or different tabs) serialize through native
//   IndexedDB transaction ordering alone. There is no `navigator.locks` use
//   and no in-memory mutex standing in for it.
// - A duplicate `requestId` with byte-identical envelope content is treated
//   as the original caller's own retry: the original immutable command comes
//   back and the stream sequence does not move. A duplicate `requestId` with
//   different content is a programming error and throws.
// - The caller's intent object is defensively cloned and validated
//   synchronously, before this module performs its first `await`. Combined
//   with a JSON round-trip before every write, mutating the object the
//   caller passed in after calling `appendSwitchCommand` can never change
//   the bytes that get persisted.
// - Everything stored is plain JSON: strings, finite numbers, null, and
//   plain objects built from those. No Blob, no class instance, no function.
//
// LIMITATIONS (by design, for this slice)
// - There is no in-memory or localStorage fallback. When IndexedDB is
//   unavailable (no global, blocked upgrade, or an aborted/`InvalidStateError`
//   transaction) the operation rejects. Nothing here will ever claim a
//   command is durable when it is not.
// - This module only knows how to append a "switch personal activity" intent
//   and record what happened to it later (sent/confirmed/needsReview). It
//   does not start, stop, or validate any real break/clock/payroll command,
//   and nothing reads this journal to drive the UI yet.
// - Readiness only checks causal ordering (is the immediate predecessor
//   confirmed?). It does not retry, replay, or rebase anything — a rejected
//   predecessor permanently blocks its successors from this check until a
//   human/operator process deals with it out of band.
// - Unit tests cover plain-input validation/storage refusal. Native IndexedDB
//   transaction, reload, abort and v2 photo-preservation tests live in
//   e2e/work-capture-journal.spec.ts. See release receipts for engine results;
//   a source comment is not evidence of a passed WebKit or field test.
// - Receipt storage is an owner-bound overlay, not proof of server acceptance.
//   A future token-bound dispatcher must validate the exact server response
//   before recording confirmation. This dormant module cannot enforce CAS.

/** The database name/version this module owns. Exported only as inert
 * metadata (e.g. for a test fixture that needs to open the same database
 * directly) — never mutated, and not a handle to live state. */
export const JOURNAL_DB_NAME = "iw-work-capture-journal-v1";
export const JOURNAL_DB_VERSION = 1;

const DB_NAME = JOURNAL_DB_NAME;
const DB_VERSION = JOURNAL_DB_VERSION;
const COMMANDS_STORE = "commands";
const HEADS_STORE = "heads";
const STREAM_INDEX = "by_stream";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** An opaque, server/catalog-defined identifier. Never parsed, only compared. */
export type OpaqueRef = string;

export type MachineryKind = "forklift" | "tele_handler" | "scissor_lift" | "spider_suction";

const GENERAL_MACHINERY: ReadonlySet<MachineryKind> = new Set(["forklift", "tele_handler"]);
const SPECIFIC_MACHINERY: ReadonlySet<MachineryKind> = new Set([
  "forklift",
  "tele_handler",
  "scissor_lift",
  "spider_suction",
]);

export interface SwitchIntentDimensionFact {
  readonly factRevision: OpaqueRef;
  readonly widthIn: number;
  readonly heightIn: number;
}

interface SwitchIntentCommon {
  readonly projectRef: OpaqueRef;
  readonly activityRef: OpaqueRef;
  readonly menuRevision: OpaqueRef;
  readonly machineryKind?: MachineryKind;
}

export interface GeneralSwitchIntent extends SwitchIntentCommon {
  readonly scope: "general";
  readonly unitRef: OpaqueRef | null;
}

export interface SpecificSwitchIntent extends SwitchIntentCommon {
  readonly scope: "specific";
  readonly unitRef: OpaqueRef;
  readonly dimensionFact: SwitchIntentDimensionFact;
}

/** The only command shape this journal knows about right now. */
export type SwitchIntent = GeneralSwitchIntent | SpecificSwitchIntent;

export interface SwitchCommandEnvelope {
  readonly encodingVersion: 1;
  readonly requestId: string;
  readonly ownerId: string;
  readonly deviceId: string;
  readonly clientGeneration: string;
  readonly sequence: number;
  readonly predecessorRequestId: string | null;
  readonly expectedRevision: number;
  readonly shiftRef: OpaqueRef;
  readonly intent: SwitchIntent;
  readonly tapAt: string;
  readonly observedServerEvidence: OpaqueRef;
}

/** What the caller supplies; `sequence` and `predecessorRequestId` are derived by this module. */
export interface AppendSwitchCommandInput {
  readonly requestId: string;
  readonly ownerId: string;
  readonly deviceId: string;
  readonly expectedRevision: number;
  readonly shiftRef: OpaqueRef;
  readonly intent: SwitchIntent;
  readonly tapAt: string;
  readonly observedServerEvidence: OpaqueRef;
}

export type ReceiptStatus = "sent" | "confirmed" | "needsReview";

export interface CommandReceiptInput {
  readonly status: ReceiptStatus;
  /** Required and only meaningful for "confirmed": the server's authoritative revision. */
  readonly serverRevision?: number;
  /** Required and only meaningful for "confirmed": an authoritative result reference. */
  readonly resultRef?: OpaqueRef;
  /** Optional context for "needsReview" (e.g. why the server refused it). */
  readonly reason?: string;
}

export interface CommandReceipt extends CommandReceiptInput {
  readonly recordedAt: string;
}

export interface JournalCommandRecord {
  readonly command: SwitchCommandEnvelope;
  readonly receipt: CommandReceipt | null;
}

export interface StreamHead {
  readonly ownerId: string;
  readonly deviceId: string;
  readonly clientGeneration: string;
  readonly sequence: number;
  readonly headRequestId: string;
}

export type ReadinessResult =
  | { readonly ready: true }
  | { readonly ready: false; readonly reason: "needsPredecessor"; readonly blockingRequestId: string };

export class JournalValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JournalValidationError";
  }
}

export class JournalConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JournalConflictError";
  }
}

export class JournalUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "JournalUnavailableError";
  }
}

export class JournalSequenceOverflowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JournalSequenceOverflowError";
  }
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 256;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isSafeNonNegativeInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && Number.isSafeInteger(value) && value >= 0;
}

function isValidTapAt(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(?:Z|[+-](?:0\d|1[0-4]):[0-5]\d)$/.exec(value);
  if (!match) return false;
  const [, y, m, d, h, min, sec] = match.map(Number);
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return m >= 1 && m <= 12 && d >= 1 && d <= days && h < 24 && min < 60 && sec < 60 && Number.isFinite(Date.parse(value));
}

function validateMachineryKind(kind: unknown, scope: "general" | "specific"): asserts kind is MachineryKind | undefined {
  if (kind === undefined) return;
  const allowed = scope === "general" ? GENERAL_MACHINERY : SPECIFIC_MACHINERY;
  if (typeof kind !== "string" || !allowed.has(kind as MachineryKind)) {
    throw new JournalValidationError(`machineryKind "${String(kind)}" is not valid for scope "${scope}".`);
  }
}

function validateIntent(intent: unknown): asserts intent is SwitchIntent {
  if (!intent || typeof intent !== "object") {
    throw new JournalValidationError("intent must be an object.");
  }
  const i = intent as Record<string, unknown>;
  assertKeys(i, i.scope === "specific"
    ? ["scope","projectRef","activityRef","menuRevision","machineryKind","unitRef","dimensionFact"]
    : ["scope","projectRef","activityRef","menuRevision","machineryKind","unitRef"]);
  if (!isNonEmptyString(i.projectRef)) throw new JournalValidationError("intent.projectRef must be a nonempty string.");
  if (!isNonEmptyString(i.activityRef)) throw new JournalValidationError("intent.activityRef must be a nonempty string.");
  if (!isNonEmptyString(i.menuRevision)) throw new JournalValidationError("intent.menuRevision must be a nonempty string.");

  if (i.scope === "general") {
    validateMachineryKind(i.machineryKind, "general");
    if (i.unitRef !== null) {
      throw new JournalValidationError("General intent.unitRef must be null.");
    }
    if ("dimensionFact" in i) {
      throw new JournalValidationError("General intent must not carry a dimensionFact.");
    }
    return;
  }

  if (i.scope === "specific") {
    validateMachineryKind(i.machineryKind, "specific");
    if (!isNonEmptyString(i.unitRef)) {
      throw new JournalValidationError("Specific intent.unitRef must be a nonempty string.");
    }
    const fact = i.dimensionFact;
    if (!fact || typeof fact !== "object") {
      throw new JournalValidationError("Specific intent requires a dimensionFact.");
    }
    const f = fact as Record<string, unknown>;
    assertKeys(f,["factRevision","widthIn","heightIn"]);
    if (!isNonEmptyString(f.factRevision)) {
      throw new JournalValidationError("dimensionFact.factRevision must be a nonempty string.");
    }
    if (!isFiniteNumber(f.widthIn) || f.widthIn <= 0) {
      throw new JournalValidationError("dimensionFact.widthIn must be a positive finite number.");
    }
    if (!isFiniteNumber(f.heightIn) || f.heightIn <= 0) {
      throw new JournalValidationError("dimensionFact.heightIn must be a positive finite number.");
    }
    return;
  }

  throw new JournalValidationError(`intent.scope must be "general" or "specific", got ${JSON.stringify(i.scope)}.`);
}

function validateAppendInput(input: AppendSwitchCommandInput): void {
  assertPlainJson(input);
  assertKeys(input,["requestId","ownerId","deviceId","expectedRevision","shiftRef","intent","tapAt","observedServerEvidence"]);
  if (!isUuid(input.requestId)) throw new JournalValidationError("requestId must be a valid UUID.");
  if (!isUuid(input.ownerId)) throw new JournalValidationError("ownerId must be a valid UUID.");
  if (!isUuid(input.deviceId)) throw new JournalValidationError("deviceId must be a valid UUID.");
  if (!isSafeNonNegativeInt(input.expectedRevision)) {
    throw new JournalValidationError("expectedRevision must be a safe nonnegative integer.");
  }
  if (!isNonEmptyString(input.shiftRef)) throw new JournalValidationError("shiftRef must be a nonempty string.");
  if (!isValidTapAt(input.tapAt)) throw new JournalValidationError("tapAt must be a valid timestamp string.");
  if (!isNonEmptyString(input.observedServerEvidence)) {
    throw new JournalValidationError("observedServerEvidence must be a nonempty string.");
  }
  validateIntent(input.intent);
}

/** Refuse unknown fields, custom serialization and non-JSON values. Never
 * silently strip a function, credential field or malformed number. */
function assertKeys(value: object, allowed: readonly string[]): void {
  if (Object.keys(value).some(key => !allowed.includes(key)))
    throw new JournalValidationError("Unknown journal field.");
}
function assertPlainJson(value: unknown): void {
  const seen = new Set<object>();
  let nodes = 0;
  const visit = (v: unknown): void => {
    if (++nodes > 512) throw new JournalValidationError("Journal payload is too large.");
    if (v === null || typeof v === "string" || typeof v === "boolean") return;
    if (typeof v === "number" && Number.isFinite(v)) return;
    if (typeof v !== "object" || seen.has(v)) throw new JournalValidationError("Journal requires plain JSON.");
    const prototype = Object.getPrototypeOf(v);
    if (!Array.isArray(v) && prototype !== Object.prototype && prototype !== null)
      throw new JournalValidationError("Journal requires plain objects.");
    seen.add(v);
    if (Object.getOwnPropertySymbols(v).length) throw new JournalValidationError("Journal requires JSON keys.");
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(v))) {
      if (Array.isArray(v) && key === "length") continue;
      if (!descriptor.enumerable || !('value' in descriptor)) throw new JournalValidationError("Journal requires plain JSON data.");
      visit(descriptor.value);
    }
    seen.delete(v);
  };
  visit(value);
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > 20000)
    throw new JournalValidationError("Journal payload is too large.");
}
/** Canonical key ordering makes equivalent retries independent of caller
 * object construction order; native storage and returned copies share no refs. */
function toPlainJsonClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value, (_key, v: unknown) => {
    if (v && typeof v === "object" && !Array.isArray(v))
      return Object.fromEntries(Object.keys(v).sort().map(key => [key,(v as Record<string,unknown>)[key]]));
    return v;
  })) as T;
}

function streamKey(ownerId: string, deviceId: string): string {
  return `${ownerId}:${deviceId}`;
}

function openDb(factory: IDBFactory): Promise<IDBDatabase> {
  if (!factory) {
    return Promise.reject(new JournalUnavailableError("IndexedDB is not available in this environment."));
  }
  return new Promise((resolve, reject) => {
    let req: IDBOpenDBRequest;
    try {
      req = factory.open(DB_NAME, DB_VERSION);
    } catch (error) {
      reject(new JournalUnavailableError("Could not open the work-capture journal database.", { cause: error }));
      return;
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(COMMANDS_STORE)) {
        const commands = db.createObjectStore(COMMANDS_STORE, { keyPath: "command.requestId" });
        commands.createIndex(STREAM_INDEX, ["command.ownerId", "command.deviceId", "command.sequence"], { unique: true });
      }
      if (!db.objectStoreNames.contains(HEADS_STORE)) {
        db.createObjectStore(HEADS_STORE, { keyPath: "streamKey" });
      }
    };
    let blocked = false;
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => db.close();
      if (blocked) {
        db.close();
        return;
      }
      resolve(db);
    };
    req.onerror = () => {
      reject(new JournalUnavailableError("Opening the work-capture journal database failed.", { cause: req.error }));
    };
    req.onblocked = () => {
      blocked = true;
      reject(new JournalUnavailableError("The work-capture journal database upgrade is blocked by another open tab."));
    };
  });
}

function storageError(phase: string, reason: unknown): Error {
  if (reason instanceof JournalValidationError || reason instanceof JournalConflictError
    || reason instanceof JournalUnavailableError || reason instanceof JournalSequenceOverflowError) {
    return reason;
  }
  const detail = reason instanceof Error ? `${reason.name}: ${reason.message}` : String(reason ?? "no browser error detail");
  return new JournalUnavailableError(`Work-capture journal ${phase} failed (${detail}).`, { cause: reason });
}

interface HeadRow {
  readonly streamKey: string;
  readonly ownerId: string;
  readonly deviceId: string;
  readonly clientGeneration: string;
  readonly sequence: number;
  readonly headRequestId: string;
}

interface CommandRow {
  readonly command: SwitchCommandEnvelope;
  receipt: CommandReceipt | null;
}

function validateHead(row: HeadRow, ownerId: string, deviceId: string): void {
  assertPlainJson(row);
  assertKeys(row,["streamKey","ownerId","deviceId","clientGeneration","sequence","headRequestId"]);
  if (row.streamKey !== streamKey(ownerId,deviceId) || row.ownerId !== ownerId || row.deviceId !== deviceId
      || !isUuid(row.clientGeneration) || !isSafeNonNegativeInt(row.sequence) || !isUuid(row.headRequestId))
    throw new JournalValidationError("Saved journal head is malformed.");
}
function cloneRecord(row: CommandRow): JournalCommandRecord {
  assertPlainJson(row);
  assertKeys(row,["command","receipt"]);
  if (!row.command || typeof row.command !== "object") throw new JournalValidationError("Saved command is malformed.");
  const c = row.command;
  assertKeys(c,["encodingVersion","requestId","ownerId","deviceId","clientGeneration","sequence","predecessorRequestId",
    "expectedRevision","shiftRef","intent","tapAt","observedServerEvidence"]);
  validateAppendInput({requestId:c.requestId,ownerId:c.ownerId,deviceId:c.deviceId,
    expectedRevision:c.expectedRevision,shiftRef:c.shiftRef,intent:c.intent,tapAt:c.tapAt,
    observedServerEvidence:c.observedServerEvidence});
  if (c.encodingVersion !== 1 || !isUuid(c.clientGeneration) || !isSafeNonNegativeInt(c.sequence)
      || (c.predecessorRequestId !== null && (!isUuid(c.predecessorRequestId) || c.predecessorRequestId === c.requestId))
      || (c.sequence === 0) !== (c.predecessorRequestId === null))
    throw new JournalValidationError("Saved command causality is malformed.");
  if (row.receipt !== null) {
    if (!row.receipt || typeof row.receipt !== "object") throw new JournalValidationError("Saved receipt is malformed.");
    assertKeys(row.receipt,["status","serverRevision","resultRef","reason","recordedAt"]);
    const {recordedAt,...receipt} = row.receipt;
    validateReceiptInput(receipt);
    if (!isValidTapAt(recordedAt)) throw new JournalValidationError("Saved receipt timestamp is malformed.");
  }
  return toPlainJsonClone({command:c,receipt:row.receipt});
}

function envelopeIdentityEqual(a: SwitchCommandEnvelope, b: AppendSwitchCommandInput): boolean {
  return a.ownerId === b.ownerId
    && a.deviceId === b.deviceId
    && a.expectedRevision === b.expectedRevision
    && a.shiftRef === b.shiftRef
    && a.tapAt === b.tapAt
    && a.observedServerEvidence === b.observedServerEvidence
    && JSON.stringify(a.intent) === JSON.stringify(b.intent);
}

/**
 * Append one switch-intent command to the (ownerId, deviceId) stream.
 *
 * Single readwrite transaction: rereads the existing row for this requestId
 * and the current stream head, then either returns the existing immutable
 * command (duplicate retry), refuses (conflicting duplicate), or inserts the
 * new command with the next sequence and advances the head — all before the
 * transaction is allowed to commit. The returned promise only resolves once
 * `tx.oncomplete` fires.
 */
export async function appendSwitchCommand(
  input: AppendSwitchCommandInput,
  options?: { factory?: IDBFactory },
): Promise<JournalCommandRecord> {
  validateAppendInput(input);
  // Deep-clone and freeze the caller's intent into plain JSON synchronously,
  // before the first await below — later mutation of the caller's object
  // cannot reach the bytes this module is about to persist.
  const safeInput: AppendSwitchCommandInput = toPlainJsonClone(input);

  const factory = options?.factory ?? (typeof indexedDB !== "undefined" ? indexedDB : undefined as unknown as IDBFactory);
  const db = await openDb(factory);
  try {
    return await new Promise<JournalCommandRecord>((resolve, reject) => {
      const tx = db.transaction([COMMANDS_STORE, HEADS_STORE], "readwrite");
      const commands = tx.objectStore(COMMANDS_STORE);
      const heads = tx.objectStore(HEADS_STORE);

      const fail = (reason: unknown) => {
        reject(storageError("append", reason));
        try { tx.abort(); } catch { /* already settling */ }
      };

      const existingReq = commands.get(safeInput.requestId);
      const headReq = heads.get(streamKey(safeInput.ownerId, safeInput.deviceId));
      const range = IDBKeyRange.bound([safeInput.ownerId,safeInput.deviceId,0],
        [safeInput.ownerId,safeInput.deviceId,Number.MAX_SAFE_INTEGER]);
      const tailReq = commands.index(STREAM_INDEX).openCursor(range,"prev");
      let existingReady = false;
      let headReady = false;
      let tailReady = false;
      let result: JournalCommandRecord | undefined;

      const proceed = () => {
        if (!existingReady || !headReady || !tailReady) return;
        try {
          const head = headReq.result as HeadRow | undefined;
          const tailRow = tailReq.result?.value as CommandRow | undefined;
          const tail = tailRow ? cloneRecord(tailRow).command : undefined;
          if (head) validateHead(head,safeInput.ownerId,safeInput.deviceId);
          if (Boolean(head) !== Boolean(tail) || (head && tail && (
              tail.ownerId !== safeInput.ownerId || tail.deviceId !== safeInput.deviceId
              || tail.requestId !== head.headRequestId || tail.sequence !== head.sequence
              || tail.clientGeneration !== head.clientGeneration)))
            throw new JournalValidationError("Saved stream head does not match its durable tail.");
          const existing = existingReq.result as CommandRow | undefined;
          if (existing) {
            if (existing.command?.ownerId !== safeInput.ownerId || existing.command?.deviceId !== safeInput.deviceId) {
              fail(new JournalConflictError("Request id already belongs to another stream."));
              return;
            }
            cloneRecord(existing);
            if (!envelopeIdentityEqual(existing.command, safeInput)) {
              fail(new JournalConflictError(
                `requestId ${safeInput.requestId} already exists with different command content.`,
              ));
              return;
            }
            result = cloneRecord(existing);
            // Duplicate of an already-applied command: nothing to write, the
            // sequence must not move. Letting the transaction commit with no
            // writes keeps this path just as atomic as the insert path.
            return;
          }

          if (head && head.sequence >= Number.MAX_SAFE_INTEGER) {
            fail(new JournalSequenceOverflowError(
              `Stream ${streamKey(safeInput.ownerId, safeInput.deviceId)} has reached the maximum safe sequence.`,
            ));
            return;
          }
          const sequence = head ? head.sequence + 1 : 0;
          const clientGeneration = head?.clientGeneration ?? crypto.randomUUID();
          const predecessorRequestId = head ? head.headRequestId : null;

          const command: SwitchCommandEnvelope = {
            encodingVersion: 1,
            requestId: safeInput.requestId,
            ownerId: safeInput.ownerId,
            deviceId: safeInput.deviceId,
            clientGeneration,
            sequence,
            predecessorRequestId,
            expectedRevision: safeInput.expectedRevision,
            shiftRef: safeInput.shiftRef,
            intent: safeInput.intent,
            tapAt: safeInput.tapAt,
            observedServerEvidence: safeInput.observedServerEvidence,
          };
          const row: CommandRow = { command, receipt: null };

          commands.add(row);
          heads.put({
            streamKey: streamKey(safeInput.ownerId, safeInput.deviceId),
            ownerId: safeInput.ownerId,
            deviceId: safeInput.deviceId,
            clientGeneration,
            sequence,
            headRequestId: safeInput.requestId,
          } satisfies HeadRow);

          result = cloneRecord(row);
        } catch (error) {
          fail(error);
        }
      };

      existingReq.onsuccess = () => { existingReady = true; proceed(); };
      headReq.onsuccess = () => { headReady = true; proceed(); };
      tailReq.onsuccess = () => { tailReady = true; proceed(); };

      tx.oncomplete = () => {
        if (result) resolve(result);
        else reject(storageError("append", new Error("Transaction completed without a result.")));
      };
      tx.onerror = () => fail(tx.error);
      tx.onabort = () => reject(storageError("append", tx.error ?? new Error("Append transaction aborted.")));
    });
  } finally {
    db.close();
  }
}

function receiptEqual(a: CommandReceiptInput, b: CommandReceiptInput): boolean {
  return a.status === b.status
    && a.serverRevision === b.serverRevision
    && a.resultRef === b.resultRef
    && a.reason === b.reason;
}

function validateReceiptInput(input: CommandReceiptInput): void {
  assertPlainJson(input);
  assertKeys(input,["status","serverRevision","resultRef","reason"]);
  if (input.reason !== undefined && (typeof input.reason !== "string" || input.reason.length > 1000))
    throw new JournalValidationError("Invalid receipt reason.");
  if (input.status !== "confirmed" && (input.serverRevision !== undefined || input.resultRef !== undefined))
    throw new JournalValidationError("Only confirmed receipts carry server results.");
  if (input.status !== "sent" && input.status !== "confirmed" && input.status !== "needsReview") {
    throw new JournalValidationError(`receipt.status must be "sent", "confirmed" or "needsReview", got ${JSON.stringify(input.status)}.`);
  }
  if (input.status === "confirmed") {
    if (!isSafeNonNegativeInt(input.serverRevision)) {
      throw new JournalValidationError("A confirmed receipt requires a safe nonnegative serverRevision.");
    }
    if (!isNonEmptyString(input.resultRef)) {
      throw new JournalValidationError("A confirmed receipt requires a nonempty resultRef.");
    }
  }
}

/**
 * Record what happened to a previously appended command. The immutable
 * envelope itself is never touched — only the receipt overlay. Repeating the
 * exact same receipt is a no-op that returns the stored record unchanged;
 * recording a different outcome for a command that already has a terminal
 * receipt (`confirmed` or `needsReview`) refuses.
 */
export async function recordReceipt(
  ownerId: string,
  deviceId: string,
  requestId: string,
  receiptInput: CommandReceiptInput,
  options?: { factory?: IDBFactory },
): Promise<JournalCommandRecord> {
  if (!isUuid(ownerId)) throw new JournalValidationError("ownerId must be a valid UUID.");
  if (!isUuid(deviceId)) throw new JournalValidationError("deviceId must be a valid UUID.");
  if (!isUuid(requestId)) throw new JournalValidationError("requestId must be a valid UUID.");
  validateReceiptInput(receiptInput);
  const safeReceiptInput: CommandReceiptInput = toPlainJsonClone(receiptInput);

  const factory = options?.factory ?? (typeof indexedDB !== "undefined" ? indexedDB : undefined as unknown as IDBFactory);
  const db = await openDb(factory);
  try {
    return await new Promise<JournalCommandRecord>((resolve, reject) => {
      const tx = db.transaction(COMMANDS_STORE, "readwrite");
      const commands = tx.objectStore(COMMANDS_STORE);
      const fail = (reason: unknown) => {
        reject(storageError("recordReceipt", reason));
        try { tx.abort(); } catch { /* already settling */ }
      };

      let result: JournalCommandRecord | undefined;
      const req = commands.get(requestId);
      req.onsuccess = () => {
        try {
          const row = req.result as CommandRow | undefined;
          if (!row || row.command.ownerId !== ownerId || row.command.deviceId !== deviceId) {
            fail(new JournalValidationError(`No command ${requestId} found for owner ${ownerId}/device ${deviceId}.`));
            return;
          }
          cloneRecord(row);
          const prior = row.receipt;
          if (prior && (prior.status === "confirmed" || prior.status === "needsReview")) {
            if (receiptEqual(prior, safeReceiptInput)) {
              result = cloneRecord(row);
              return;
            }
            fail(new JournalConflictError(
              `Command ${requestId} already has a terminal receipt (${prior.status}) that disagrees with this one.`,
            ));
            return;
          }
          if (prior && receiptEqual(prior, safeReceiptInput)) {
            result = cloneRecord(row);
            return;
          }
          const nextReceipt: CommandReceipt = { ...safeReceiptInput, recordedAt: new Date().toISOString() };
          const nextRow: CommandRow = { command: row.command, receipt: nextReceipt };
          commands.put(nextRow);
          result = cloneRecord(nextRow);
        } catch (error) {
          fail(error);
        }
      };

      tx.oncomplete = () => {
        if (result) resolve(result);
        else reject(storageError("recordReceipt", new Error("Transaction completed without a result.")));
      };
      tx.onerror = () => fail(tx.error);
      tx.onabort = () => reject(storageError("recordReceipt", tx.error ?? new Error("Receipt transaction aborted.")));
    });
  } finally {
    db.close();
  }
}

/** Owner/device-scoped point lookup by requestId. Returns an immutable clone, or null if absent. */
export async function getCommand(
  ownerId: string,
  deviceId: string,
  requestId: string,
  options?: { factory?: IDBFactory },
): Promise<JournalCommandRecord | null> {
  if (!isUuid(ownerId) || !isUuid(deviceId)) throw new JournalValidationError("Invalid stream owner/device.");
  if (!isUuid(requestId)) throw new JournalValidationError("requestId must be a valid UUID.");
  const factory = options?.factory ?? (typeof indexedDB !== "undefined" ? indexedDB : undefined as unknown as IDBFactory);
  const db = await openDb(factory);
  try {
    return await new Promise<JournalCommandRecord | null>((resolve, reject) => {
      const tx = db.transaction(COMMANDS_STORE, "readonly");
      const req = tx.objectStore(COMMANDS_STORE).get(requestId);
      req.onsuccess = () => {
        try {
          const row = req.result as CommandRow | undefined;
          resolve(row && row.command?.ownerId === ownerId && row.command?.deviceId === deviceId ? cloneRecord(row) : null);
        } catch(error) { reject(storageError("getCommand",error)); }
      };
      tx.onerror = () => reject(storageError("getCommand", tx.error));
      tx.onabort = () => reject(storageError("getCommand aborted", tx.error));
    });
  } finally {
    db.close();
  }
}

/** The current head of one (ownerId, deviceId) stream, or null if it has never appended. */
export async function getStreamHead(
  ownerId: string,
  deviceId: string,
  options?: { factory?: IDBFactory },
): Promise<StreamHead | null> {
  if (!isUuid(ownerId)) throw new JournalValidationError("ownerId must be a valid UUID.");
  if (!isUuid(deviceId)) throw new JournalValidationError("deviceId must be a valid UUID.");
  const factory = options?.factory ?? (typeof indexedDB !== "undefined" ? indexedDB : undefined as unknown as IDBFactory);
  const db = await openDb(factory);
  try {
    return await new Promise<StreamHead | null>((resolve, reject) => {
      const tx = db.transaction(HEADS_STORE, "readonly");
      const req = tx.objectStore(HEADS_STORE).get(streamKey(ownerId, deviceId));
      req.onsuccess = () => {
        try {
          const row = req.result as HeadRow | undefined;
          if (row) validateHead(row,ownerId,deviceId);
          resolve(row ? toPlainJsonClone({ ownerId: row.ownerId, deviceId: row.deviceId, clientGeneration: row.clientGeneration, sequence: row.sequence, headRequestId: row.headRequestId }) : null);
        } catch(error) { reject(storageError("getStreamHead",error)); }
      };
      tx.onerror = () => reject(storageError("getStreamHead", tx.error));
      tx.onabort = () => reject(storageError("getStreamHead aborted", tx.error));
    });
  } finally {
    db.close();
  }
}

/**
 * Every unconfirmed (`null` or `sent` receipt) command for one (ownerId, deviceId) stream, in
 * sequence order. Scoped by the compound stream index — this can never scan
 * or return another owner's or another device's rows.
 */
export async function listPending(
  ownerId: string,
  deviceId: string,
  options?: { factory?: IDBFactory },
): Promise<JournalCommandRecord[]> {
  if (!isUuid(ownerId)) throw new JournalValidationError("ownerId must be a valid UUID.");
  if (!isUuid(deviceId)) throw new JournalValidationError("deviceId must be a valid UUID.");
  const factory = options?.factory ?? (typeof indexedDB !== "undefined" ? indexedDB : undefined as unknown as IDBFactory);
  const db = await openDb(factory);
  try {
    return await new Promise<JournalCommandRecord[]>((resolve, reject) => {
      const tx = db.transaction(COMMANDS_STORE, "readonly");
      const index = tx.objectStore(COMMANDS_STORE).index(STREAM_INDEX);
      const range = IDBKeyRange.bound([ownerId, deviceId, 0], [ownerId, deviceId, Number.MAX_SAFE_INTEGER]);
      const out: JournalCommandRecord[] = [];
      const cursorReq = index.openCursor(range);
      cursorReq.onsuccess = () => {
        const cursor = cursorReq.result;
        if (!cursor) return;
        try {
          const row = cursor.value as CommandRow;
          const record = cloneRecord(row);
          if (record.command.ownerId !== ownerId || record.command.deviceId !== deviceId)
            throw new JournalValidationError("Saved command does not match its stream index.");
          if (record.receipt === null || record.receipt.status === "sent") out.push(record);
          cursor.continue();
        } catch(error) { reject(storageError("listPending",error)); try { tx.abort(); } catch { /* already settling */ } }
      };
      tx.oncomplete = () => resolve(out);
      tx.onerror = () => reject(storageError("listPending", tx.error));
      tx.onabort = () => reject(storageError("listPending aborted", tx.error));
    });
  } finally {
    db.close();
  }
}

/**
 * Whether a command is clear to send given causal ordering alone. A command
 * with no predecessor is always ready. A command whose predecessor has not
 * been durably confirmed by the server — including one marked `needsReview`
 * — blocks, and stays blocked: this check never treats a rejection as
 * permission to skip ahead.
 */
export async function checkReadiness(
  ownerId: string,
  deviceId: string,
  requestId: string,
  options?: { factory?: IDBFactory },
): Promise<ReadinessResult> {
  const record = await getCommand(ownerId, deviceId, requestId, options);
  if (!record) throw new JournalValidationError(`No command ${requestId} found.`);
  const predecessorId = record.command.predecessorRequestId;
  if (predecessorId === null) return { ready: true };
  const predecessor = await getCommand(ownerId, deviceId, predecessorId, options);
  if (predecessor && predecessor.command.sequence + 1 === record.command.sequence && predecessor.command.clientGeneration === record.command.clientGeneration && predecessor.receipt?.status === "confirmed") return { ready: true };
  return { ready: false, reason: "needsPredecessor", blockingRequestId: predecessorId };
}
