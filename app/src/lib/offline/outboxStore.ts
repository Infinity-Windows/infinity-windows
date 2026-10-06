// Storage backends for the offline outbox. The IndexedDB store is used at
// runtime and survives refreshes/reboots; the in-memory store is a fast fake
// for unit tests. Both implement the same OutboxStore interface from the pure
// core, so the drainer never knows which one it is talking to.

import {
  deserializeEntry,
  sameState,
  serializeEntry,
  type OutboxEntry,
  type OutboxStore,
} from "./outbox-core";
import { subscribeSignedIn } from "../signedIn";

/**
 * insertIfAbsent found a row under the id that cannot be read back. Not an
 * insertion (nothing was written) and not a match: the caller keeps its own
 * copy and reports it, rather than taking a null "no row" as queued.
 */
export class UnreadableOutboxEntryError extends Error {
  constructor(id: string) {
    super(`An upload already waiting on this phone under ${id} could not be read. This photo is still on this phone.`);
    this.name = "UnreadableOutboxEntryError";
  }
}
function readExisting(id: string, meta: string): OutboxEntry {
  const entry = deserializeEntry(meta);
  if (!entry) throw new UnreadableOutboxEntryError(id);
  return entry;
}

function matchingValuesReceipt(entry: OutboxEntry, response: unknown): boolean {
  if (!response || typeof response !== "object") return false;
  const receipt = (response as { receipt?: unknown }).receipt;
  if (!receipt || typeof receipt !== "object") return false;
  const r = receipt as Record<string, unknown>;
  return r.encodingVersion === "forge-values-submit/v1"
    && r.assignmentId === entry.payload.assignmentId
    && r.requestId === entry.payload.requestId
    && r.rubricVersion === entry.payload.rubricVersion
    && r.digest === entry.payload.digest;
}

/** In-memory store — deterministic, for tests and SSR/no-IndexedDB fallback. */
export class MemoryOutboxStore implements OutboxStore {
  private entries = new Map<string, string>(); // id -> serialized
  private blobs = new Map<string, Blob>();
  private valuesDrafts = new Map<string, ValuesDraftRow>();

  async getValuesDraft(ownerId: string, assignmentId: string): Promise<ValuesDraftRow | null> {
    return this.valuesDrafts.get(valuesDraftKey(ownerId, assignmentId)) ?? null;
  }

  async putValuesDraft(draft: ValuesDraftRow): Promise<void> {
    const prior = this.valuesDrafts.get(draft.id);
    if (prior && prior.requestId !== draft.requestId) throw new Error("Review draft changed on this phone");
    if (prior?.status === "queued" && (draft.status !== "queued" || draft.digest !== prior.digest || draft.comment !== prior.comment || JSON.stringify(draft.scores) !== JSON.stringify(prior.scores))) throw new Error("Review draft is locked");
    if (prior?.status === "accepted" || prior?.status === "conflict") throw new Error("Review draft is locked");
    this.valuesDrafts.set(draft.id, structuredClone(draft));
  }

  async acknowledgeValues(entry: OutboxEntry, receipt: unknown, context?: { signal?: AbortSignal; canCommit?: () => boolean }): Promise<boolean> {
    if (context?.signal?.aborted || (context?.canCommit && !context.canCommit())) return false;
    const ownerId = entry.ownerId;
    const assignmentId = entry.payload.assignmentId;
    if (!ownerId || typeof assignmentId !== "string") return false;
    const key = valuesDraftKey(ownerId, assignmentId);
    const draft = this.valuesDrafts.get(key);
    const current = this.entries.get(entry.id);
    if (!draft || draft.status !== "queued" || draft.requestId !== entry.id || draft.digest !== entry.payload.digest || !matchingValuesReceipt(entry, receipt) || !current || !sameState(deserializeEntry(current), entry)) return false;
    if (context?.signal?.aborted || (context?.canCommit && !context.canCommit())) return false;
    this.valuesDrafts.set(key, { ...draft, status: "accepted", receipt });
    this.entries.delete(entry.id);
    this.blobs.delete(entry.id);
    return true;
  }

