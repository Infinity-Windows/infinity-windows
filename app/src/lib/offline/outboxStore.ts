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

/** In-memory store — deterministic, for tests and SSR/no-IndexedDB fallback. */
export class MemoryOutboxStore implements OutboxStore {
  private entries = new Map<string, string>(); // id -> serialized
  private blobs = new Map<string, Blob>();

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
const DB_VERSION = 2;

interface Row {
  id: string;
  meta: string; // serialized OutboxEntry
  blob: Blob | null;
}

interface MetaRow {
  id: string;
  meta: string;
}

function storageError(phase: string, reason: unknown): Error {
  if (reason instanceof UnreadableOutboxEntryError) return reason;
  if (reason instanceof Error && reason.message.startsWith("Photo queue storage ")) return reason;
  const detail = reason instanceof Error ? `${reason.name}: ${reason.message}` : String(reason ?? "no browser error detail");
  const error = new Error(`Photo queue storage ${phase} failed (${detail})`, { cause: reason });
  if (reason instanceof Error) error.name = reason.name;
  return error;
}

function effectiveMeta(row: Row, overlay: MetaRow | undefined): string {
  return overlay ? overlay.meta : row.meta;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
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

/** Schedule dependent writes from IDB success callbacks, while Safari's
 * transaction is certainly active. Resolve only after the whole transaction
 * commits, so a queued photo is never reported saved on a partial write. */
function writeTransaction<T>(
  db: IDBDatabase,
  phase: string,
  schedule: (tx: IDBTransaction, result: (value: T) => void, fail: (reason: unknown) => void) => void,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE, META_STORE], "readwrite");
    let value: T;
    const fail = (reason: unknown) => {
      reject(storageError(phase, reason));
      try { tx.abort(); } catch { /* already ended */ }
    };
    tx.oncomplete = () => resolve(value);
    tx.onerror = () => reject(storageError(phase, tx.error));
    tx.onabort = () => reject(storageError(`${phase} aborted`, tx.error));
    try {
      schedule(tx, (next) => { value = next; }, fail);
    } catch (error) {
      fail(error);
    }
  });
}

/** IndexedDB-backed store. Durable across refreshes and reboots. */
export class IndexedDbOutboxStore implements OutboxStore {
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
      await writeTransaction<void>(db, "put", (tx, _result, fail) => {
        const store = tx.objectStore(STORE);
        const metadata = tx.objectStore(META_STORE);
        const read = store.get(entry.id);
        read.onsuccess = () => {
          try {
            const existing = read.result as Row | undefined;
            // Null, like an omitted blob in the memory store, means no replacement.
            // Only a real replacement Blob may touch an existing photo row.
            if (existing && blob == null) metadata.put({ id: entry.id, meta: serializeEntry(entry) } satisfies MetaRow);
            else {
              store.put({ id: entry.id, meta: serializeEntry(entry), blob: blob ?? null } satisfies Row);
              metadata.delete(entry.id);
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
