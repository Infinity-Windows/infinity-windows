import { retryEntry, type OutboxEntry } from "./outbox-core";

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
