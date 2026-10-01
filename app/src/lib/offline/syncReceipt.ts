/** A brief, session-only acknowledgment for a write the server accepted.
 * Queue removal alone is not proof: a person may discard a failed write. */
export interface SyncReceipt {
  ownerId: string;
  savedAt: number;
  sequence: number;
}

let sequence = 0;
const listeners = new Set<(receipt: SyncReceipt) => void>();

export function recordSyncReceipt(ownerId: string | null | undefined): void {
  if (!ownerId) return;
  const receipt = { ownerId, savedAt: Date.now(), sequence: ++sequence };
  for (const listener of listeners) {
    try { listener(receipt); } catch { /* UI listeners never affect a confirmed write. */ }
  }
}

export function subscribeSyncReceipt(listener: (receipt: SyncReceipt) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
