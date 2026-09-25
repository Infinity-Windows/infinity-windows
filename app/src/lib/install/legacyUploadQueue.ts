// The upload queue unit photos and voice memos USED to sit in — read-only now.
//
// Until 2026-09-23 a finished install handed its media to this IndexedDB
// store (`wops-upload-queue`) and a flush loop that only ran while the opening
// sheet was mounted, inserted `attachments` rows with no client id, retried
// forever, and swallowed every error. None of it was counted by the sync pill
// or listed on /stuck, so a phone could say "All synced" over a photo that had
// been sitting here for a week. That is the "photos stuck at queued while the
// app says all synced" report from the crews, and it is why this file no longer
// enqueues anything.
//
// Media now rides lib/offline/outbox (stable client ids, a retry cap, a failed
// state a person can see and retry). What is left here is the bridge for the
// items already sitting in this store on phones in the field: read them,
// enqueue each one into the outbox under the SAME id it already has, and only
// then delete it here. A crash between the two writes leaves the item in both
// stores, and the next start puts it in the outbox again under the same id —
// which `store.put` replaces and the server dedupes — so it can never become
// two rows. Once the store is empty the database is deleted, and a phone that
// never had one is never given one.

import { makeEntry, type OutboxEntry } from "../offline/outbox-core";

export interface QueuedUploadMeta {
  id: string;
  bucket: "install-media" | "plansets";
  path: string;
  contentType: string;
  kind: "photo" | "voice_memo" | "video";
  installEventId: string | null;
  windowId: string | null;
  createdBy: string | null;
  createdAt: string;
  /** Additive geo/feed fields (persisted when the DB has the columns). */
  projectId?: string | null;
  lat?: number | null;
  lng?: number | null;
  accuracyM?: number | null;
  takenAt?: string | null;
}

const CURRENT_VERSION = 1;

/** Serialize metadata the way the old queue wrote it (tests and seeding). */
export function serializeUploadMeta(meta: QueuedUploadMeta): string {
  return JSON.stringify({ v: CURRENT_VERSION, ...meta });
}

export function deserializeUploadMeta(json: string): QueuedUploadMeta | null {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (
    typeof r.id !== "string" ||
    (r.bucket !== "install-media" && r.bucket !== "plansets") ||
    typeof r.path !== "string" ||
    typeof r.contentType !== "string" ||
    (r.kind !== "photo" && r.kind !== "voice_memo" && r.kind !== "video")
  ) {
    return null;
  }
  return {
    id: r.id,
    bucket: r.bucket,
    path: r.path,
    contentType: r.contentType,
    kind: r.kind,
    installEventId: typeof r.installEventId === "string" ? r.installEventId : null,
    windowId: typeof r.windowId === "string" ? r.windowId : null,
    createdBy: typeof r.createdBy === "string" ? r.createdBy : null,
    createdAt: typeof r.createdAt === "string" ? r.createdAt : new Date().toISOString(),
    projectId: typeof r.projectId === "string" ? r.projectId : null,
    lat: typeof r.lat === "number" ? r.lat : null,
    lng: typeof r.lng === "number" ? r.lng : null,
    accuracyM: typeof r.accuracyM === "number" ? r.accuracyM : null,
    takenAt: typeof r.takenAt === "string" ? r.takenAt : null,
  };
}

// --- the old store, read and emptied but never written ------------------

export const LEGACY_UPLOAD_DB = "wops-upload-queue";
const STORE = "uploads";

export interface LegacyUploadRecord {
  id: string;
  meta: string; // serialized QueuedUploadMeta
  blob: Blob;
}

