import { stillSignedInAs, subscribeSignedIn, type SignInMark } from "../signedIn";
import { cloneJson, uuid } from "../workConfiguration/model";
import { isCurrentClockSafetyBasis, type ConfirmedClockSafetyBasis } from "./api";
import { parseClockIntent, parseClockReceiptRead, type ClockIntent, type ClockReceipt } from "./protocol";
import { notifyPaidClockChanges } from "./notifications";
import { isCurrentLoginSafetyTarget, readObservedClockTarget, readObservedShiftBinding, subscribeObservedClockChanges,
  type CurrentLoginSafetyTarget } from "./current";

export const PAID_CLOCK_DB = "iw-paid-clock-chain-v1";
export { PAID_CLOCK_EVENT } from "./notifications";
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
const generationKey = (owner: string, origin: ClockChainOrigin, generation: string) => `${chainKey(owner, origin)}:generation:${generation}`;
const DEVICE_KEY = "metadata:paid-clock-device-v1";
function sameSafetyIntent(a: ClockIntent, b: ClockIntent): boolean {
  const business = (intent: ClockIntent) => Object.fromEntries(Object.entries(intent)
    .filter(([key]) => !["clientId", "tappedAt", "clockCheckedAt", "clockSkewMs"].includes(key)));
  return JSON.stringify(business(a)) === JSON.stringify(business(b));
}
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
async function transaction<T>(login: SignInMark, owner: string, mode: IDBTransactionMode, run: (tx: IDBTransaction) => Promise<T>,
  admission: () => boolean = () => true): Promise<T> {
  assertOwner(login, owner);
  const db = await openDb(); assertOwner(login, owner);
  const tx = db.transaction(["requests", "heads"], mode);
  const done = new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve(); tx.onabort = tx.onerror = () => reject(new PaidClockStorageError());
  });
  void done.catch(() => {}); // abort can arrive before the request callback finishes
  const abortInvalid = () => { if (!stillSignedInAs(login, owner) || !admission()) { try { tx.abort(); } catch { /* already committed */ } } };
  const unsubscribe = subscribeSignedIn(abortInvalid);
  const unsubscribeSource = subscribeObservedClockChanges(abortInvalid);
  try {
    let value: T;
    try { value = await run(tx); assertOwner(login, owner); if (!admission()) fail(); }
    catch (error) { try { tx.abort(); } catch { /* already committed */ } await done.catch(() => {}); throw error; }
    await done; assertOwner(login, owner); if (!admission()) fail(); return value;
  }
  finally { unsubscribe(); unsubscribeSource(); }
}
const notify = notifyPaidClockChanges;

/** Paid-clock identity is local metadata, not physical-device proof. It shares
 * the paid DB's durability/failure boundary, never the activity metadata DB. */
export async function getPaidClockDeviceId(login: SignInMark): Promise<string> {
  const owner = uuid(login.userId);
  return transaction(login, owner, "readwrite", async tx => {
    const store = tx.objectStore("heads"), raw = await result(store.get(DEVICE_KEY)); assertOwner(login, owner);
    if (raw !== undefined) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) fail();
      exact(raw, ["key", "version", "deviceId"]);
      if (raw.key !== DEVICE_KEY || raw.version !== 1) fail();
      return uuid(raw.deviceId);
    }
    const deviceId = crypto.randomUUID();
    store.add({ key: DEVICE_KEY, version: 1, deviceId });
    return deviceId;
  });
}

// Admission is current-login RAM, never a serialized credential or receipt.
// Only a NEW row whose native commit completed here can establish a lineage.
let observationSerial = 0;
declare const committedHeadBrand: unique symbol;
export type CurrentLoginCommittedHead = Readonly<{ clientId: string; action: ClockIntent["action"]; origin: Readonly<ClockChainOrigin> }> &
  { readonly [committedHeadBrand]: true };
let commitOrdinal = 0;
const committedLineages = new Map<string, { origin: string; row: PaidClockRecord; head: CurrentLoginCommittedHead; ordinal: number }>();
const lineageKey = (login: SignInMark, row: PaidClockRecord) => `${row.ownerId}:${login.generation}:${row.storageGeneration}`;
const lineageOrigin = (row: PaidClockRecord) => chainKey(row.ownerId, row.origin);
const hasLineage = (login: SignInMark, row: PaidClockRecord) => stillSignedInAs(login, row.ownerId) &&
  committedLineages.get(lineageKey(login, row))?.origin === lineageOrigin(row);
