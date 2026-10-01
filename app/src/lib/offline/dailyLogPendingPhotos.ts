// Photos taken for a daily log BEFORE that log has ever been saved (owner
// acceptance review, 2026-10-01): "Take one / Choose" must work the moment
// the Log Today form opens, not only after a first Save has minted a real
// daily_logs id. The server's tagged-photo path needs that id before it can
// build install-media/<project>/daily-logs/<log>/<uploader>/<file>.jpg — a
// photo cannot be inserted tagged to a log that does not exist yet, and
// Astra's attachments_daily_log_matches_job trigger refuses to let an
// ordinary caller claim an UNTAGGED photo onto a log after the fact (an
// untagged-then-retag path would be the forged-tag hole the trigger exists
// to close). So a pre-save photo is never sent to the network at all: its
// bytes sit HERE, in their own small IndexedDB database (same hand-rolled
// pattern as plansetBlobCache.ts), keyed by the stable id the caller mints
// at capture time — the SAME id that becomes attachments.client_id once the
// photo is actually uploaded, so a reconcile that runs twice (a reload
// mid-upload, a flaky connection) is always the same idempotent upload, never
// a duplicate. Once the log is confirmed saved, reconcileDailyLogPendingPhotos
// walks every pending record for that job-day and hands each one to
// enqueueUpload with the now-known daily_log_id — a genuine first-time INSERT,
// not a retroactive UPDATE, so Astra's identity-immutability guard never sees
// it. Durable across a close/reload by construction: nothing here lives only
// in React state.

export interface DailyLogPendingPhoto {
  /** Minted once, at capture time (crypto.randomUUID()) — becomes both the
   * storage filename and attachments.client_id once reconciled. Never
   * reassigned, including across a reload that resumes this same photo. */
  id: string;
  ownerId: string;
  projectId: string;
  logDate: string;
  blob: Blob;
  contentType: string;
  lat: number | null;
  lng: number | null;
  accuracyM: number | null;
  takenAt: string | null;
  createdBy: string | null;
  capturedAt: number;
}

export interface DailyLogPendingPhotoStore {
  add(record: DailyLogPendingPhoto): Promise<void>;
  listFor(ownerId: string, projectId: string, logDate: string): Promise<DailyLogPendingPhoto[]>;
  remove(ids: string[]): Promise<void>;
}

const DB_NAME = "wops-daily-log-pending-photos";
const STORE = "pending";
const DB_VERSION = 1;

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