  async getAll(): Promise<OutboxEntry[]> {
    const out: OutboxEntry[] = [];
    for (const json of this.entries.values()) {
      const e = deserializeEntry(json);
      if (e) out.push(e);
    }
    return out;
  }

  async put(entry: OutboxEntry, blob?: Blob | null): Promise<void> {
    this.entries.set(entry.id, serializeEntry(entry));
    if (blob != null) this.blobs.set(entry.id, blob);
  }

  async insertIfAbsent(entry: OutboxEntry, blob: Blob | null): Promise<OutboxEntry | null> {
    const existing = this.entries.get(entry.id);
    if (existing !== undefined) return readExisting(entry.id, existing);
    this.entries.set(entry.id, serializeEntry(entry));
    if (blob != null) this.blobs.set(entry.id, blob);
    return null;
  }

  async getBlob(id: string): Promise<Blob | null> {
    return this.blobs.get(id) ?? null;
  }

  async swap(id: string, expected: OutboxEntry | null, next: OutboxEntry | null): Promise<boolean> {
    const stored = this.entries.get(id);
    const current = stored === undefined ? null : deserializeEntry(stored);
    // An unreadable row matches nothing: it is not the entry anyone read.
    if (stored !== undefined && current === null) return false;
    if (!sameState(current, expected)) return false;
    if (next) {
      this.entries.set(id, serializeEntry(next));
    } else {
      this.entries.delete(id);
      this.blobs.delete(id);
    }
    return true;
  }

  async delete(id: string): Promise<void> {
    this.entries.delete(id);
    this.blobs.delete(id);
  }

  async count(): Promise<number> {
    return this.entries.size;
  }
}

// --- IndexedDB backend ---------------------------------------------------

const DB_NAME = "wops-write-outbox";
const STORE = "entries";
const META_STORE = "metadata";
// Keep the production v2 schema: retained older tabs still open it at v2.
// Review rows use a reserved metadata namespace, never a photo overlay id.
const LEGACY_VALUES_STORE = "values_drafts"; // unreleased local v3 fixtures only
const VALUES_META_PREFIX = "values-draft/v1/";
const DB_VERSION = 2;

export interface ValuesDraftRow {
  id: string;
  ownerId: string;
  assignmentId: string;
  requestId: string;
  rubricVersion: number;
  scores: Record<string, number>;
  comment: string;
  status: "editing" | "queued" | "accepted" | "conflict" | "denied" | "blocked";
  receipt?: unknown;
  digest?: string;
  updatedAt: number;
}

export function valuesDraftKey(ownerId: string, assignmentId: string): string {
  return `${ownerId}:${assignmentId}`;
}

function valuesMetaKey(ownerId: string, assignmentId: string): string {
  return `${VALUES_META_PREFIX}${encodeURIComponent(ownerId)}/${encodeURIComponent(assignmentId)}`;
}
function draftMeta(draft: ValuesDraftRow): MetaRow {
  if (draft.id !== valuesDraftKey(draft.ownerId, draft.assignmentId)) throw new Error("Review draft identity does not match");
  return { id: valuesMetaKey(draft.ownerId, draft.assignmentId), meta: JSON.stringify(draft) };
}
function readDraftMeta(row: MetaRow | undefined, ownerId: string, assignmentId: string): ValuesDraftRow | null {
  if (!row) return null;
  const draft = JSON.parse(row.meta) as ValuesDraftRow;
  if (row.id !== valuesMetaKey(ownerId, assignmentId) || !draft || draft.ownerId !== ownerId
    || draft.assignmentId !== assignmentId || draft.id !== valuesDraftKey(ownerId, assignmentId)) {
    throw new Error("Review draft identity does not match");
  }
  return draft;
}

