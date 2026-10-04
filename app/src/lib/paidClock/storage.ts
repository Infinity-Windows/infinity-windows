import { stillSignedInAs, subscribeSignedIn, type SignInMark } from "../signedIn";
import { cloneJson, uuid } from "../workConfiguration/model";
import { isCurrentClockSafetyBasis, type ConfirmedClockSafetyBasis } from "./api";
import { parseClockIntent, parseClockReceiptRead, type ClockIntent, type ClockReceipt } from "./protocol";

export const PAID_CLOCK_DB = "iw-paid-clock-chain-v1";
export const PAID_CLOCK_EVENT = "forge:paid-clock-chain";
export type ClockChainOrigin = { kind: "clock_command" | "shift"; id: string };
export interface PaidClockDelivery {
  status: "queued" | "sending" | "uncertain" | "acknowledged" | "attention";
  attemptToken: string | null;
  everAttempted: boolean;
  everUncertain: boolean;
  resolvedShiftId: string | null;
  receipt: ClockReceipt | null;
  attentionReason: string | null;
}
export interface PaidClockRecord {
  version: 1;
  clientId: string;
  ownerId: string;
  deviceId: string;
  storageGeneration: string;
  sequence: number;
  origin: ClockChainOrigin;
  predecessorClientId: string | null;
  intent: ClockIntent;
  delivery: PaidClockDelivery;
}
interface ChainHead { key: string; ownerId: string; deviceId: string; storageGeneration: string; sequence: number; lastClientId: string }
export class PaidClockStorageError extends Error {
  constructor() { super("The saved clock chain needs recovery. Keep this device and review the original request."); }
}
const fail = (): never => { throw new PaidClockStorageError(); };
const chainKey = (owner: string, origin: ClockChainOrigin) => `${owner}:${origin.kind}:${origin.id}`;
function assertOwner(login: SignInMark, owner: string) { if (!stillSignedInAs(login, owner)) fail(); }
function exact(value: Record<string, unknown>, keys: readonly string[]) {
  if (Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) fail();
}
function parseOrigin(raw: unknown): ClockChainOrigin {
  const o = cloneJson(raw) as Record<string, unknown>;
  exact(o, ["kind", "id"]);
  if (o.kind !== "shift" && o.kind !== "clock_command") fail();
  return { kind: o.kind as ClockChainOrigin["kind"], id: uuid(o.id) };
}
function parseRecord(raw: unknown): PaidClockRecord {
  try {
    const o = cloneJson(raw) as Record<string, unknown>;
    exact(o, ["version", "clientId", "ownerId", "deviceId", "storageGeneration", "sequence", "origin", "predecessorClientId", "intent", "delivery"]);
    const intent = parseClockIntent(o.intent), origin = parseOrigin(o.origin);
    if (o.version !== 1 || o.clientId !== intent.clientId || !Number.isSafeInteger(o.sequence) || (o.sequence as number) < 0) fail();
    if (intent.action === "clock_in" ? origin.kind !== "clock_command" || origin.id !== intent.clientId :
      origin.kind !== intent.shiftRef.kind || origin.id !== intent.shiftRef.id) fail();
    const d = o.delivery as Record<string, unknown>;
    exact(d, ["status", "attemptToken", "everAttempted", "everUncertain", "resolvedShiftId", "receipt", "attentionReason"]);
    if (!["queued", "sending", "uncertain", "acknowledged", "attention"].includes(d.status as string) ||
      typeof d.everAttempted !== "boolean" || typeof d.everUncertain !== "boolean" ||
      (d.attentionReason !== null && typeof d.attentionReason !== "string")) fail();
    const resolvedShiftId = d.resolvedShiftId === null ? null : uuid(d.resolvedShiftId);
    const receipt = d.receipt === null ? null : parseClockReceiptRead({ protocolVersion: 1, availability: "available", receipt: d.receipt }, intent, resolvedShiftId ?? undefined).receipt;
    if (d.status === "acknowledged" && !receipt) fail();
    if (d.status === "queued" && (d.everAttempted || d.everUncertain || d.attemptToken !== null || receipt || resolvedShiftId || d.attentionReason !== null) ||
      d.everUncertain && !d.everAttempted ||
      ["sending", "uncertain"].includes(d.status as string) && (!d.everAttempted || d.attemptToken === null) ||
      d.status === "uncertain" && !d.everUncertain ||
      d.status === "acknowledged" && (!d.everAttempted || d.attentionReason !== null || receipt?.outcome === "requires_review" || receipt?.sourcePresent === false) ||
      d.status === "attention" && !d.attentionReason) fail();
    if (receipt && resolvedShiftId !== receipt.shiftId || intent.action === "clock_in" && resolvedShiftId && !receipt ||
      intent.action !== "clock_in" && intent.shiftRef.kind === "shift" && resolvedShiftId && resolvedShiftId !== intent.shiftRef.id) fail();
    return { version: 1, clientId: uuid(o.clientId), ownerId: uuid(o.ownerId), deviceId: uuid(o.deviceId), storageGeneration: uuid(o.storageGeneration),
      sequence: o.sequence as number, origin, predecessorClientId: o.predecessorClientId === null ? null : uuid(o.predecessorClientId), intent,
      delivery: { status: d.status as PaidClockDelivery["status"], attemptToken: d.attemptToken === null ? null : uuid(d.attemptToken),
        everAttempted: d.everAttempted as boolean, everUncertain: d.everUncertain as boolean, resolvedShiftId, receipt, attentionReason: d.attentionReason as string | null } };
  } catch { return fail(); }
}
let opening: Promise<IDBDatabase> | null = null;
function openDb(): Promise<IDBDatabase> {
  if (opening) return opening;
  opening = new Promise<IDBDatabase>((resolve, reject) => {
    let failed = false;
    if (typeof indexedDB === "undefined") { reject(new PaidClockStorageError()); return; }
    const request = indexedDB.open(PAID_CLOCK_DB, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      const records = db.createObjectStore("requests", { keyPath: "clientId" });
      records.createIndex("by_owner", "ownerId");
      db.createObjectStore("heads", { keyPath: "key" });
    };
    const refuse = () => { failed = true; reject(new PaidClockStorageError()); };
    request.onerror = refuse;
    request.onblocked = refuse;
    request.onsuccess = () => {
      const db = request.result;
      if (failed) { db.close(); return; }
      db.onversionchange = () => { db.close(); opening = null; };
      resolve(db);
    };
  }).catch((error) => { opening = null; throw error; });
  return opening;
}
const result = <T>(request: IDBRequest<T>): Promise<T> => new Promise((resolve, reject) => {
  request.onsuccess = () => resolve(request.result); request.onerror = () => reject(new PaidClockStorageError());
});
async function transaction<T>(login: SignInMark, owner: string, mode: IDBTransactionMode, run: (tx: IDBTransaction) => Promise<T>): Promise<T> {
  assertOwner(login, owner);
  const db = await openDb(); assertOwner(login, owner);
  const tx = db.transaction(["requests", "heads"], mode);
  const done = new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve(); tx.onabort = tx.onerror = () => reject(new PaidClockStorageError());
  });
  void done.catch(() => {}); // abort can arrive before the request callback finishes
  const unsubscribe = subscribeSignedIn(() => { if (!stillSignedInAs(login, owner)) { try { tx.abort(); } catch { /* already committed */ } } });
  try {
    let value: T;
    try { value = await run(tx); assertOwner(login, owner); }
    catch (error) { try { tx.abort(); } catch { /* already committed */ } await done.catch(() => {}); throw error; }
    await done; assertOwner(login, owner); return value;
  }
  finally { unsubscribe(); }
}
function notify() { if (typeof window !== "undefined") window.dispatchEvent(new Event(PAID_CLOCK_EVENT)); }