function indexedDbStore(): DailyLogPendingPhotoStore {
  return {
    async add(record) {
      const db = await openDb();
      try {
        const tx = db.transaction(STORE, "readwrite");
        tx.objectStore(STORE).put(record);
        await txDone(tx);
      } finally {
        db.close();
      }
    },
    async listFor(ownerId, projectId, logDate) {
      const db = await openDb();
      try {
        const all = (await asPromise(
          db.transaction(STORE).objectStore(STORE).getAll(),
        )) as DailyLogPendingPhoto[];
        return all.filter(
          (r) => r.ownerId === ownerId && r.projectId === projectId && r.logDate === logDate,
        );
      } finally {
        db.close();
      }
    },
    async remove(ids) {
      if (ids.length === 0) return;
      const db = await openDb();
      try {
        const tx = db.transaction(STORE, "readwrite");
        const store = tx.objectStore(STORE);
        for (const id of ids) store.delete(id);
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

let defaultStore: DailyLogPendingPhotoStore | null = null;
function store(): DailyLogPendingPhotoStore | null {
  if (!available()) return null;
  if (!defaultStore) defaultStore = indexedDbStore();
  return defaultStore;
}

/** For tests, or any environment without IndexedDB — never thrown into. */
export function memoryDailyLogPendingPhotoStore(): DailyLogPendingPhotoStore {
  const m = new Map<string, DailyLogPendingPhoto>();
  return {
    async add(record) {
      m.set(record.id, record);
    },
    async listFor(ownerId, projectId, logDate) {
      return [...m.values()].filter(
        (r) => r.ownerId === ownerId && r.projectId === projectId && r.logDate === logDate,
      );
    },
    async remove(ids) {
      for (const id of ids) m.delete(id);
    },
  };
}

/** Hold one photo's bytes locally, before any daily log id exists for it.
 * Resolves even on a storage failure — the caller already has the blob in
 * memory for this render; the thumbnail still shows, it just will not
 * survive a reload. Never throws into the capture flow. */
export async function addDailyLogPendingPhoto(
  record: DailyLogPendingPhoto,
  s: DailyLogPendingPhotoStore | null = store(),
): Promise<void> {
  if (!s) throw new Error("Photo storage is unavailable on this device");
  await s.add(record);
}

/** Every pre-save photo still waiting for THIS owner's THIS job-day. Never
 * throws; a read failure reads as "none pending" rather than crashing the
 * form that is trying to show them. */
export async function listDailyLogPendingPhotos(
  ownerId: string,
  projectId: string,
  logDate: string,
  s: DailyLogPendingPhotoStore | null = store(),
): Promise<DailyLogPendingPhoto[]> {
  if (!s) return [];
  return s.listFor(ownerId, projectId, logDate);
}

export async function removeDailyLogPendingPhotos(
  ids: string[],
  s: DailyLogPendingPhotoStore | null = store(),
): Promise<void> {
  if (!s || ids.length === 0) return;
  try {
    await s.remove(ids);
  } catch {
    // Leaves a stale local record behind rather than throwing after the real
    // upload already queued — the next reconcile pass will see it is already
    // gone server-side (same client_id) and remove it again.
  }
}

/** Astra's DB contract (COORDINATION.md, 2026-10-01): the protected object
 * name inside install-media is
 * `<project>/daily-logs/<log>/<uploader-uid>/<client-id>.jpg` — bucket
 * excluded from the path field itself. The SAME client_id a pending photo was
 * minted with at capture time rides through unchanged, so a reconcile that
 * runs twice (a crash between upload and `remove`, a flaky connection) is the
 * same idempotent upsert both times, never a second attachment. */
export function dailyLogPhotoPath(
  projectId: string,
  dailyLogId: string,
  uploaderUid: string,
  clientId: string,
): string {
  return `${projectId}/daily-logs/${dailyLogId}/${uploaderUid}/${clientId}.jpg`;
}

/** The queue-write a reconciled pending photo turns into. Narrow on purpose —
 * exactly what enqueueUpload needs — so reconcileDailyLogPendingPhotos can be
 * tested against a spy instead of the real offline outbox. */
export type DailyLogPhotoUploader = (input: {
  clientId: string;
  ownerId: string;
  dailyLogId: string;
  projectId: string;
  path: string;
  contentType: string;
  createdBy: string | null;
  lat: number | null;
  lng: number | null;
  accuracyM: number | null;
  takenAt: string | null;
  blob: Blob;
}) => Promise<unknown>;

/**
 * Once a daily log is confirmed saved (a real id exists), hand every photo
 * still waiting locally for that exact owner/job/day to the real upload
 * queue, then drop it from the pending store — never before `upload`
 * resolves, so a photo stays locally recoverable until it is actually
 * durable in the network outbox. One photo's failure does not stop the rest:
 * each is reconciled independently and a thrown upload is left pending for
 * the next attempt (mount, next Save) rather than lost.
 */
export async function reconcileDailyLogPendingPhotos(
  args: { ownerId: string; projectId: string; logDate: string; dailyLogId: string; uploaderUid: string },
  upload: DailyLogPhotoUploader,
  s: DailyLogPendingPhotoStore | null = store(),
): Promise<{ reconciled: number; failed: number }> {
  if (!s) return {reconciled:0,failed:0};
  const pending = await s.listFor(args.ownerId,args.projectId,args.logDate);
  let reconciled = 0;
  let failed = 0;
  for (const photo of pending) {
    try {
      await upload({
        clientId: photo.id,
        ownerId: args.ownerId,
        dailyLogId: args.dailyLogId,
        projectId: args.projectId,
        path: dailyLogPhotoPath(args.projectId, args.dailyLogId, args.uploaderUid, photo.id),
        contentType: photo.contentType,
        createdBy: photo.createdBy,
        lat: photo.lat,
        lng: photo.lng,
        accuracyM: photo.accuracyM,
        takenAt: photo.takenAt,
        blob: photo.blob,
      });
      await removeDailyLogPendingPhotos([photo.id], s);
      reconciled += 1;
    } catch {
      // Stays pending — the next mount or the next successful Save tries it
      // again. The photo is never silently dropped.
      failed += 1;
    }
  }
  return { reconciled, failed };
}
