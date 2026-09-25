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

import type { OutboxEntry, OutboxOp } from "./outbox-core";

/** Who is signed in right now, as far as the question needs. */
export interface Signer {
  userId: string | null;
  email: string | null;
}

/**
 * mine    — the signed-in person's own write: it may go out, as them.
 * theirs  — someone else's (or anyone's, while nobody is signed in): it waits
 *           for its owner.
 * unknown — a write that names no owner at all: never sent as anyone. The
 *           only way out is a person throwing it away (Stuck writes).
 */
export type Ownership = "mine" | "theirs" | "unknown";

/**
 * The ops whose payload names its author, and the one field that does
 * (Codex review of #660, P1 #1: evidence only where it really identifies the
 * author, decided per op):
 *
 *   - photo_upload / receipt_upload carry `createdBy`, the photographer's
 *     email, written at the shutter (or from the install record, for a unit's
 *     media, and by the retired upload queue for its items);
 *   - the Hex-Portal writes carry `actorId`, the author's user id, written
 *     when the case, outcome or lesson was saved.
 *
 * Nothing else carries a name: a clock punch, a daily log, a receipt capture,
 * a quiz result, a warehouse or pin move, a job fact, a damage photo. Those
 * are this person's only when they carry `ownerId`.
 */
const AUTHOR_EMAIL_OPS: ReadonlySet<OutboxOp> = new Set<OutboxOp>(["photo_upload", "receipt_upload"]);
const AUTHOR_ID_OPS: ReadonlySet<OutboxOp> = new Set<OutboxOp>([
  "hex_portal_case",
  "hex_portal_outcome",
  "hex_learning_draft",
]);

function text(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
}

/** The author the payload itself names, for the ops where it names one. */
export function authorEvidence(entry: OutboxEntry): { userId: string } | { email: string } | null {
  if (AUTHOR_ID_OPS.has(entry.op)) {
    const id = text(entry.payload.actorId);
    return id ? { userId: id } : null;
  }
  if (AUTHOR_EMAIL_OPS.has(entry.op)) {
    const email = text(entry.payload.createdBy);
    return email ? { email } : null;
  }
  return null;
}

/**
 * Whose is it, for the person signed in now?
 *
 * `ownerId` — written when the write was queued, by this build or later —
 * decides. An older entry without one is judged on the author its payload
 * names (authorEvidence). An entry that names no one is `unknown`: who was
 * signed in when this copy of the app started, or is signed in now, is not
 * evidence of who queued it (Codex review of #660, P1 #1).
 */
export function ownershipOf(entry: OutboxEntry, signer: Signer): Ownership {
  const author = entry.ownerId ? { userId: entry.ownerId } : authorEvidence(entry);
  if (!author) return "unknown";
  if ("userId" in author) return signer.userId !== null && author.userId === signer.userId ? "mine" : "theirs";
  return signer.email !== null && author.email.toLowerCase() === signer.email.trim().toLowerCase() ? "mine" : "theirs";
}

/** May this entry go out as the person signed in now? */
export function belongsTo(entry: OutboxEntry, signer: Signer): boolean {
  return signer.userId !== null && ownershipOf(entry, signer) === "mine";
}
