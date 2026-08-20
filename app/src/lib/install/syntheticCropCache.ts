// Persistent store for synthetic elevation crops — a Studio model rendered
// into a picture of one mark's wall (Studio 100x #36,
// lib/modelstudio/elevationRender.ts's renderWallElevation).
//
// That render is genuinely expensive: mount a throwaway 3D engine instance,
// wait for every item on the floor to load, render one frame, tear it all
// down. A crew member re-opening the same mark's card a minute later should
// not pay for that twice, so a finished render goes in IndexedDB — the same
// hand-rolled approach lib/install/cropCache.ts and jobModelCache.ts already
// use, sharing their eviction policy (keysToEvict) rather than forking it.
//
// The key IS the invalidation strategy: `synthetic:{projectId}:{mark}:
// {modelSavedAt}`. A model re-save changes `savedAt`, so a stale render just
// stops matching any key a reader asks for and ages out under the cap like
// anything else — no explicit "drop this project's renders" path needed,
// unlike cropCache's dropCropsForPlanset (that one exists because a
// REPLACED planset keeps the same id; a re-saved Studio model doesn't keep
// the same savedAt).
//
// Same two rules as every cache in this pair:
//   • FAIL SOFT. A miss, a quota error, private mode, a corrupt row — none
//     of it may break the card. Every entry point swallows its errors and
//     behaves like an empty cache; the caller re-renders exactly as it
//     would on a cold cache.
//   • BOUNDED. Writes prune the store back under a byte and entry cap,
//     dropping least-recently-used entries first.

import { keysToEvict } from "./cropCache";

/** Total crop bytes we'll keep — a real PNG render, not a base64 blow-up,
 * so this covers noticeably more distinct marks than cropCache's 8MB of
 * base64 text does. */
export const MAX_SYNTHETIC_CROP_BYTES = 8 * 1024 * 1024;
export const MAX_SYNTHETIC_CROP_ENTRIES = 200;

interface SyntheticCropRecord {
  key: string;
  blob: Blob;
  size: number;
  lastUsed: number;
  projectId: string;
}

/**
 * The cache key for one mark's synthetic render. Mark is upper-cased so
 * "4a" and "4A" share one entry, same normalization cropCacheKey uses. The
 * model's own `savedAt` is the freshness token — see the file header for
 * why that alone is enough to invalidate a stale render. PURE.
 */
export function syntheticCropKey(
  projectId: string,
  markCode: string,
  modelSavedAt: string | null | undefined,
): string {
  return `synthetic:${projectId}:${markCode.trim().toUpperCase()}:${modelSavedAt ?? ""}`;
}

// --- IndexedDB backend -----------------------------------------------------

const DB_NAME = "wops-synthetic-crops";
const STORE = "crops";
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

function available(): boolean {
  return typeof indexedDB !== "undefined";
}

/**
 * Read a synthetic crop back, or null on a miss OR any failure. Touches
 * `lastUsed` so a mark the crew keeps looking at is the last one evicted;
 * fire-and-forget because a hit must not wait on a write.
 */
export async function readSyntheticCrop(key: string): Promise<Blob | null> {
  if (!available()) return null;
  try {
    const db = await openDb();
    try {
      const row = (await asPromise(
        db.transaction(STORE).objectStore(STORE).get(key),
      )) as SyntheticCropRecord | undefined;
      if (!row?.blob) return null;
      void touch(key);
      return row.blob;
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

/** Bump an entry's LRU timestamp. Silent on failure — it's only a hint. */
async function touch(key: string): Promise<void> {
  if (!available()) return;
  try {
    const db = await openDb();
    try {
      const tx = db.transaction(STORE, "readwrite");
      const store = tx.objectStore(STORE);
      const row = (await asPromise(store.get(key))) as SyntheticCropRecord | undefined;
      if (row) store.put({ ...row, lastUsed: Date.now() });
      await txDone(tx);
    } finally {
      db.close();
    }
  } catch {
    // Ignore.
  }
}

/**
 * Store a finished render and prune the store back under its caps. Resolves
 * even when the write failed — the caller already has the image in hand,
 * and a full or unavailable disk is not a reason to show an error.
 */
export async function writeSyntheticCrop(
  key: string,
  blob: Blob,
  projectId: string,
): Promise<void> {
  if (!available() || !blob) return;
  try {
    const now = Date.now();
    const db = await openDb();
    try {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put({
        key,
        blob,
        size: blob.size,
        lastUsed: now,
        projectId,
      } satisfies SyntheticCropRecord);
      await txDone(tx);
    } finally {
      db.close();
    }
    await pruneSyntheticCrops();
  } catch {
    // Ignore — quota, private mode, a closed DB. The render still shows.
  }
}

/** Enforce the byte/entry caps, dropping least-recently-used crops first. */
export async function pruneSyntheticCrops(
  maxBytes = MAX_SYNTHETIC_CROP_BYTES,
  maxEntries = MAX_SYNTHETIC_CROP_ENTRIES,
): Promise<void> {
  if (!available()) return;
  try {
    const db = await openDb();
    try {
      const rows = (await asPromise(
        db.transaction(STORE).objectStore(STORE).getAll(),
      )) as SyntheticCropRecord[];
      const drop = keysToEvict(
        rows.map((r) => ({ key: r.key, size: r.size ?? r.blob?.size ?? 0, lastUsed: r.lastUsed ?? 0 })),
        maxBytes,
        maxEntries,
      );
      if (drop.length === 0) return;
      const tx = db.transaction(STORE, "readwrite");
      const store = tx.objectStore(STORE);
      for (const key of drop) store.delete(key);
      await txDone(tx);
    } finally {
      db.close();
    }
  } catch {
    // Ignore.
  }
}