interface Row {
  id: string;
  meta: string; // serialized OutboxEntry
  blob: Blob | null;
}

interface MetaRow {
  id: string;
  meta: string;
}

/** One property of a failure, or undefined if reading it throws: a diagnostic
 * must never replace the failure it is describing. */
function readProp(value: unknown, key: "name" | "message" | "error" | "target"): unknown {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) return undefined;
  try { return (value as Record<string, unknown>)[key]; } catch { return undefined; }
}

/** "Name: message" for an Error, a DOMException or an error-like object from
 * another realm (not only `instanceof Error`), the text of a primitive, or
 * null when there is nothing safe to say. Only name and message are read. */
function errorDetail(reason: unknown): string | null {
  if (reason === null || reason === undefined) return null;
  if (typeof reason !== "object" && typeof reason !== "function") return String(reason);
  const name = readProp(reason, "name");
  const message = readProp(reason, "message");
  if (typeof name === "string" && typeof message === "string" && (name || message)) return `${name}: ${message}`;
  if (typeof message === "string" && message) return message;
  if (typeof name === "string" && name) return name;
  return null;
}

function storageError(phase: string, reason: unknown): Error {
  if (reason instanceof UnreadableOutboxEntryError) return reason;
  const message = readProp(reason, "message");
  if (reason instanceof Error && typeof message === "string" && message.startsWith("Photo queue storage ")) return reason;
  const detail = errorDetail(reason) ?? "no browser error detail";
  const error = new Error(`Photo queue storage ${phase} failed (${detail})`, { cause: reason });
  const name = readProp(reason, "name");
  if (reason instanceof Error && typeof name === "string") error.name = name;
  return error;
}

function effectiveMeta(row: Row, overlay: MetaRow | undefined): string {
  return overlay ? overlay.meta : row.meta;
}

function connectDb(version?: number): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = version === undefined ? indexedDB.open(DB_NAME) : indexedDB.open(DB_NAME, version);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) {
        req.result.createObjectStore(STORE, { keyPath: "id" });
      }
      // Never migrate or rewrite the blob-bearing v1 rows. Existing iPhone
      // photos remain byte-for-byte in entries; only small state changes go
      // into this new store.
      if (!req.result.objectStoreNames.contains(META_STORE)) {
        req.result.createObjectStore(META_STORE, { keyPath: "id" });
      }
    };
    let blocked = false;
    req.onsuccess = () => {
      req.result.onversionchange = () => req.result.close();
      if (blocked) req.result.close();
      else resolve(req.result);
    };
    req.onerror = () => reject(storageError("open", req.error));
    req.onblocked = () => {
      blocked = true;
      reject(new Error("Photo queue upgrade is blocked by another open Forge tab."));
    };
  });
}

function openDb(): Promise<IDBDatabase> {
  return connectDb(DB_VERSION).catch((error: unknown) => {
    // v3 was never deployed. Keep any developer fixture/draft; never delete
    // or downgrade its database to hide a version error.
    if (error instanceof Error && error.name === "VersionError") return connectDb();
    throw error;
  });
}

function asPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB request failed without browser error detail"));
  });
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("IndexedDB transaction failed without browser error detail"));
    tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted without browser error detail"));
  });
}

/** Fixed labels for the requests put() watches. Never ids, keys or rows. */
type WatchedOperation = "entries.get" | "entries.put" | "metadata.delete" | "metadata.put";

/** Hand back the same request, with a passive error listener that remembers
 * which watched request failed first and what it said. */
type WatchRequest = <R extends IDBRequest>(request: R, operation: WatchedOperation) => R;

/** Schedule dependent writes from IDB success callbacks, while Safari's
 * transaction is certainly active. Resolve only after the whole transaction
 * commits, so a queued photo is never reported saved on a partial write.
 *
 * Diagnostics only (photo queue put failure, CI 37407023694): a request error
 * can reach this handler before the transaction has an error of its own.
 * CI's toast had no detail; the underlying native cause remains unknown. `watch`
 * latches the FIRST watched request's operation and error; it never cancels,
 * stops or aborts anything, so the browser's default abort and rollback, and
 * when this promise settles, are exactly as before. */
