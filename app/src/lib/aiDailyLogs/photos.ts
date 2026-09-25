// Photos attached to a Forge AI daily log: taken or picked, stamped and shrunk
// by the same pipeline as every job photo, then kept on this phone until the
// log saves. Their status is read separately from the log's receipt.
import { canDecodePhoto, capturePhotoMeta, stampPhoto, toPhotoMetaFields } from "../photo/stampPhoto";
import { MAX_BLOB_BYTES } from "../offline/outbox";
import type { DraftPhoto } from "./draft";
import type { ServerPhotoStatus } from "./save";

export type PhotoRejection = "not_image" | "unreadable" | "too_large";
export type PreparedPhoto =
  | { ok: true; photo: Omit<DraftPhoto, "destination" | "queuedAt">; blob: Blob }
  | { ok: false; name: string; reason: PhotoRejection };

/**
 * One picked or taken file, made ready to keep. Nothing here uploads, and
 * nothing here decides a job: that is the draft's job, at the person's tap.
 */
export async function preparePhoto(
  file: File,
  deps: { label: string | null; newId?: () => string; decodes?: (b: Blob) => Promise<boolean> } = { label: null },
): Promise<PreparedPhoto> {
  // accept="image/*" is a hint; the library door also hands back PDFs.
  if (!file.type.startsWith("image/")) return { ok: false, name: file.name, reason: "not_image" };
  if (!(await (deps.decodes ?? canDecodePhoto)(file))) return { ok: false, name: file.name, reason: "unreadable" };
  const meta = await capturePhotoMeta(deps.label);
  const blob = await stampPhoto(file, meta);
  // stampPhoto hands back the original when it cannot re-encode; the upload
  // queue refuses anything over its cap, so say so now, not after Save.
  if (blob.size > MAX_BLOB_BYTES) return { ok: false, name: file.name, reason: "too_large" };
  const fields = toPhotoMetaFields(meta);
  return {
    ok: true,
    blob,
    photo: {
      id: (deps.newId ?? (() => crypto.randomUUID()))(),
      caption: null,
      takenAt: fields.takenAt ?? new Date().toISOString(),
      lat: fields.lat, lng: fields.lng, accuracyM: fields.accuracyM,
      bytes: blob.size,
    },
  };
}

/** Each photo's own state. A saved log says nothing about any of these. */
export type PhotoState =
  /** Kept only on this phone; goes when the log is saved. */
  | "on_phone"
  /** Handed to the upload queue and sending (or waiting for signal). */
  | "uploading"
  | "waiting_signal"
  /** The server has it, on this log's job, from this person. */
  | "saved"
  /** The queue gave up; Retry sends the same photo again. */
  | "failed"
  /** Handed over, no longer queued, and not confirmed by the server yet. */
  | "checking";

/** The upload queue's view of one photo (getPhotoUploadProgress for its id). */
export type QueueView = "pending" | "failed" | "uploaded" | "none";

export function photoState(
  photo: DraftPhoto,
  queue: QueueView,
  server: ServerPhotoStatus[] | null,
  online: boolean,
): PhotoState {
  if (server?.some((s) => s.photo_id === photo.id && s.arrived)) return "saved";
  if (!photo.queuedAt) return "on_phone";
  if (queue === "failed") return "failed";
  if (queue === "pending") return online ? "uploading" : "waiting_signal";
  // Sent this session: the queue saw the storage write and the row succeed.
  if (queue === "uploaded") return "saved";
  return "checking";
}
