import type { OutboxEntry } from "./outbox-core";

export interface PhotoUploadProgress {
  uploaded: number;
  pending: number;
  failed: number;
  unconfirmed: number;
}

/** Session-only confirmations for the open capture sheets. Never infer success
 * from an empty queue: a person can explicitly discard a failed upload. */
export class PhotoUploadReceipts {
  private confirmed = new Map<string, string>();

  record(entry: OutboxEntry): void {
    const author = entry.payload.createdBy;
    if (entry.op !== "photo_upload" || typeof author !== "string") return;
    this.confirmed.set(entry.id, author.toLowerCase());
    // A long-running PWA must not accumulate unlimited capture receipts.
    if (this.confirmed.size > 1_000) this.confirmed.delete(this.confirmed.keys().next().value!);
  }

  summarize(ids: readonly string[], entries: OutboxEntry[], email: string | null): PhotoUploadProgress {
    const result: PhotoUploadProgress = { uploaded: 0, pending: 0, failed: 0, unconfirmed: 0 };
    const owner = email?.toLowerCase();
    const byId = new Map(entries.map(entry => [entry.id, entry]));
    for (const id of new Set(ids)) {
      const entry = byId.get(id);
      if (owner && entry?.op === "photo_upload" &&
        typeof entry.payload.createdBy === "string" && entry.payload.createdBy.toLowerCase() === owner) {
        if (entry.status === "failed") result.failed++;
        else result.pending++;
      } else if (owner && this.confirmed.get(id) === owner) result.uploaded++;
      else result.unconfirmed++;
    }
    return result;
  }
}
