import { stillSignedInAs, subscribeSignedIn, type SignInMark } from "../signedIn";
import { cloneJson, uuid } from "../workConfiguration/model";
import { parseUnitReviewPayload, parseUnitReviewStoredReceipt, type ReviewPayload, type ReviewStoredReceipt } from "./protocol";

export const UNIT_REVIEW_DB = "iw-unit-review-decisions-v1";
export const REVIEW_LEASE_MS = 30_000;
export class UnitReviewStorageError extends Error {
  constructor() { super("Keep this device and check the original unit review before trying again."); this.name = "UnitReviewStorageError"; }
}
const fail = (): never => { throw new UnitReviewStorageError(); };
export interface ReviewOriginal { commandId: string; payload: ReviewPayload }
export interface ReviewDeliveryAttempt {
  token: string; purpose: "deliver" | "cancel"; startedAt: number; leaseUntil: number;
  outcome: "pending" | "held" | "unknown" | "refused" | "recorded" | "cancelled";
  sqlState: "23514" | "42501" | null;
}
export interface ReviewJournalRecord {
  version: 1; durability: "strict"; ownerId: string; unitId: string; commandId: string; sequence: number;
  predecessorId: string | null; revision: number; payload: ReviewPayload;
  attempts: ReviewDeliveryAttempt[]; receipt: ReviewStoredReceipt | null;
}
interface Head { key: string; ownerId: string; unitId: string; commandId: string; sequence: number }
export type ReviewSettlement = { kind: "held" | "unknown" } | { kind: "attempt_refused"; sqlState: "23514" | "42501" }
  | { kind: "applied" | "cancelled"; receipt: ReviewStoredReceipt };
