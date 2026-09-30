import { isRetryableError, retryEntry, uploadKind, type OutboxEntry } from "./outbox-core";

const REPAIR = "photoConflictIndexRepaired20260918";
const INDEX_ERROR = "there is no unique or exclusion constraint matching the on conflict specification";
export function isPhotoConflictIndexError(message: string | null): boolean {
  return (message?.toLowerCase().replaceAll('"', "") ?? "").includes(INDEX_ERROR);
}

/** Revive only the signed-in photographer's uploads stranded by the repaired
 * database index. Keep the same id, path and original blob: retries must not
 * create duplicate photos. The persisted marker prevents an endless retry
 * loop if a phone gets the new app before the migration reaches its server. */
export function recoverPhotoUpload(
  entry: OutboxEntry,
  email: string | null,
  now: number,
): OutboxEntry {
  const author = entry.payload.createdBy;
  if (
    !email || typeof author !== "string" ||
    author.toLowerCase() !== email.toLowerCase() ||
    !["photo_upload", "receipt_upload"].includes(entry.op) ||
    entry.status !== "failed" || !entry.hasBlob ||
    entry.payload[REPAIR] === true || !isPhotoConflictIndexError(entry.lastError)
  ) return entry;
  return {
    ...retryEntry(entry, now),
    payload: { ...entry.payload, [REPAIR]: true },
  };
}

/** Recover old camera photos that hit the eight-attempt limit on a weak
 * connection. Only transport errors qualify; a server refusal stays visible
 * for manual resolution. The caller also verifies ownership and file bytes. */
export function recoverTransportFailedPhoto(entry: OutboxEntry, now: number): OutboxEntry {
  if (entry.status !== "failed" || !entry.hasBlob ||
      !(entry.op === "issue_photo_upload" ||
        (entry.op === "photo_upload" && uploadKind(entry) === "photo")) ||
      !/failed to fetch|networkerror|network error|load failed|fetch failed|timeout|timed out|taking too long to send|offline|connection/i.test(entry.lastError ?? "") ||
      !isRetryableError(new Error(entry.lastError ?? ""))) return entry;
  return retryEntry(entry, now);
}
