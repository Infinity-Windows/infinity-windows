// Keep a job's planset PDFs on the phone.
//
// Everything the map and the spec cards draw comes out of a planset PDF —
// the building sheet for the flat map, the specs sheet for every mark's
// picture — and `downloadPlanset` fetched it from storage every time. The
// crops were cached (cropCache), so a spec card somebody had already opened
// survived a dead zone; the map never did, because it renders the page from
// the document, and the document was never kept.
//
// So the bytes go in IndexedDB, keyed by the planset row AND the storage
// path: a re-uploaded sheet is a new path, so an old copy can never be served
// for a new file. Same hand-rolled IndexedDB as cropCache and outboxStore, and
// the same two rules: FAIL SOFT (a miss, a quota error, private mode — none of
// it may break a download; the cache just looks empty) and BOUNDED (a handful
// of jobs' sheets, least-recently-used dropped first).

import { keysToEvict } from "../install/cropCache";

/** Total planset bytes kept. A sheet is 2–4 MB; a crew's week is well under this. */
export const MAX_PLANSET_BYTES = 64 * 1024 * 1024;
/** Hard entry cap, so a job with many small addenda cannot crowd the index. */
export const MAX_PLANSET_ENTRIES = 16;

export interface PlansetBlobRecord {
  key: string;
  bytes: ArrayBuffer;
  size: number;
  lastUsed: number;
  plansetId: string;
}

/** `plansetId:path` — both parts change what the bytes are. PURE. */
export function plansetBlobKey(plansetId: string, path: string): string {
  return `${plansetId}:${path}`;
}

/**
 * The store behind the cache, so the runner can be tested against a Map and
 * the real thing is IndexedDB. Every method may throw; the cache swallows it.
 */
export interface PlansetBlobStore {
  get(key: string): Promise<PlansetBlobRecord | undefined>;
  put(record: PlansetBlobRecord): Promise<void>;
  getAll(): Promise<PlansetBlobRecord[]>;
  delete(keys: string[]): Promise<void>;
}

const DB_NAME = "wops-planset-blobs";
const STORE = "blobs";
const DB_VERSION = 1;

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) {
        req.result.createObjectStore(STORE, { keyPath: "key" });
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

function indexedDbStore(): PlansetBlobStore {
  return {
    async get(key) {
      const db = await openDb();
      try {
        return (await asPromise(db.transaction(STORE).objectStore(STORE).get(key))) as
          | PlansetBlobRecord
          | undefined;
      } finally {
        db.close();
      }
    },
    async put(record) {
      const db = await openDb();
      try {
        const tx = db.transaction(STORE, "readwrite");
        tx.objectStore(STORE).put(record);
        await txDone(tx);
      } finally {
        db.close();
      }
    },
    async getAll() {
      const db = await openDb();
      try {
        return (await asPromise(db.transaction(STORE).objectStore(STORE).getAll())) as PlansetBlobRecord[];
      } finally {
        db.close();
      }
    },
    async delete(keys) {
      if (keys.length === 0) return;
      const db = await openDb();
      try {
        const tx = db.transaction(STORE, "readwrite");
        const store = tx.objectStore(STORE);
        for (const key of keys) store.delete(key);
        await txDone(tx);
      } finally {
        db.close();
      }
    },
  };
}

function available(): boolean {
  return typeof indexedDB !== "undefined";
}

let defaultStore: PlansetBlobStore | null = null;
function store(): PlansetBlobStore | null {
  if (!available()) return null;
  if (!defaultStore) defaultStore = indexedDbStore();
  return defaultStore;
}

/** Bytes for a planset, or null on a miss or any failure. Touches LRU. */
export async function readPlansetBytes(
  key: string,
  s: PlansetBlobStore | null = store(),
): Promise<ArrayBuffer | null> {
  if (!s) return null;
  try {
    const row = await s.get(key);
    if (!row?.bytes) return null;
    void s.put({ ...row, lastUsed: Date.now() }).catch(() => undefined);
    return row.bytes;
  } catch {
    return null;
  }
}

/**
 * Keep a planset's bytes and prune back under the caps. Resolves even when the
 * write failed — the caller already has the document; keeping it was a favour
 * to the next visit with no signal.
 */
export async function writePlansetBytes(
  key: string,
  plansetId: string,
  bytes: ArrayBuffer,
  s: PlansetBlobStore | null = store(),
  now: number = Date.now(),
): Promise<void> {
  if (!s || !bytes || bytes.byteLength === 0) return;
  try {
    await s.put({ key, bytes, size: bytes.byteLength, lastUsed: now, plansetId });
    const rows = await s.getAll();
    const drop = keysToEvict(
      rows.map((r) => ({ key: r.key, size: r.size ?? 0, lastUsed: r.lastUsed ?? 0 })),
      MAX_PLANSET_BYTES,
      MAX_PLANSET_ENTRIES,
    );
    await s.delete(drop);
  } catch {
    // Quota, private mode, a closed DB. The document still renders.
  }
}

/** True when the bytes are already on this phone. Never throws. */
export async function hasPlansetBytes(
  key: string,
  s: PlansetBlobStore | null = store(),
): Promise<boolean> {
  if (!s) return false;
  try {
    const row = await s.get(key);
    return Boolean(row?.bytes);
  } catch {
    return false;
  }
}

/** A Map-backed store for tests and for environments without IndexedDB. */
export function memoryPlansetBlobStore(): PlansetBlobStore {
  const m = new Map<string, PlansetBlobRecord>();
  return {
    async get(key) {
      return m.get(key);
    },
    async put(record) {
      m.set(record.key, record);
    },
    async getAll() {
      return [...m.values()];
    },
    async delete(keys) {
      for (const k of keys) m.delete(k);
    },
  };
}
