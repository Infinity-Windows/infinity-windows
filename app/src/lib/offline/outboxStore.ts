// Storage backends for the offline outbox. The IndexedDB store is used at
// runtime and survives refreshes/reboots; the in-memory store is a fast fake
// for unit tests. Both implement the same OutboxStore interface from the pure
// core, so the drainer never knows which one it is talking to.

import {
  deserializeEntry,
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
const DB_VERSION = 1;

interface Row {
  id: string;
  meta: string; // serialized OutboxEntry
  blob: Blob | null;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) {
        req.result.createObjectStore(STORE, { keyPath: "id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function asPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

/** IndexedDB-backed store. Durable across refreshes and reboots. */
export class IndexedDbOutboxStore implements OutboxStore {
  async getAll(): Promise<OutboxEntry[]> {
    const db = await openDb();
    try {
      const rows = (await asPromise(
        db.transaction(STORE).objectStore(STORE).getAll(),
      )) as Row[];
      const out: OutboxEntry[] = [];
      for (const row of rows) {
        const e = deserializeEntry(row.meta);
        if (e) out.push(e);
      }
      return out;
    } finally {
      db.close();
    }
  }

  async put(entry: OutboxEntry, blob?: Blob | null): Promise<void> {
    const db = await openDb();
    try {
      const tx = db.transaction(STORE, "readwrite");
      const store = tx.objectStore(STORE);
      // Preserve an existing blob when the caller only updates metadata.
      let keepBlob: Blob | null = blob ?? null;
      if (blob === undefined) {
        const existing = (await asPromise(store.get(entry.id))) as Row | undefined;
        keepBlob = existing?.blob ?? null;
      }
      store.put({
        id: entry.id,
        meta: serializeEntry(entry),
        blob: keepBlob,
      } satisfies Row);
      await txDone(tx);
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
      const tx = db.transaction(STORE, "readwrite");
      const store = tx.objectStore(STORE);
      const existing = (await asPromise(store.get(entry.id))) as Row | undefined;
      if (!existing) store.add({ id: entry.id, meta: serializeEntry(entry), blob } satisfies Row);
      await txDone(tx);
      return existing ? readExisting(entry.id, existing.meta) : null;
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
    } finally {
      db.close();
    }
  }

  async delete(id: string): Promise<void> {
    const db = await openDb();
    try {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).delete(id);
      await txDone(tx);
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
