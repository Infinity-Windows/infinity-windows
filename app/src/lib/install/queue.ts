// Offline upload queue for on-site voice memos and photos. Job sites have
// dead spots, so captured media lands in IndexedDB first and syncs to
// Supabase Storage (+ an attachments row) whenever a flush succeeds.

import { supabase } from "../supabase";

export interface QueuedUploadMeta {
  id: string;
  bucket: "install-media" | "plansets";
  path: string;
  contentType: string;
  kind: "photo" | "voice_memo";
  installEventId: string | null;
  windowId: string | null;
  createdBy: string | null;
  createdAt: string;
}

const CURRENT_VERSION = 1;

/** Serialize metadata for storage (versioned so old queued items survive upgrades). */
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
    (r.kind !== "photo" && r.kind !== "voice_memo")
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
  };
}

// --- IndexedDB plumbing ---

const DB_NAME = "wops-upload-queue";
const STORE = "uploads";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
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

interface QueueRecord {
  id: string;
  meta: string; // serialized QueuedUploadMeta
  blob: Blob;
}

export async function enqueueUpload(
  meta: Omit<QueuedUploadMeta, "id" | "createdAt">,
  blob: Blob,
): Promise<QueuedUploadMeta> {
  const full: QueuedUploadMeta = {
    ...meta,
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
  };
  const db = await openDb();
  const tx = db.transaction(STORE, "readwrite");
  tx.objectStore(STORE).put({
    id: full.id,
    meta: serializeUploadMeta(full),
    blob,
  } satisfies QueueRecord);
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
  return full;
}

export async function pendingUploadCount(): Promise<number> {
  const db = await openDb();
  const count = await requestAsPromise(
    db.transaction(STORE).objectStore(STORE).count(),
  );
  db.close();
  return count;
}

async function removeRecord(id: string): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(STORE, "readwrite");
  tx.objectStore(STORE).delete(id);
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

let flushing = false;

/**
 * Try to push every queued item: upload the blob to storage, then write the
 * attachments row, then drop the queue record. Items that fail stay queued
 * for the next flush.
 */
export async function flushQueue(): Promise<{ sent: number; remaining: number }> {
  if (flushing) return { sent: 0, remaining: await pendingUploadCount() };
  flushing = true;
  let sent = 0;
  try {
    const db = await openDb();
    const records = await requestAsPromise(
      db.transaction(STORE).objectStore(STORE).getAll(),
    );
    db.close();

    for (const record of records as QueueRecord[]) {
      const meta = deserializeUploadMeta(record.meta);
      if (!meta) {
        await removeRecord(record.id);
        continue;
      }
      try {
        const { error: upErr } = await supabase.storage
          .from(meta.bucket)
          .upload(meta.path, record.blob, {
            contentType: meta.contentType,
            upsert: true,
          });
        if (upErr) throw upErr;

        const { error: rowErr } = await supabase.from("attachments").insert({
          window_id: meta.windowId,
          install_event_id: meta.installEventId,
          kind: meta.kind,
          storage_path: `${meta.bucket}/${meta.path}`,
          created_by: meta.createdBy,
        });
        if (rowErr) throw rowErr;

        await removeRecord(record.id);
        sent++;
      } catch {
        // Leave in queue; retried on next flush / reconnect.
      }
    }
  } finally {
    flushing = false;
  }
  return { sent, remaining: await pendingUploadCount() };
}

let autoFlushWired = false;

/** Wire up retry-on-reconnect once per session. */
export function initQueueAutoFlush(): void {
  if (autoFlushWired) return;
  autoFlushWired = true;
  window.addEventListener("online", () => {
    void flushQueue();
  });
  // Opportunistic flush on startup in case items were stranded last session.
  if (navigator.onLine) void flushQueue();
}