function writeTransaction<T>(
  db: IDBDatabase,
  phase: string,
  schedule: (tx: IDBTransaction, result: (value: T) => void, fail: (reason: unknown) => void, watch: WatchRequest) => void,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE, META_STORE], "readwrite");
    let value: T;
    let first: { operation: WatchedOperation; reason: unknown } | null = null;
    const watch: WatchRequest = (request, operation) => {
      try {
        request.addEventListener("error", () => {
          if (first) return;
          // An explicit record, even when the browser gave no error: the
          // first failure is never handed to a later request's cause.
          first = { operation, reason: readProp(request, "error") ?? null };
        });
      } catch { /* a diagnostic must never stop the write */ }
      return request;
    };
    /** The first watched request's own cause; else, with no detail there, the
     * transaction's (labelled as the transaction, not as that request); else
     * the first operation with no detail. Unwatched requests keep the old
     * transaction error, falling back to the failed request's own error. */
    const failure = (aborted: boolean, event?: Event): Error => {
      const label = aborted ? `${phase} aborted` : phase;
      try {
        const txReason = readProp(tx, "error") ?? null;
        if (first) {
          if (errorDetail(first.reason) !== null) return storageError(`${label} (${first.operation})`, first.reason);
          if (errorDetail(txReason) !== null) return storageError(`${phase} transaction${aborted ? " aborted" : ""}`, txReason);
          return storageError(`${label} (${first.operation})`, first.reason);
        }
        if (errorDetail(txReason) !== null) return storageError(label, txReason);
        const target = readProp(event, "target");
        const requestReason = target && target !== tx ? readProp(target, "error") ?? null : null;
        return storageError(label, errorDetail(requestReason) !== null ? requestReason : txReason);
      } catch {
        return new Error(`Photo queue storage ${label} failed (no browser error detail)`);
      }
    };
    const fail = (reason: unknown) => {
      reject(storageError(phase, reason));
      try { tx.abort(); } catch { /* already ended */ }
    };
    tx.oncomplete = () => resolve(value);
    tx.onerror = (event) => reject(failure(false, event));
    tx.onabort = () => reject(failure(true));
    try {
      schedule(tx, (next) => { value = next; }, fail, watch);
    } catch (error) {
      fail(error);
    }
  });
}

/** IndexedDB-backed store. Durable across refreshes and reboots. */
export class IndexedDbOutboxStore implements OutboxStore {
  async getValuesDraft(ownerId: string, assignmentId: string): Promise<ValuesDraftRow | null> {
    const db = await openDb();
    try {
      const hasLegacy = db.objectStoreNames.contains(LEGACY_VALUES_STORE);
      return await new Promise<ValuesDraftRow | null>((resolve, reject) => {
        const tx = db.transaction(hasLegacy ? [META_STORE, LEGACY_VALUES_STORE] : [META_STORE], hasLegacy ? "readwrite" : "readonly");
        const metadata = tx.objectStore(META_STORE);
        let found: ValuesDraftRow | null = null;
        const fail = (error: unknown) => { reject(storageError("review draft", error)); try { tx.abort(); } catch { /* ended */ } };
        const read = metadata.get(valuesMetaKey(ownerId, assignmentId));
        read.onsuccess = () => {
          try {
            found = readDraftMeta(read.result as MetaRow | undefined, ownerId, assignmentId);
            if (found || !hasLegacy) return;
            const legacy = tx.objectStore(LEGACY_VALUES_STORE).get(valuesDraftKey(ownerId, assignmentId));
            legacy.onsuccess = () => {
              try {
                const draft = legacy.result as ValuesDraftRow | undefined;
                if (!draft) return;
                found = readDraftMeta(draftMeta(draft), ownerId, assignmentId);
                metadata.put(draftMeta(draft));
                tx.objectStore(LEGACY_VALUES_STORE).delete(draft.id);
              } catch (error) { fail(error); }
            };
          } catch (error) { fail(error); }
        };
        tx.oncomplete = () => resolve(found);
        tx.onerror = () => reject(storageError("review draft", tx.error));
        tx.onabort = () => reject(storageError("review draft aborted", tx.error));
      });
    } finally { db.close(); }
  }

