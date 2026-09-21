import { transcribeDescription } from "../dictation";
import type { Lang } from "../i18n";
import { supabase } from "../supabase";
import { sendServiceCommand } from "./api";
import type { ServiceMedia } from "./model";
export interface PendingServiceMedia {
  id: string;
  userId: string;
  visitId: string;
  unitId: string | null;
  kind: ServiceMedia["kind"];
  filename: string;
  contentType: string;
  path: string;
  blob: Blob;
  error?: string;
  language?: Lang;
  metadataSaved?: boolean;
  transcript?: string;
  transcriptCommandId?: string;
}
const DB = "forge-service-evidence-v1",
  STORE = "uploads";
function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () =>
      req.result.createObjectStore(STORE, { keyPath: "id" });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function transaction<T>(
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const request = fn(tx.objectStore(STORE));
    tx.oncomplete = () => {
      db.close();
      resolve(request.result);
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
    tx.onabort = () => {
      db.close();
      reject(
        tx.error ?? new Error("Evidence could not be saved on this device."),
      );
    };
  });
}
export async function pendingServiceMedia(user: string) {
  return (
    (await transaction("readonly", (s) => s.getAll())) as PendingServiceMedia[]
  ).filter((x) => x.userId === user);
}
export async function enqueueServiceMedia(
  user: string,
  visit: string,
  unit: string | null,
  kind: ServiceMedia["kind"],
  file: Blob,
  filename: string,
  language?: Lang,
): Promise<string> {
  if (!file.size || file.size > 100 * 1024 * 1024)
    throw new Error("Choose a file under 100 MB.");
  const allowed = [
    "image/jpeg",
    "image/png",
    "image/webp",
    "image/heic",
    "image/heif",
    "audio/webm",
    "audio/mp4",
    "audio/ogg",
    "audio/mpeg",
    "audio/wav",
    "audio/x-wav",
    "video/mp4",
    "video/webm",
    "video/quicktime",
    "application/pdf",
  ];
  const contentType = file.type.split(";")[0];
  if (!allowed.includes(contentType))
    throw new Error(
      "Use a JPG, PNG, WebP, HEIC photo, PDF receipt, MP4/MOV/WebM video, or WebM/M4A/MP3/WAV/OGG audio file.",
    );
  const id = crypto.randomUUID();
  const extension =
    filename
      .split(".")
      .pop()
      ?.replace(/[^a-zA-Z0-9]/g, "")
      .slice(0, 10) || "media";
  await transaction("readwrite", (s) =>
    s.put({
      id,
      userId: user,
      visitId: visit,
      unitId: unit,
      kind,
      filename: filename.slice(0, 240),
      contentType: file.type.split(";")[0] || "application/octet-stream",
      path: `${user}/${visit}/${id}.${extension}`,
      blob: file,
      ...(kind === "voice" && language ? { language, transcriptCommandId: crypto.randomUUID() } : {}),
    } satisfies PendingServiceMedia),
  );
  return id;
}
export async function flushServiceMedia(user: string): Promise<void> {
  if (!navigator.onLine) return;
  await navigator.locks.request(DB + user, async () => {
    const { data } = await supabase.auth.getSession();
    if (data.session?.user.id !== user) return;
    for (const item of await pendingServiceMedia(user)) {
      if (item.error) continue; // A failed transcription waits for an explicit Retry.
      if (!item.metadataSaved) {
        const { error } = await supabase.storage
          .from("service-media")
          .upload(item.path, item.blob, {
            upsert: false,
            contentType: item.contentType,
          });
        // A retry may find its immutable upload already saved. Metadata commit is idempotent too.
        if (
          error &&
          !(
            (error as { statusCode?: string }).statusCode === "409" ||
            (error as { error?: string }).error === "Duplicate" ||
            /already exists/i.test(error.message)
          )
        )
          throw error;
        await sendServiceCommand({
          id: item.id,
          userId: user,
          action: "media",
          data: {
            id: item.id,
            visit_id: item.visitId,
            unit_id: item.unitId,
            kind: item.kind,
            storage_path: item.path,
            filename: item.filename,
            content_type: item.contentType,
            bytes: item.blob.size,
          },
        });
        item.metadataSaved = true;
        await transaction("readwrite", s => s.put(item));
      }
      if (item.kind === "voice" && item.language && item.unitId) {
        const { data: saved, error: readError } = await supabase.from("service_media").select("id,transcript,revision").eq("id", item.id).single();
        if (readError) throw readError;
        // A supervisor or a previous successful retry may already have saved
        // words. Do not replace them with another automatic pass.
        if (saved.transcript?.trim()) { await transaction("readwrite", s => s.delete(item.id)); continue; }
        if (!item.transcript) {
          try {
            item.transcript = await transcribeDescription(item.blob, item.language, new AbortController().signal);
            if (!item.transcript.trim()) throw new Error("empty_audio");
          } catch {
            item.error = item.language === "es"
              ? "El audio está guardado. La transcripción no terminó; toca Reintentar."
              : "Audio is saved. Transcription did not finish; tap Retry.";
            await transaction("readwrite", s => s.put(item));
            continue;
          }
          // Persist the text before its database write. Retry need not pay for
          // or wait on transcription again if the connection drops here.
          await transaction("readwrite", s => s.put(item));
        }
        await sendServiceCommand({
          id: item.transcriptCommandId!, userId: user, action: "transcript",
          data: { visit_id: item.visitId, id: item.id, revision: saved.revision, transcript: item.transcript },
        });
      }
      await transaction("readwrite", (s) => s.delete(item.id));
    }
  });
}

export async function retryServiceMedia(user: string) {
  for (const item of await pendingServiceMedia(user)) {
    if (item.error) { delete item.error; await transaction("readwrite", s => s.put(item)); }
  }
}

// Discard only the pending text conversion; the uploaded original stays on the visit.
export async function keepServiceAudioOnly(user: string, id: string) {
  await navigator.locks.request(DB + user, async () => {
    const item = (await pendingServiceMedia(user)).find(x => x.id === id);
    if (!item || !item.metadataSaved || !item.error || item.kind !== "voice")
      throw new Error("Wait until the audio has been saved first.");
    await transaction("readwrite", s => s.delete(id));
  });
}
