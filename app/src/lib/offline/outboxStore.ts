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
