// Persistent store for a job's loaded Studio (3D builder) model — the
// phone's own copy, for the dead zones a crew actually installs in (Studio
// 100x #29).
//
// The model lives on the job's plan outline row
// (project_plan_outlines.features.modelstudio) and JobModelViewer fetches it
// fresh every time it opens. That is fine with signal; with none, the fetch
// simply fails and the page would have nothing to show — a phone that "sees"
// a job on My Work but can't walk its model when it matters most, standing
// in a conex with no bars. So every model this phone successfully loads gets
// written here too, and a failed fetch falls back to whatever this phone
// last saw for that job.
//
// Same shape as the mark-drawing crops (lib/install/cropCache.ts): hand-rolled
// IndexedDB, no new dependency, and the same two rules everywhere in here:
//   • FAIL SOFT. A cache miss, a quota error, a browser in private mode, a
//     corrupt row — none of it may break the viewer. Every entry point
//     swallows its errors and behaves like an empty cache.
//   • BOUNDED. One entry per project, but a crew can rack up a lot of jobs
//     over a season, so writes prune the store back under a byte and entry
//     cap, dropping least-recently-used entries first — the same policy
//     cropCache uses (keysToEvict is reused here rather than forked).

import { keysToEvict } from "./cropCache";
import type { JobModel } from "../modelstudio/projects";

/** Total bytes we'll keep across every job's cached model. A few MB is a
 * handful of real buildings' worth of floors + windows. */
export const MAX_JOB_MODEL_BYTES = 12 * 1024 * 1024;
/** Hard entry cap — a crew doesn't carry hundreds of jobs on one phone. */
export const MAX_JOB_MODEL_ENTRIES = 60;

interface JobModelRecord extends JobModel {
  projectId: string;
  /** Rough byte size, used for the cap. */
  size: number;
  /** When this phone captured this copy from the network — surfaces in the
   * offline hint ("saved 2 hr ago"). Immutable per write. */
  cachedAt: number;
  /** LRU clock for eviction, bumped on every read and write — independent
   * of `cachedAt`, exactly like cropCache's `lastUsed`. */
  lastUsed: number;
}

/** What a read hands back: the model plus when THIS PHONE cached it. */
export type CachedJobModel = JobModel & { cachedAt: number };

/** Rough byte size of a model payload (plain JSON text, not base64 — a
 * plain length is a fine proxy). PURE. */
export function estimateJobModelSize(model: JobModel): number {
  const text = (model.serialized ?? "") + (model.floors ?? []).join("");
  return text.length;
}

export interface ResolvedJobModel {
  /** What the viewer should load, or null when there is nothing to show. */
  model: JobModel | null;
  /** True when `model` came from this phone's cache rather than a fresh
   * fetch — drives the "no signal" hint. */
  fromCache: boolean;
}

/**
 * Decide what the viewer shows, given a live fetch result and this phone's
 * cache. A fresh model always wins; the cached copy only stands in once the
 * fetch has actually FAILED — a slow-but-working connection must not flash
 * yesterday's model while today's is still in flight. PURE, so this
 * fallback decision is unit-tested without mocking IndexedDB (the same
 * convention cropCache.ts and outboxStore.ts already use: the hand-rolled
 * IndexedDB I/O below stays untested directly, and the DECISION it feeds is
 * pulled out here where it can be).
 */
export function resolveJobModel(args: {
  live: JobModel | null;
  fetchFailed: boolean;
  cached: JobModel | null;
}): ResolvedJobModel {
  if (args.live) return { model: args.live, fromCache: false };
  if (args.fetchFailed && args.cached) return { model: args.cached, fromCache: true };
  return { model: null, fromCache: false };
}

/** How long ago this phone cached its copy, for the offline hint — "just
 * now", "12 min ago", "3 hr ago", "2 days ago". PURE (same style as
 * Travel.tsx's syncedLabel). */
export function describeAge(cachedAtMs: number, nowMs: number = Date.now()): string {
  const mins = Math.round((nowMs - cachedAtMs) / 60000);
  if (mins <= 0) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs} hr ago`;
  const days = Math.round(hrs / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

// --- IndexedDB backend -----------------------------------------------------

const DB_NAME = "wops-job-models";
const STORE = "models";
const DB_VERSION = 1;

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) {
        req.result.createObjectStore(STORE, { keyPath: "projectId" });
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
 * Read a job's cached model, or null on a miss OR any failure. Bumps the
 * LRU clock so a job the crew keeps walking through is the last one
 * evicted; that touch is fire-and-forget because a hit must not wait on a
 * write.
 */
export async function readJobModel(projectId: string): Promise<CachedJobModel | null> {
  if (!available() || !projectId) return null;
  try {
    const db = await openDb();
    try {
      const row = (await asPromise(
        db.transaction(STORE).objectStore(STORE).get(projectId),
      )) as JobModelRecord | undefined;
      if (!row || (!row.serialized && !row.floors?.length)) return null;
      void touch(projectId);
      return {
        serialized: row.serialized,
        floors: row.floors,
        savedAt: row.savedAt ?? null,
        cachedAt: row.cachedAt,
      };
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

/** Bump an entry's LRU timestamp. Silent on failure — it's only a hint. */
async function touch(projectId: string): Promise<void> {
  if (!available()) return;
  try {
    const db = await openDb();
    try {
      const tx = db.transaction(STORE, "readwrite");
      const store = tx.objectStore(STORE);
      const row = (await asPromise(store.get(projectId))) as JobModelRecord | undefined;
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
 * Cache a freshly loaded model and prune the store back under its caps.
 * Resolves even when the write failed — the viewer already has the model in
 * hand, and a full or unavailable disk is not a reason to show an error.
 */
export async function writeJobModel(projectId: string, model: JobModel): Promise<void> {
  if (!available() || !projectId) return;
  if (!model.serialized && !model.floors?.length) return; // nothing to cache
  try {
    const now = Date.now();
    const db = await openDb();
    try {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put({
        projectId,
        serialized: model.serialized,
        floors: model.floors,
        savedAt: model.savedAt ?? null,
        size: estimateJobModelSize(model),
        cachedAt: now,
        lastUsed: now,
      } satisfies JobModelRecord);
      await txDone(tx);
    } finally {
      db.close();
    }
    await pruneJobModels();
  } catch {
    // Ignore — quota, private mode, a closed DB. The live model still shows.
  }
}

/** Enforce the byte/entry caps, dropping least-recently-used models first. */
export async function pruneJobModels(
  maxBytes = MAX_JOB_MODEL_BYTES,
  maxEntries = MAX_JOB_MODEL_ENTRIES,
): Promise<void> {
  if (!available()) return;
  try {
    const db = await openDb();
    try {
      const rows = (await asPromise(
        db.transaction(STORE).objectStore(STORE).getAll(),
      )) as JobModelRecord[];
      const drop = keysToEvict(
        rows.map((r) => ({
          key: r.projectId,
          size: r.size ?? estimateJobModelSize(r),
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