  async putValuesDraft(draft: ValuesDraftRow): Promise<void> {
    const db = await openDb();
    try {
      const tx = db.transaction(META_STORE, "readwrite");
      const drafts = tx.objectStore(META_STORE);
      const encoded = draftMeta(draft);
      const read = drafts.get(encoded.id);
      read.onsuccess = () => {
        let prior: ValuesDraftRow | null;
        try { prior = readDraftMeta(read.result as MetaRow | undefined, draft.ownerId, draft.assignmentId); }
        catch { tx.abort(); return; }
        if (prior && (prior.requestId !== draft.requestId || prior.status === "accepted" || prior.status === "conflict" || (prior.status === "queued" && (draft.status !== "queued" || draft.digest !== prior.digest || draft.comment !== prior.comment || JSON.stringify(draft.scores) !== JSON.stringify(prior.scores))))) {
          tx.abort();
          return;
        }
        drafts.put(encoded);
      };
      await txDone(tx);
    } finally { db.close(); }
  }

  async acknowledgeValues(entry: OutboxEntry, receipt: unknown, context?: { signal?: AbortSignal; canCommit?: () => boolean }): Promise<boolean> {
    const canCommit = () => !context?.signal?.aborted && (!context?.canCommit || context.canCommit());
    if (!canCommit()) return false;
    const ownerId = entry.ownerId;
    const assignmentId = entry.payload.assignmentId;
    if (!ownerId || typeof assignmentId !== "string" || !matchingValuesReceipt(entry, receipt)) return false;
    const db = await openDb();
    try {
      if (!canCommit()) return false;
      return await new Promise<boolean>((resolve, reject) => {
        const hasLegacy = db.objectStoreNames.contains(LEGACY_VALUES_STORE);
        const tx = db.transaction(hasLegacy ? [STORE, META_STORE, LEGACY_VALUES_STORE] : [STORE, META_STORE], "readwrite");
        const abort = () => { try { tx.abort(); } catch { /* transaction already settled */ } };
        context?.signal?.addEventListener("abort", abort, { once: true });
        const unsubscribe = context?.canCommit ? subscribeSignedIn(() => { if (!canCommit()) abort(); }) : () => undefined;
        const cleanup = () => { context?.signal?.removeEventListener("abort", abort); unsubscribe(); };
        const rows = tx.objectStore(STORE);
        const metadata = tx.objectStore(META_STORE);
        const drafts = metadata;
        const rowRead = rows.get(entry.id);
        const metaRead = metadata.get(entry.id);
        const draftRead = drafts.get(valuesMetaKey(ownerId, assignmentId));
        let draft: ValuesDraftRow | null = null;
        let ready = 0;
        let matched = false;
        const finish = () => {
          if (++ready !== 3) return;
          if (!canCommit()) { abort(); return; }
          const row = rowRead.result as Row | undefined;
          const overlay = metaRead.result as MetaRow | undefined;
          matched = Boolean(row && draft && draft.status === "queued" && draft.requestId === entry.id && draft.digest === entry.payload.digest && sameState(deserializeEntry(effectiveMeta(row, overlay)), entry));
          if (!matched || !draft) return;
          if (!canCommit()) { abort(); return; }
          drafts.put(draftMeta({ ...draft, status: "accepted", receipt, updatedAt: Date.now() } satisfies ValuesDraftRow));
          if (hasLegacy) tx.objectStore(LEGACY_VALUES_STORE).delete(valuesDraftKey(ownerId, assignmentId));
          rows.delete(entry.id);
          metadata.delete(entry.id);
        };
        rowRead.onsuccess = finish;
        metaRead.onsuccess = finish;
        draftRead.onsuccess = () => {
          try {
            draft = readDraftMeta(draftRead.result as MetaRow | undefined, ownerId, assignmentId);
            if (!draft && hasLegacy) {
              const legacy = tx.objectStore(LEGACY_VALUES_STORE).get(valuesDraftKey(ownerId, assignmentId));
              legacy.onsuccess = () => {
                try { draft = legacy.result ? readDraftMeta(draftMeta(legacy.result as ValuesDraftRow), ownerId, assignmentId) : null; finish(); }
                catch { abort(); }
              };
            } else finish();
          } catch { abort(); }
        };
        tx.oncomplete = () => { cleanup(); resolve(matched); };
        tx.onerror = () => { cleanup(); reject(storageError("values receipt", tx.error)); };
        tx.onabort = () => { cleanup(); resolve(false); };
      });
    } finally { db.close(); }
  }
  async getAll(): Promise<OutboxEntry[]> {
    const db = await openDb();
    try {
      const tx = db.transaction([STORE, META_STORE]);
      const rowsRequest = asPromise(tx.objectStore(STORE).getAll()) as Promise<Row[]>;
      const metasRequest = asPromise(tx.objectStore(META_STORE).getAll()) as Promise<MetaRow[]>;
      const [rows, metas] = await Promise.all([rowsRequest, metasRequest]);
      const overlays = new Map(metas.map((row) => [row.id, row]));
      const out: OutboxEntry[] = [];
      for (const row of rows) {
        const overlay = overlays.get(row.id);
        const e = deserializeEntry(effectiveMeta(row, overlay));
        if (overlay && !e) throw new UnreadableOutboxEntryError(row.id);
        if (e) out.push(e);
      }
      return out;
    } catch (error) {
      throw storageError("getAll", error);
    } finally {
      db.close();
    }
  }