const canonicalId = (value: unknown) => uuid(value).toLowerCase();
const key = (owner: string, unit: string) => `${owner}:${unit}`;
const exact = (raw: unknown, names: string[]): Record<string, unknown> => {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return fail();
  const r = raw as Record<string, unknown>;
  if (Object.keys(r).length !== names.length || names.some(name => !Object.hasOwn(r, name))) fail();
  return r;
};
const integer = (raw: unknown): number => typeof raw === "number" && Number.isSafeInteger(raw) && raw >= 0 ? raw : fail();
function freeze<T>(value: T): T {
  if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
/** Capture at the deliberate tap, before storage, reads, or token refresh. */
export function freezeReviewOriginal(commandId: string, raw: ReviewPayload): ReviewOriginal {
  const payload = parseUnitReviewPayload(raw), b = payload.basis;
  payload.basis = { ...b, unitId: canonicalId(b.unitId), factId: canonicalId(b.factId),
    submissionId: b.submissionId === null ? null : canonicalId(b.submissionId) };
  if (payload.action === "fail") payload.data.defects = payload.data.defects.map(d => ({ ...d, id: canonicalId(d.id) }));
  if (payload.action === "claim_resolved") payload.data.defectIds = payload.data.defectIds.map(canonicalId);
  // PostgreSQL UUID equality ignores case. Parse again after normalization so
  // differently spelled copies of the same defect cannot become two originals.
  return freeze({ commandId: canonicalId(commandId), payload: parseUnitReviewPayload(payload) });
}
/** Bind every field predictable from the frozen basis. A receipt proves a
 * historical event, never the unit's current accepted state. */
export function bindReviewReceipt(raw: unknown, original: ReviewOriginal): ReviewStoredReceipt {
  const r = parseUnitReviewStoredReceipt(raw, original.commandId, original.payload), b = original.payload.basis;
  if (r.outcome === "cancelled") return r;
  if (r.reviewRevision !== b.reviewRevision + 1) fail();
  const unchanged = r.generation === b.generation && r.submissionId === b.submissionId;
  switch (original.payload.action) {
    case "submit":
      if (r.generation !== (b.submissionId === null ? Math.max(b.generation, 1) : b.generation + 1) || r.submissionId !== r.eventId) fail();
      break;
    case "reopen": if (r.generation !== b.generation + 1 || r.submissionId !== null) fail(); break;
    case "claim_resolved":
      if (!unchanged && !(r.generation === b.generation + 1 && r.submissionId === r.eventId)) fail();
      break;
    default: if (!unchanged) fail();
  }
  return r;
}
export function parseReviewJournalRecord(raw: unknown): ReviewJournalRecord {
  try {
    const r = exact(cloneJson(raw), ["version", "durability", "ownerId", "unitId", "commandId", "sequence", "predecessorId", "revision", "payload", "attempts", "receipt"]);
    const original = freezeReviewOriginal(uuid(r.commandId), parseUnitReviewPayload(r.payload));
    if (r.version !== 1 || r.durability !== "strict" || r.ownerId !== canonicalId(r.ownerId) || uuid(r.unitId) !== original.payload.basis.unitId || !Array.isArray(r.attempts)) fail();
    const attempts = (r.attempts as unknown[]).map(rawAttempt => {
      const a = exact(rawAttempt, ["token", "purpose", "startedAt", "leaseUntil", "outcome", "sqlState"]);
      const startedAt = integer(a.startedAt), leaseUntil = integer(a.leaseUntil);
      if (!["deliver", "cancel"].includes(a.purpose as string) || leaseUntil !== startedAt + REVIEW_LEASE_MS || !["pending", "held", "unknown", "refused", "recorded", "cancelled"].includes(a.outcome as string)
        || (a.outcome === "refused" ? !["23514", "42501"].includes(a.sqlState as string) : a.sqlState !== null)) fail();
      return { token: uuid(a.token), purpose: a.purpose as ReviewDeliveryAttempt["purpose"], startedAt, leaseUntil, outcome: a.outcome as ReviewDeliveryAttempt["outcome"],
        sqlState: a.sqlState as ReviewDeliveryAttempt["sqlState"] };
    });
    if (new Set(attempts.map(a => a.token)).size !== attempts.length || attempts.some((a, i) => a.outcome === "pending" && i !== attempts.length - 1)) fail();
    const receipt = r.receipt === null ? null : bindReviewReceipt(r.receipt, original);
    if (attempts.some(a => a.outcome === "recorded") && receipt?.outcome !== "applied"
      || attempts.some(a => a.outcome === "cancelled") && receipt?.outcome !== "cancelled") fail();
    const sequence = integer(r.sequence), predecessorId = r.predecessorId === null ? null : uuid(r.predecessorId);
    if ((sequence === 0) !== (predecessorId === null) || predecessorId === original.commandId) fail();
    return { version: 1, durability: "strict", ownerId: uuid(r.ownerId), unitId: uuid(r.unitId), commandId: original.commandId,
      sequence, predecessorId, revision: integer(r.revision), payload: original.payload, attempts, receipt };
  } catch { return fail(); }
}
export function reviewDeliveryState(row: ReviewJournalRecord): "saved" | "unknown" | "refused" | "recorded" | "cancelled" {
  if (row.receipt) return row.receipt.outcome === "cancelled" ? "cancelled" : "recorded";
  if (row.attempts.some(a => a.outcome === "pending" || a.outcome === "unknown")) return "unknown";
  return row.attempts.filter(a => a.purpose === "deliver").at(-1)?.outcome === "refused" ? "refused" : "saved";
}
let opening: Promise<IDBDatabase> | null = null;
function openDb(): Promise<IDBDatabase> {
  if (opening) return opening;
  opening = new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === "undefined") { reject(new UnitReviewStorageError()); return; }
    const request = indexedDB.open(UNIT_REVIEW_DB, 1); let failed = false;
    request.onupgradeneeded = () => {
      const db = request.result;
      const store = db.createObjectStore("requests", { keyPath: "commandId" });
      store.createIndex("owner_unit", ["ownerId", "unitId"]);
      db.createObjectStore("heads", { keyPath: "key" });
    };
    request.onerror = request.onblocked = () => { failed = true; reject(new UnitReviewStorageError()); };
    request.onsuccess = () => {
      const db = request.result; if (failed) { db.close(); return; }
      db.onversionchange = () => { db.close(); opening = null; };
      resolve(db);
    };
  }).catch(error => { opening = null; throw error; });
  return opening;
}
const result = <T>(request: IDBRequest<T>): Promise<T> => new Promise((resolve, reject) => {
  request.onsuccess = () => resolve(request.result); request.onerror = () => reject(new UnitReviewStorageError());
});
export type ReviewAdmission = () => boolean;
async function transaction<T>(login: SignInMark, mode: IDBTransactionMode, admission: ReviewAdmission,
  run: (tx: IDBTransaction, owner: string, check: () => void) => Promise<T>): Promise<T> {
  const mark = { ...login }, owner = canonicalId(mark.userId);
  const check = () => { if (!stillSignedInAs(mark, mark.userId!) || !admission()) fail(); };
  check(); const db = await openDb(); check();
  const tx = db.transaction(["requests", "heads"], mode, mode === "readwrite" ? { durability: "strict" } : undefined);
  // Unsupported browsers may silently ignore the option. A completed relaxed
  // claim can vanish after dispatch; that would erase evidence of uncertainty.
  if (mode === "readwrite" && tx.durability !== "strict") { tx.abort(); return fail(); }
  const done = new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve(); tx.onerror = tx.onabort = () => reject(new UnitReviewStorageError());
  });
  void done.catch(() => {});
  const unsubscribe = subscribeSignedIn(() => { try { check(); } catch { try { tx.abort(); } catch { /* commit already finished */ } } });
  try {
    const value = await run(tx, owner, check); check(); await done; check(); return value;
  } catch (error) { try { tx.abort(); } catch { /* commit may already be durable */ } await done.catch(() => {}); throw error; }
  finally { unsubscribe(); }
}
async function rejectLegacyAliases(index: IDBIndex, owner: string, unitId: string): Promise<void> {
  // Earlier unmounted records may use noncanonical keys. Scan index keys only,
  // never another owner's fields; an alias is held, not converted or ignored.
  await new Promise<void>((resolve, reject) => {
    const request = index.openKeyCursor();
    request.onerror = () => reject(new UnitReviewStorageError());
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) { resolve(); return; }
      const parts = cursor.key;
      if (Array.isArray(parts) && typeof parts[0] === "string" && typeof parts[1] === "string"
        && parts[0].toLowerCase() === owner && parts[1].toLowerCase() === unitId
        && (parts[0] !== owner || parts[1] !== unitId)) { reject(new UnitReviewStorageError()); return; }
      cursor.continue();
    };
  });
}
async function readUnit(tx: IDBTransaction, owner: string, unitId: string, check: () => void) {
  await rejectLegacyAliases(tx.objectStore("requests").index("owner_unit"), owner, unitId); check();
  const rows = (await result(tx.objectStore("requests").index("owner_unit").getAll([owner, unitId]))).map(parseReviewJournalRecord); check();
  if (rows.some(row => row.ownerId !== owner || row.unitId !== unitId)) fail();
  rows.sort((a, b) => a.sequence - b.sequence);
  const rawHead = await result(tx.objectStore("heads").get(key(owner, unitId))); check();
  if (!rows.length) { if (rawHead !== undefined) fail(); return { rows, head: null }; }
  const h = exact(rawHead, ["key", "ownerId", "unitId", "commandId", "sequence"]), last = rows.at(-1)!;
  if (h.key !== key(owner, unitId) || h.ownerId !== owner || h.unitId !== unitId || h.commandId !== last.commandId || h.sequence !== last.sequence) fail();
  if (rows.some((row, i) => row.sequence !== i || row.predecessorId !== (i ? rows[i - 1].commandId : null)
    || i < rows.length - 1 && !["recorded", "refused", "cancelled"].includes(reviewDeliveryState(row)))) fail();
  return { rows, head: last };
}
/** Internal journal access, not a UI permission grant. Only the coordinator may
 * expose these fields after fresh current AND original scope authorization. */
