// Whose is this queued write? (2026-09-25 — Codex review of #654, finding 3.)
//
// A phone can change hands with work still on it: A clocks in with no
// signal, signs out, and B signs in. The drain used to send A's punch the
// moment it could, and every request carries whoever is signed in at that
// moment — so it went out with B's token, and clock_in files the shift for
// auth.uid(). A's morning became B's shift. Every write the outbox queues now
// carries the user id of whoever queued it (OutboxEntry.ownerId), and the
// drain sends it only while that same person is signed in, with that
// person's token fixed for the whole send (outbox.ts). Anyone else's work
// waits, untouched, for its owner.
//
// PURE. The runtime supplies who is signed in; this only answers the question.

import type { OutboxEntry } from "./outbox-core";

/** Who is signed in right now, as far as the question needs. */
export interface Signer {
  userId: string | null;
  email: string | null;
}

function text(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v : null;
}

/**
 * Does this entry belong to the person signed in now? Nobody signed in owns
 * nothing: with no session there is no one to send it as.
 *
 * An entry queued by this build or later carries `ownerId`, and only that
 * person may send it. An entry queued by an older build carries no owner, and
 * is judged on the evidence it does carry:
 *
 *   - `payload.actorId` (the Hex-Portal writes) is a user id already;
 *   - `payload.createdBy` (photos) is the photographer's email, compared
 *     without case, the way the photo-recovery rule compares it;
 *   - nothing at all (clock punches, warehouse writes, daily logs, pin moves):
 *     whoever was signed in when this copy of the app started. If nobody was,
 *     it waits. outbox.ts writes that person onto these entries the first time
 *     it sees them (`needsAdoption`), so a later launch signed in as someone
 *     else cannot take them over.
 */
export function belongsTo(entry: OutboxEntry, signer: Signer, launchUserId: string | null): boolean {
  if (!signer.userId) return false;
  if (entry.ownerId) return entry.ownerId === signer.userId;
  const actor = text(entry.payload.actorId);
  if (actor) return actor === signer.userId;
  const author = text(entry.payload.createdBy);
  if (author) return signer.email != null && author.toLowerCase() === signer.email.toLowerCase();
  return launchUserId != null && launchUserId === signer.userId;
}

/** An older entry with no owner and no evidence of one — see belongsTo. */
export function needsAdoption(entry: OutboxEntry): boolean {
  return !entry.ownerId && !text(entry.payload.actorId) && !text(entry.payload.createdBy);
}