  async put(entry: OutboxEntry, blob?: Blob | null): Promise<void> {
    const db = await openDb();
    try {
      await writeTransaction<void>(db, "put", (tx, _result, fail, watch) => {
        const store = tx.objectStore(STORE);
        const metadata = tx.objectStore(META_STORE);
        const read = watch(store.get(entry.id), "entries.get");
        read.onsuccess = () => {
          try {
            const existing = read.result as Row | undefined;
            // Null, like an omitted blob in the memory store, means no replacement.
            // Only a real replacement Blob may touch an existing photo row.
            // A synchronous throw from put/delete happens before watch() sees
            // a request, so it keeps going through fail() with no label.
            if (existing && blob == null) watch(metadata.put({ id: entry.id, meta: serializeEntry(entry) } satisfies MetaRow), "metadata.put");
            else {
              watch(store.put({ id: entry.id, meta: serializeEntry(entry), blob: blob ?? null } satisfies Row), "entries.put");
              watch(metadata.delete(entry.id), "metadata.delete");
            }
          } catch (error) { fail(error); }
        };
      });
    } catch (error) {
      throw storageError("put", error);
    } finally {
      db.close();
    }
  }

  /**
   * Insert, or hand back the entry already under this id. One readwrite
   * transaction: IndexedDB serialises it against every other tab and call, so
   * two hand-offs of the same id can never both write, and an entry that is
   * mid-upload is never replaced.
   */
  async insertIfAbsent(entry: OutboxEntry, blob: Blob | null): Promise<OutboxEntry | null> {
    const db = await openDb();
    try {
      return await writeTransaction<OutboxEntry | null>(db, "insertIfAbsent", (tx, result, fail) => {
        const store = tx.objectStore(STORE);
        const metadata = tx.objectStore(META_STORE);
        const rowRead = store.get(entry.id);
        const metaRead = metadata.get(entry.id);
        let rowReady = false;
        let metaReady = false;
        const finish = () => {
          if (!rowReady || !metaReady) return;
          try {
            const existing = rowRead.result as Row | undefined;
            const overlay = metaRead.result as MetaRow | undefined;
            if (!existing) {
              store.add({ id: entry.id, meta: serializeEntry(entry), blob } satisfies Row);
              metadata.delete(entry.id);
            }
            result(existing ? readExisting(entry.id, effectiveMeta(existing, overlay)) : null);
          } catch (error) { fail(error); }
        };
        rowRead.onsuccess = () => { rowReady = true; finish(); };
        metaRead.onsuccess = () => { metaReady = true; finish(); };
      });
    } catch (error) {
      throw storageError("insertIfAbsent", error);
    } finally {
      db.close();
    }
  }

