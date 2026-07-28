// Persistent store for finished mark-elevation crops.
//
// A mark's drawing isn't stored as an image anywhere: the app downloads the
// specs planset (~2.2MB on the Smith job), renders the page, and slices one
// small picture out of it. That was cached in memory only, so every reload —
// and a phone reloads a PWA constantly — threw the crop away and re-downloaded
// the whole PDF to show one drawing. On site, on a bad connection, that's the
// difference between a picture and a spinner.
//
// So finished crops go in IndexedDB, keyed by everything that can change what
// the picture IS: the planset, the mark, the box, and the render scale. Same
// hand-rolled IndexedDB approach as `lib/offline/outboxStore` — no new
// dependency.
//
// Two rules everywhere in here:
//   • FAIL SOFT. A cache miss, a quota error, a browser in private mode, a
//     corrupt row — none of it may break a drawing, let alone a spec card. Every
//     entry point swallows its errors and behaves like an empty cache.
//   • BOUNDED. Crops are small but unbounded in number (24 marks × plansets ×
//     scales), so writes prune the store back under a byte and entry cap,
//     dropping least-recently-used entries first.

import type { Bbox } from "./markDrawing";

/** Total crop bytes we'll keep. ~8MB is a few jobs' worth of drawings. */
export const MAX_CROP_BYTES = 8 * 1024 * 1024;
/** Hard entry cap, so thousands of tiny crops can't bloat the index either. */
export const MAX_CROP_ENTRIES = 400;

/** One stored crop. `dataUrl` is a PNG data URL, as produced by the canvas. */
export interface CropRecord {
  key: string;
  dataUrl: string;
  /** Rough byte size, used for the cap. */
  size: number;
  /** Epoch ms of the last read or write — the LRU clock. */
  lastUsed: number;
  /** Specs planset this crop came from, so a replaced planset can be dropped. */
  plansetId: string;
}

/**
 * FNV-1a over the box's fixed-precision coordinates. Order-sensitive by
 * construction (`[a,b,c,d]` and `[c,d,a,b]` hash differently), which matters:
 * two marks on the same sheet can share coordinate VALUES in a different order,
 * and giving them one cache key would show one mark's drawing on the other's
 * card. Six decimals is far finer than a box is ever measured to, so equal
 * boxes always hash equal. PURE.
 */
export function hashBbox(bbox: Bbox): string {
  const text = bbox.map((n) => n.toFixed(6)).join("|");
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    // 16777619, in a form that stays inside 32-bit int math.
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36);
}

export interface CropKeyParts {
  plansetId: string;
  markCode: string;
  bbox: Bbox;
  /** Page render width the crop was sliced from — a different scale is a different image. */
  scale: number;
}

/**
 * Cache key for one crop: `planset:MARK:boxhash:scale`. Every part changes the
 * pixels, so every part is in the key; the mark is upper-cased so "4a" and "4A"
 * share one entry. PURE.
 */
export function cropCacheKey({
  plansetId,
  markCode,
  bbox,
  scale,
}: CropKeyParts): string {
  return [
    plansetId,
    markCode.trim().toUpperCase(),
    hashBbox(bbox),
    Math.round(scale),
  ].join(":");
}

/** Rough byte size of a data URL (base64 is ~4 chars per 3 bytes). */
export function estimateSize(dataUrl: string): number {
  return Math.ceil((dataUrl.length * 3) / 4);
}

/**
 * Which keys to drop so the store fits under both caps, least-recently-used
 * first. Ties break on key so the choice is deterministic (and testable) rather
 * than dependent on IndexedDB's iteration order. PURE.
 */
export function keysToEvict(
  entries: { key: string; size: number; lastUsed: number }[],
  maxBytes = MAX_CROP_BYTES,
  maxEntries = MAX_CROP_ENTRIES,
): string[] {
  const sorted = [...entries].sort(
    (a, b) => a.lastUsed - b.lastUsed || a.key.localeCompare(b.key),
  );
  let bytes = entries.reduce((sum, e) => sum + Math.max(0, e.size), 0);
  let count = entries.length;

  const drop: string[] = [];
  for (const entry of sorted) {
    if (bytes <= maxBytes && count <= maxEntries) break;
    drop.push(entry.key);
    bytes -= Math.max(0, entry.size);
    count -= 1;
  }
  return drop;
}

// --- IndexedDB backend ---------------------------------------------------

const DB_NAME = "wops-mark-crops";
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
 * Read a crop back, or null on a miss OR any failure. Touches `lastUsed` so the
 * drawings a crew keeps looking at are the last ones evicted; that touch is
 * fire-and-forget because a hit must not wait on a write.
 */
export async function readCrop(key: string): Promise<string | null> {
  if (!available()) return null;
  try {
    const db = await openDb();
    try {
      const row = (await asPromise(
        db.transaction(STORE).objectStore(STORE).get(key),
      )) as CropRecord | undefined;
      if (!row?.dataUrl) return null;
      void touch(key);
      return row.dataUrl;
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
      const row = (await asPromise(store.get(key))) as CropRecord | undefined;
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
 * Store a finished crop and prune the store back under its caps. Resolves even
 * when the write failed — the caller already has the image in hand, and a full
 * or unavailable disk is not a reason to show a spinner.
 */
export async function writeCrop(
  key: string,
  dataUrl: string,
  plansetId: string,
): Promise<void> {
  if (!available() || !dataUrl) return;
  try {
    const db = await openDb();
    try {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put({
        key,
        dataUrl,
        size: estimateSize(dataUrl),
        lastUsed: Date.now(),
        plansetId,
      } satisfies CropRecord);
      await txDone(tx);
    } finally {
      db.close();
    }
    await pruneCrops();
  } catch {
    // Ignore — quota, private mode, a closed DB. The drawing still shows.
  }
}

/** Enforce the byte/entry caps, dropping least-recently-used crops first. */
export async function pruneCrops(
  maxBytes = MAX_CROP_BYTES,
  maxEntries = MAX_CROP_ENTRIES,
): Promise<void> {
  if (!available()) return;
  try {
    const db = await openDb();
    try {
      const rows = (await asPromise(
        db.transaction(STORE).objectStore(STORE).getAll(),
      )) as CropRecord[];
      const drop = keysToEvict(
        rows.map((r) => ({
          key: r.key,
          size: r.size ?? estimateSize(r.dataUrl ?? ""),
          lastUsed: r.lastUsed ?? 0,
        })),
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

/**
 * Forget every crop from a planset. Called when a project's specs planset is
 * replaced: those pixels are provably from the old file, so keeping them around
 * risks showing the wrong drawing and wastes the cap either way.
 */
export async function dropCropsForPlanset(plansetId: string): Promise<void> {
  if (!available() || !plansetId) return;
  try {
    const db = await openDb();
    try {
      const rows = (await asPromise(
        db.transaction(STORE).objectStore(STORE).getAll(),
      )) as CropRecord[];
      const stale = rows.filter((r) => r.plansetId === plansetId);
      if (stale.length === 0) return;
      const tx = db.transaction(STORE, "readwrite");
      const store = tx.objectStore(STORE);
      for (const row of stale) store.delete(row.key);
      await txDone(tx);
    } finally {
      db.close();
    }
  } catch {
    // Ignore.
  }
}