export async function readReviewJournal(login: SignInMark, unitId: string, admission: ReviewAdmission): Promise<ReviewJournalRecord[]> {
  unitId = canonicalId(unitId);
  return transaction(login, "readonly", admission, async (tx, owner, check) => (await readUnit(tx, owner, unitId, check)).rows);
}
/** The head and original commit together. Uncertain predecessors cannot be
 * replaced; even a settled predecessor needs the caller's exact observed head. */
export async function reserveReviewOriginal(login: SignInMark, raw: ReviewOriginal, expectedHeadId: string | null,
  admission: ReviewAdmission): Promise<{ record: ReviewJournalRecord; created: boolean }> {
  const original = freezeReviewOriginal(raw.commandId, raw.payload);
  if (expectedHeadId !== null) expectedHeadId = canonicalId(expectedHeadId);
  return transaction(login, "readwrite", admission, async (tx, owner, check) => {
    const { rows, head } = await readUnit(tx, owner, original.payload.basis.unitId, check);
    const existing = rows.find(row => row.commandId === original.commandId);
    if (existing) {
      if (JSON.stringify(existing.payload) !== JSON.stringify(original.payload)) fail();
      return { record: existing, created: false };
    }
    if ((head?.commandId ?? null) !== expectedHeadId || head && !["recorded", "refused", "cancelled"].includes(reviewDeliveryState(head))) fail();
    const row = parseReviewJournalRecord({ version: 1, durability: "strict", ownerId: owner, unitId: original.payload.basis.unitId,
      commandId: original.commandId, sequence: head ? head.sequence + 1 : 0, predecessorId: head?.commandId ?? null,
      revision: 0, payload: original.payload, attempts: [], receipt: null });
    tx.objectStore("requests").add(row);
    const next: Head = { key: key(owner, row.unitId), ownerId: owner, unitId: row.unitId, commandId: row.commandId, sequence: row.sequence };
    tx.objectStore("heads").put(next); check();
    return { record: row, created: true };
  });
}
async function mutate(login: SignInMark, unitId: string, commandId: string, revision: number, admission: ReviewAdmission,
  update: (row: ReviewJournalRecord, isHead: boolean) => ReviewJournalRecord): Promise<ReviewJournalRecord> {
  unitId = canonicalId(unitId); commandId = canonicalId(commandId); integer(revision);
  return transaction(login, "readwrite", admission, async (tx, owner, check) => {
    const { rows, head } = await readUnit(tx, owner, unitId, check), row = rows.find(r => r.commandId === commandId);
    if (!row || row.revision !== revision) return fail();
    const next = parseReviewJournalRecord({ ...update(row, head?.commandId === commandId), revision: revision + 1 });
    tx.objectStore("requests").put(next); check(); return next;
  });
}
/** Acquiring an expired lease marks the previous unresolved attempt unknown.
 * Expiry is permission to coordinate an EXPLICIT retry, not proof of failure. */