  async getBlob(id: string): Promise<Blob | null> {
    const db = await openDb();
    try {
      const row = (await asPromise(
        db.transaction(STORE).objectStore(STORE).get(id),
      )) as Row | undefined;
      return row?.blob ?? null;
    } catch (error) {
      throw storageError("getBlob", error);
    } finally {
      db.close();
    }
  }

  /**
   * Compare and write in ONE readwrite transaction, like insertIfAbsent:
   * IndexedDB runs it against every other write to this store, so the read
   * that decides and the write it allows cannot be split by another write —
   * least of all by one that was queued behind a stalled open and runs late.
   */
  async swap(id: string, expected: OutboxEntry | null, next: OutboxEntry | null): Promise<boolean> {
    const db = await openDb();
    try {
      return await writeTransaction<boolean>(db, "swap", (tx, result, fail) => {
        const store = tx.objectStore(STORE);
        const metadata = tx.objectStore(META_STORE);
        const rowRead = store.get(id);
        const metaRead = metadata.get(id);
        let rowReady = false;
        let metaReady = false;
        const finish = () => {
          if (!rowReady || !metaReady) return;
          try {
            const row = rowRead.result as Row | undefined;
            const overlay = metaRead.result as MetaRow | undefined;
            const current = row ? deserializeEntry(effectiveMeta(row, overlay)) : null;
            const ok = !(row && current === null) && sameState(current, expected);
            if (ok) {
              if (next) {
                if (row) metadata.put({ id, meta: serializeEntry(next) } satisfies MetaRow);
                else {
                  store.add({ id, meta: serializeEntry(next), blob: null } satisfies Row);
                  metadata.delete(id);
                }
              } else {
                store.delete(id);
                metadata.delete(id);
              }
            }
            result(ok);
          } catch (error) { fail(error); }
        };
        rowRead.onsuccess = () => { rowReady = true; finish(); };
        metaRead.onsuccess = () => { metaReady = true; finish(); };
      });
    } catch (error) {
      throw storageError("swap", error);
    } finally {
      db.close();
    }
  }

  async delete(id: string): Promise<void> {
    const db = await openDb();
    try {
      const tx = db.transaction([STORE, META_STORE], "readwrite");
      tx.objectStore(STORE).delete(id);
      tx.objectStore(META_STORE).delete(id);
      await txDone(tx);
    } catch (error) {
      throw storageError("delete", error);
    } finally {
      db.close();
    }
  }

  async count(): Promise<number> {
    const db = await openDb();
    try {
      return (await asPromise(
        db.transaction(STORE).objectStore(STORE).count(),
      )) as number;
    } catch (error) {
      throw storageError("count", error);
    } finally {
      db.close();
    }
  }
}

/** Pick a store: IndexedDB when available, else the in-memory fallback. */
export function createDefaultStore(): OutboxStore {
  if (typeof indexedDB !== "undefined") return new IndexedDbOutboxStore();
  return new MemoryOutboxStore();
}