subscribeSignedIn(() => { committedLineages.clear(); observationSerial++; });
subscribeObservedClockChanges(() => { committedLineages.clear(); observationSerial++; });
/** Only this login's NEW committed head, never a history scan or dedup winner.
 * The returned object is opaque/frozen; source/auth invalidation removes it.
 * Flow may use it to choose an explicit causal predecessor, while native append
 * still validates actual head identity and current admission independently. */
export function getCurrentLoginCommittedHead(login: SignInMark, shiftId: string): CurrentLoginCommittedHead | null {
  if (!login.userId || !stillSignedInAs(login, login.userId)) return null;
  uuid(shiftId);
  const binding = readObservedShiftBinding(login);
  let newest: { head: CurrentLoginCommittedHead; ordinal: number } | null = null;
  for (const entry of committedLineages.values()) {
    const row = entry.row;
    if (row.ownerId !== login.userId || !hasLineage(login, row)) continue;
    const matches = row.origin.kind === "shift" ? row.origin.id === shiftId : binding?.kind === "open" &&
      binding.shiftId === shiftId && binding.clockInCommandId === row.origin.id;
    if (matches && (!newest || entry.ordinal > newest.ordinal)) newest = entry;
  }
  return newest?.head ?? null;
}
export function isCurrentLoginCommittedHead(value: unknown, login: SignInMark, shiftId: string): value is CurrentLoginCommittedHead {
  return value !== null && value !== undefined && value === getCurrentLoginCommittedHead(login, shiftId);
}

/** Every append, duplicate check and causal-head comparison shares ONE native
 * owner transaction. Fresh online safety bases retain their original meaning. */
export function appendPaidClockIntent(login: SignInMark, deviceId: string, raw: ClockIntent,
  expectedHeadClientId: string | null, safetyBasis?: ConfirmedClockSafetyBasis): Promise<PaidClockRecord> {
  return append(login, deviceId, raw, expectedHeadClientId, safetyBasis, false);
}
/** Pending-only authoring. A boolean, saved row or copied target cannot grant
 * admission: the native transaction validates the current opaque target or a
 * lineage minted here only after this login's actual new native commit. */