export async function claimReviewAttempt(login: SignInMark, unitId: string, commandId: string, revision: number,
  token: string, now: number, admission: ReviewAdmission, purpose: ReviewDeliveryAttempt["purpose"] = "deliver"): Promise<ReviewJournalRecord> {
  token = canonicalId(token); integer(now);
  return mutate(login, unitId, commandId, revision, admission, (row, isHead) => {
    const previous = row.attempts.at(-1);
    if (!isHead || row.receipt || row.attempts.some(a => a.token === token) || previous?.outcome === "pending" && now < previous.leaseUntil) fail();
    const attempts = row.attempts.map(a => a.outcome === "pending" ? { ...a, outcome: "unknown" as const } : a);
    return { ...row, attempts: [...attempts, { token, purpose, startedAt: now, leaseUntil: now + REVIEW_LEASE_MS, outcome: "pending", sqlState: null }] };
  });
}
export async function settleReviewAttempt(login: SignInMark, unitId: string, commandId: string, revision: number,
  token: string, settlement: ReviewSettlement, admission: ReviewAdmission): Promise<ReviewJournalRecord> {
  token = canonicalId(token);
  return mutate(login, unitId, commandId, revision, admission, row => {
    const last = row.attempts.at(-1);
    if (row.receipt || !last || last.token !== token || last.outcome !== "pending") return fail();
    const receipt = (settlement.kind === "applied" || settlement.kind === "cancelled") ? bindReviewReceipt(settlement.receipt, row) : null;
    const attempt: ReviewDeliveryAttempt = { ...last, outcome: settlement.kind === "applied" ? "recorded" :
      settlement.kind === "attempt_refused" ? "refused" : settlement.kind,
      sqlState: settlement.kind === "attempt_refused" ? settlement.sqlState : null };
    return { ...row, attempts: [...row.attempts.slice(0, -1), attempt], receipt };
  });
}
/** Receipt-only repair never submits the saved request and never removes its
 * attempt history. CAS prevents a late repair from overwriting another tab. */
export async function recordReviewReceipt(login: SignInMark, unitId: string, commandId: string, revision: number,
  receipt: ReviewStoredReceipt, admission: ReviewAdmission): Promise<ReviewJournalRecord> {
  return mutate(login, unitId, commandId, revision, admission, row => {
    const bound = bindReviewReceipt(receipt, row);
    if (row.receipt && JSON.stringify(bound) !== JSON.stringify(row.receipt)) fail();
    return { ...row, receipt: bound };
  });
}