/** Every append, duplicate check and causal-head comparison shares ONE native owner transaction. */
export async function appendPaidClockIntent(login: SignInMark, deviceId: string, raw: ClockIntent,
  expectedHeadClientId: string | null, safetyBasis?: ConfirmedClockSafetyBasis): Promise<PaidClockRecord> {
  const owner = uuid(login.userId), device = uuid(deviceId), intent = parseClockIntent(raw);
  const origin: ClockChainOrigin = intent.action === "clock_in" ? { kind: "clock_command", id: intent.clientId } : { ...intent.shiftRef };
  const generation = crypto.randomUUID();
  const saved = await transaction(login, owner, "readwrite", async (tx) => {
    const requests = tx.objectStore("requests"), heads = tx.objectStore("heads");
    const existing = await result(requests.get(intent.clientId)); assertOwner(login, owner);
    if (existing) {
      const row = parseRecord(existing);
      if (row.ownerId !== owner || row.deviceId !== device || JSON.stringify(row.intent) !== JSON.stringify(intent)) fail();
      return row; // same UUID cannot create another native request
    }
    const ownRows = (await result(requests.index("by_owner").getAll(owner))).map(parseRecord); assertOwner(login, owner);
    if (intent.action === "clock_in" && ownRows.some(row => row.intent.action === "clock_in" && row.delivery.status !== "acknowledged")) fail();
    const key = chainKey(owner, origin), head = await result(heads.get(key)) as ChainHead | undefined; assertOwner(login, owner);
    if ((head?.lastClientId ?? null) !== expectedHeadClientId || (head && head.deviceId !== device)) fail();
    if (head) {
      if (head.key !== key || head.ownerId !== owner || !Number.isSafeInteger(head.sequence) || head.sequence < 0) fail();
      uuid(head.storageGeneration); uuid(head.lastClientId);
      const predecessor = parseRecord(await result(requests.get(head.lastClientId))); assertOwner(login, owner);
      if (predecessor.ownerId !== owner || predecessor.deviceId !== device || predecessor.sequence !== head.sequence ||
        predecessor.storageGeneration !== head.storageGeneration || chainKey(owner, predecessor.origin) !== key) fail();
      if (predecessor.intent.action === "clock_out" || intent.action === "clock_in" ||
        intent.action === "break_start" && predecessor.intent.action === "break_start" ||
        intent.action === "break_end" && predecessor.intent.action !== "break_start") fail();
    }
    if (!head && origin.kind === "shift" && !isCurrentClockSafetyBasis(safetyBasis, owner, origin.id, login)) fail();
    if (!head && origin.kind === "clock_command" && intent.action !== "clock_in") fail();
    const sequence = head ? head.sequence + 1 : 0;
    if (!Number.isSafeInteger(sequence) || sequence < 0) fail();
    const row: PaidClockRecord = { version: 1, clientId: intent.clientId, ownerId: owner, deviceId: device,
      storageGeneration: head?.storageGeneration ?? generation, sequence, origin, predecessorClientId: head?.lastClientId ?? null, intent,
      delivery: { status: "queued", attemptToken: null, everAttempted: false, everUncertain: false, resolvedShiftId: null, receipt: null, attentionReason: null } };
    requests.add(row); heads.put({ key, ownerId: owner, deviceId: device, storageGeneration: row.storageGeneration, sequence, lastClientId: row.clientId });
    return row;
  });
  notify(); return parseRecord(saved);
}
export async function readPaidClockRecords(login: SignInMark): Promise<PaidClockRecord[]> {
  const owner = uuid(login.userId);
  return transaction(login, owner, "readonly", async (tx) => (await result(tx.objectStore("requests").index("by_owner").getAll(owner))).map(parseRecord));
}
export async function updatePaidClockDelivery(login: SignInMark, clientId: string, expectedAttemptToken: string | null,
  update: (row: PaidClockRecord) => PaidClockDelivery): Promise<PaidClockRecord> {
  const owner = uuid(login.userId); uuid(clientId);
  const row = await transaction(login, owner, "readwrite", async (tx) => {
    const store = tx.objectStore("requests"), raw = await result(store.get(clientId)); assertOwner(login, owner);
    if (!raw) fail();
    const old = parseRecord(raw);
    if (old.ownerId !== owner || old.delivery.attemptToken !== expectedAttemptToken) fail();
    const next = parseRecord({ ...old, delivery: update(parseRecord(old)) });
    if (next.intent.action !== "clock_in" && next.intent.shiftRef.kind === "clock_command" && next.delivery.resolvedShiftId) {
      const start = parseRecord(await result(store.get(next.intent.shiftRef.id))); assertOwner(login, owner);
      if (start.ownerId !== owner || start.intent.action !== "clock_in" || start.delivery.status !== "acknowledged" ||
        !start.delivery.receipt || start.delivery.receipt.shiftId !== next.delivery.resolvedShiftId) fail();
    }
    if (old.delivery.everAttempted && !next.delivery.everAttempted || old.delivery.everUncertain && !next.delivery.everUncertain ||
      old.delivery.receipt && JSON.stringify(old.delivery.receipt) !== JSON.stringify(next.delivery.receipt)) fail();
    if (old.delivery.status === "acknowledged" && next.delivery.status !== "acknowledged" ||
      old.delivery.everUncertain && !next.delivery.receipt && next.delivery.status !== "uncertain" && next.delivery.status !== "sending" ||
      next.delivery.status === "queued" && old.delivery.status !== "queued") fail();
    store.put(next); return next;
  });
  notify(); return row;
}