export function appendPendingPaidClockIntent(login: SignInMark, deviceId: string, raw: ClockIntent,
  expectedHeadClientId: string | null, target?: CurrentLoginSafetyTarget | null): Promise<PaidClockRecord> {
  return append(login, deviceId, raw, expectedHeadClientId, undefined, true, target);
}
async function append(login: SignInMark, deviceId: string, raw: ClockIntent,
  expectedHeadClientId: string | null, safetyBasis: ConfirmedClockSafetyBasis | undefined,
  pendingOnly: boolean, target?: CurrentLoginSafetyTarget | null): Promise<PaidClockRecord> {
  const owner = uuid(login.userId), defaultDevice = uuid(deviceId), intent = parseClockIntent(raw);
  if (expectedHeadClientId !== null) uuid(expectedHeadClientId);
  const origin: ClockChainOrigin = intent.action === "clock_in" ? { kind: "clock_command", id: intent.clientId } : { ...intent.shiftRef };
  const generation = crypto.randomUUID(), serial = observationSerial;
  let created = false, mintLineage = false;
  let admission = () => true;
  const saved = await transaction(login, owner, "readwrite", async (tx) => {
    const requests = tx.objectStore("requests"), heads = tx.objectStore("heads");
    const existing = await result(requests.get(intent.clientId)); assertOwner(login, owner);
    if (existing) {
      const row = parseRecord(existing);
      if (row.ownerId !== owner || JSON.stringify(row.intent) !== JSON.stringify(intent)) fail();
      // Draft originals retain their device identity across new metadata.
      return row;
    }
    // A duplicate is recovery of the original, never fresh lineage admission.
    if (pendingOnly && intent.action === "clock_in") fail();
    const ownRows = (await result(requests.index("by_owner").getAll(owner))).map(parseRecord); assertOwner(login, owner);
    if (ownRows.some(row => row.ownerId !== owner)) fail();
    if (intent.action === "clock_in" && ownRows.some(row => row.intent.action === "clock_in" && row.delivery.status !== "acknowledged")) fail();
    let key = chainKey(owner, origin), head: ChainHead | undefined;
    if (expectedHeadClientId !== null) {
      const previous = ownRows.find(row => row.clientId === expectedHeadClientId);
      if (!previous || chainKey(owner, previous.origin) !== key) return fail();
      const binding = readObservedShiftBinding(login);
      const boundShift = origin.kind === "shift" ? origin.id : binding?.kind === "open" &&
        binding.clockInCommandId === origin.id ? binding.shiftId : null;
      const observed = boundShift ? target ?? readObservedClockTarget(login, boundShift) : null;
      const currentAdmission = () => hasLineage(login, previous) || !!boundShift &&
        isCurrentLoginSafetyTarget(observed, owner, boundShift, login);
      if (pendingOnly) { admission = currentAdmission; if (!admission()) fail(); }
      mintLineage = currentAdmission();
      // Prefer this exact generation. Draft base-key heads continue in place.
      if (origin.kind === "shift") {
        const qualified = generationKey(owner, origin, previous.storageGeneration);
        const found = await result(heads.get(qualified)); assertOwner(login, owner);
        if (found !== undefined) { key = qualified; head = found as ChainHead; }
      }
      if (head === undefined) { head = await result(heads.get(key)) as ChainHead | undefined; assertOwner(login, owner); }
      if (!head || typeof head !== "object" || Array.isArray(head)) return fail();
      exact(head as unknown as Record<string, unknown>, ["key", "ownerId", "deviceId", "storageGeneration", "sequence", "lastClientId"]);
      if (head.key !== key || head.ownerId !== owner || head.lastClientId !== expectedHeadClientId ||
        head.deviceId !== previous.deviceId || head.sequence !== previous.sequence || head.storageGeneration !== previous.storageGeneration) fail();
      if (previous.intent.action === "clock_out" || intent.action === "clock_in" ||
        intent.action === "break_start" && previous.intent.action === "break_start" ||
        intent.action === "break_end" && previous.intent.action !== "break_start") fail();
    } else if (origin.kind === "shift") {
      admission = pendingOnly ? () => isCurrentLoginSafetyTarget(target, owner, origin.id, login) :
        () => isCurrentClockSafetyBasis(safetyBasis, owner, origin.id, login);
      if (!admission()) fail();
      mintLineage = true;
      // Competing tabs reuse the first immutable same-action safety original.
      // Different answers must not overwrite/duplicate an unresolved request.
      const pending = ownRows.filter(row => row.origin.kind === "shift" && row.origin.id === origin.id &&
        row.predecessorClientId === null && row.intent.action === intent.action &&
        ["queued", "sending", "uncertain"].includes(row.delivery.status));
      if (pending.length > 1) fail();
      if (pending.length === 1) {
        if (!sameSafetyIntent(pending[0].intent, intent)) fail();
        return pending[0];
      }
      key = generationKey(owner, origin, generation);
      if (await result(heads.get(key)) !== undefined) fail(); assertOwner(login, owner);
    } else {
      if (intent.action !== "clock_in" || await result(heads.get(key)) !== undefined) fail(); assertOwner(login, owner);
      mintLineage = true;
    }
    const sequence = head ? head.sequence + 1 : 0;
    if (!Number.isSafeInteger(sequence) || sequence < 0) fail();
    const device = head?.deviceId ?? defaultDevice;
    const row: PaidClockRecord = { version: 1, clientId: intent.clientId, ownerId: owner, deviceId: device,
      storageGeneration: head?.storageGeneration ?? generation, sequence, origin, predecessorClientId: head?.lastClientId ?? null, intent,
      delivery: { status: "queued", attemptToken: null, everAttempted: false, everUncertain: false, resolvedShiftId: null, receipt: null, attentionReason: null } };
    if (!admission()) fail();
    created = true;
    requests.add(row); heads.put({ key, ownerId: owner, deviceId: device, storageGeneration: row.storageGeneration, sequence, lastClientId: row.clientId });
    return row;
  }, () => admission());
  if (created && mintLineage && serial === observationSerial) {
    const head = Object.freeze({ clientId: saved.clientId, action: saved.intent.action, origin: Object.freeze({ ...saved.origin }) }) as CurrentLoginCommittedHead;
    committedLineages.set(lineageKey(login, saved), { origin: lineageOrigin(saved), row: saved, head, ordinal: ++commitOrdinal });
  }
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