/** Where the old items are read from and removed. Injectable for tests. */
export interface LegacyUploadSource {
  list(): Promise<LegacyUploadRecord[]>;
  remove(id: string): Promise<void>;
  /** Called once the store is empty; frees the database for good. */
  dispose(): Promise<void>;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(LEGACY_UPLOAD_DB, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) {
        req.result.createObjectStore(STORE, { keyPath: "id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function requestAsPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/**
 * Does the old database exist on this phone at all? Opening one that does
 * not would create it, and every phone that never had one would then carry
 * an empty database forever. `indexedDB.databases()` answers without creating
 * anything; a browser without it (old Firefox) is answered "maybe", and the
 * open below creates-then-deletes — a one-time cost, not a permanent one.
 */
async function legacyDbExists(): Promise<boolean> {
  if (typeof indexedDB === "undefined") return false;
  const list = (indexedDB as { databases?: () => Promise<Array<{ name?: string }>> }).databases;
  if (typeof list !== "function") return true;
  try {
    const dbs = await list.call(indexedDB);
    return dbs.some((d) => d.name === LEGACY_UPLOAD_DB);
  } catch {
    return true;
  }
}

export function indexedDbLegacySource(): LegacyUploadSource {
  return {
    async list() {
      if (!(await legacyDbExists())) return [];
      const db = await openDb();
      try {
        return (await requestAsPromise(
          db.transaction(STORE).objectStore(STORE).getAll(),
        )) as LegacyUploadRecord[];
      } finally {
        db.close();
      }
    },
    async remove(id) {
      const db = await openDb();
      try {
        const tx = db.transaction(STORE, "readwrite");
        tx.objectStore(STORE).delete(id);
        await new Promise<void>((resolve, reject) => {
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
          tx.onabort = () => reject(tx.error);
        });
      } finally {
        db.close();
      }
    },
    async dispose() {
      if (typeof indexedDB === "undefined") return;
      await new Promise<void>((resolve) => {
        const req = indexedDB.deleteDatabase(LEGACY_UPLOAD_DB);
        // Blocked (another tab holds it open) or failed both leave the empty
        // store where it is, to be tried again next start. Never a failure.
        req.onsuccess = () => resolve();
        req.onerror = () => resolve();
        req.onblocked = () => resolve();
      });
    },
  };
}

const defaultSource: LegacyUploadSource = indexedDbLegacySource();

/**
 * Items still sitting in the old store. Non-zero only on a phone that had
 * media queued before the update and has not run the migration yet — after
 * the first start it is zero and stays zero. Counted by the sync pill and the
 * update hold all the same, because "not migrated yet" is still "not sent".
 */
export async function pendingLegacyUploadCount(
  source: LegacyUploadSource = defaultSource,
): Promise<number> {
  return (await source.list()).length;
}

/** Where the migration writes: the outbox's own store, by id. */
export interface LegacyUploadTarget {
  put(entry: OutboxEntry, blob: Blob): Promise<void>;
}

/**
 * Pure: the outbox entry an old item becomes.
 *
 * The SAME id, so the move is idempotent, and the item's ORIGINAL time, so
 * /stuck says "queued 3 days ago" rather than pretending it arrived just now.
 * The payload is exactly what enqueueUpload (lib/offline/outbox.ts) writes for
 * a unit photo, plus `legacyUpload: true` — the upload handler reads that flag
 * and checks for a row already filed under this storage path before writing
 * one, because the old queue could insert the row and crash before removing
 * the item, and those are the items most likely to be sitting here.
 */
export function legacyUploadEntry(meta: QueuedUploadMeta, now: number): OutboxEntry {
  const createdAt = Date.parse(meta.createdAt);
  return makeEntry(
    {
      op: "photo_upload",
      hasBlob: true,
      payload: {
        bucket: meta.bucket,
        path: meta.path,
        contentType: meta.contentType,
        kind: meta.kind,
        windowId: meta.windowId,
        installEventId: meta.installEventId,
        createdBy: meta.createdBy,
        projectId: meta.projectId ?? null,
        packageId: null,
        lat: meta.lat ?? null,
        lng: meta.lng ?? null,
        accuracyM: meta.accuracyM ?? null,
        takenAt: meta.takenAt ?? null,
        caption: null,
        legacyUpload: true,
      },
    },
    meta.id,
    Number.isFinite(createdAt) && createdAt > 0 ? createdAt : now,
  );
}

export interface LegacyMigrationResult {
  /** Items now in the outbox and gone from the old store. */
  moved: number;
  /** Items that could not be read (corrupt metadata) and were dropped. */
  dropped: number;
  /** Items still in the old store because a write failed; tried next start. */
  left: number;
}

/**
 * Move every old item into the outbox. Safe to run on every start, and safe
 * to interrupt at any point:
 *
 *   - the outbox write is awaited BEFORE the old record is deleted, so there
 *     is no moment where the item exists in neither store;
 *   - the outbox id is the old item's own id, so a second pass over an item
 *     that was already moved (crash after the put, before the delete) puts
 *     the same entry again instead of a second one;
 *   - a write that fails leaves the item where it was, for the next start.
 *
 * One item at a time, oldest first, so a store of thirty photos does not open
 * thirty transactions at once on a phone that is already struggling.
 */
export async function migrateLegacyUploads(
  target: LegacyUploadTarget,
  source: LegacyUploadSource = defaultSource,
  now: number = Date.now(),
): Promise<LegacyMigrationResult> {
  const result: LegacyMigrationResult = { moved: 0, dropped: 0, left: 0 };
  const records = await source.list();
  if (records.length === 0) return result;

  const items = records
    .map((record) => ({ record, meta: deserializeUploadMeta(record.meta) }))
    .sort((a, b) => (a.meta?.createdAt ?? "").localeCompare(b.meta?.createdAt ?? ""));

  for (const { record, meta } of items) {
    if (!meta || !record.blob) {
      // Unreadable: nothing the outbox could send. Same call the old flush made.
      try {
        await source.remove(record.id);
        result.dropped += 1;
      } catch {
        result.left += 1;
      }
      continue;
    }
    try {
      await target.put(legacyUploadEntry(meta, now), record.blob);
    } catch {
      result.left += 1;
      continue;
    }
    // Only now — the outbox holds it durably.
    try {
      await source.remove(record.id);
    } catch {
      // Still in both stores; the next start puts the same id again.
    }
    result.moved += 1;
  }

  if (result.left === 0) {
    try {
      await source.dispose();
    } catch {
      // Best-effort; an empty store costs nothing but a future open.
    }
  }
  return result;
}
