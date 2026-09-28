// Offline toolbox signing (owner go, 2026-09-25): the pieces of a signature
// that live on the phone. PURE — no Supabase, no pdf-lib, no React — so the
// outbox handler, the sign flow and the gates can all share it without pulling
// anything heavy along.
//
// A talk signed with no signal is kept in the outbox as a `toolbox_sign` entry
// and sent from there (at once, when there is signal). Two things follow from
// that and live here:
//   * the signature's FILES get paths made from its one-time client id, so a
//     resend after a lost reply uploads over the same objects (upsert) instead
//     of leaving a second copy, and the row it files names those same paths;
//   * a signature still on the phone counts as signed for the day it was made
//     — and only that day — so the clock-in, unit work and the nag banner open
//     the moment the person signs, not when the truck finds signal.

import type { OutboxEntry } from "./offline/outbox-core";

/**
 * What a `toolbox_sign` entry carries (lib/offline/outbox.ts, enqueueToolboxSign).
 * `profileId` is the signer's user id: the server refuses the signature for
 * anybody else, and it is the author evidence an owner check reads (#660).
 */
export interface ToolboxSignPayload {
  clientId: string;
  profileId: string;
  talkId: string;
  talkDate: string | null;
  typedName: string;
  /** When the person signed, by the phone's clock (ISO). */
  signedAt: string;
  /** The talk exactly as it was signed (lib/toolbox.ts talkSnapshot). */
  talkSnapshot: string;
  signaturePath: string;
  /** The drawn signature, as the pad gave it: a PNG data URL. */
  signatureDataUrl: string;
  /** Null when the PDF could not be built on the phone; the row files without one. */
  pdfPath: string | null;
}

/** The phone's own calendar day, YYYY-MM-DD — the day the crew counts. */
export function localDateOf(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** True when `iso` falls on the phone's today. */
export function signedToday(iso: string | null | undefined, now: Date = new Date()): boolean {
  if (!iso) return false;
  const at = new Date(iso);
  if (!Number.isFinite(at.getTime())) return false;
  return localDateOf(at) === localDateOf(now);
}

/**
 * Where a signature's two files go in the `toolbox-records` bucket, decided by
 * who signed, which talk and the signature's own client id — never by the
 * moment it is sent. The date is the signing day, for a person browsing the
 * bucket. The first segment is the signer's id: the folder the storage fence
 * lets a test login write (20261027020000), and the one sign_toolbox_talk
 * insists on.
 */
export function toolboxRecordPaths(
  profileId: string,
  talkId: string,
  clientId: string,
  signedAt: Date,
): { signaturePath: string; pdfPath: string } {
  const base = `${profileId}/${talkId}/${localDateOf(signedAt)}-${clientId}`;
  return { signaturePath: `${base}-signature.png`, pdfPath: `${base}.pdf` };
}

/** The PNG inside the signature pad's data URL. Empty rather than throwing. */
export function signaturePngBytes(dataUrl: string): Uint8Array {
  const base64 = dataUrl.split(",")[1] ?? "";
  let bin = "";
  try {
    bin = atob(base64);
  } catch {
    return new Uint8Array(0);
  }
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/** A signature still on this phone, as the gates need to read it. */
export interface PendingSignature {
  entryId: string;
  clientId: string;
  profileId: string;
  talkId: string | null;
  typedName: string | null;
  signedAt: string;
  /** queued/sending: on its way. failed: Forge refused it (see lastError). */
  status: OutboxEntry["status"];
  lastError: string | null;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v !== "" ? v : null;
}

/** The signature an outbox entry holds, or null when it is not one. */
export function pendingSignatureOf(entry: OutboxEntry): PendingSignature | null {
  if (entry.op !== "toolbox_sign") return null;
  const p = entry.payload;
  const clientId = str(p.clientId);
  const profileId = str(p.profileId);
  const signedAt = str(p.signedAt);
  if (!clientId || !profileId || !signedAt) return null;
  return {
    entryId: entry.id,
    clientId,
    profileId,
    talkId: str(p.talkId),
    typedName: str(p.typedName),
    signedAt,
    status: entry.status,
    lastError: entry.lastError,
  };
}

/**
 * This person's signature still on the phone that counts for today: signed on
 * the phone's today, newest first. A refused one counts too — it still holds
 * the clock-in behind it, and the screens say it was refused. Yesterday's does
 * not: a new day has its own talk, and the server keeps a late signature on
 * the day it was signed (20261033000000).
 */
export function todaysPendingSignature(
  entries: readonly OutboxEntry[],
  profileId: string | null | undefined,
  now: Date = new Date(),
): PendingSignature | null {
  if (!profileId) return null;
  let best: PendingSignature | null = null;
  for (const e of entries) {
    const s = pendingSignatureOf(e);
    if (!s || s.profileId !== profileId || !signedToday(s.signedAt, now)) continue;
    if (!best || Date.parse(s.signedAt) > Date.parse(best.signedAt)) best = s;
  }
  return best;
}

/**
 * A completion row as the screens read one, which may be a signature still on
 * the phone. `pending` and `sendFailed` say which; a real row has neither.
 */
export interface ToolboxCompletionView {
  id: string;
  talk_id: string | null;
  profile_id: string | null;
  signed_at: string;
  typed_name: string | null;
  signature_path: string | null;
  talk_snapshot: string | null;
  pdf_path: string | null;
  created_at: string;
  signed_via?: string | null;
  signed_by?: string | null;
  /** Still on this phone: signed, not yet in Forge. */
  pending?: boolean;
  /** Still on this phone, and Forge refused it. */
  sendFailed?: boolean;
  /** Forge's reason, when it refused. */
  sendError?: string | null;
}

/** A signature on the phone, shaped like the row it will become. */
export function pendingCompletionOf(s: PendingSignature): ToolboxCompletionView {
  return {
    id: `pending:${s.entryId}`,
    talk_id: s.talkId,
    profile_id: s.profileId,
    signed_at: s.signedAt,
    typed_name: s.typedName,
    // The files are not in Forge yet: nothing to open.
    signature_path: null,
    talk_snapshot: null,
    pdf_path: null,
    created_at: s.signedAt,
    signed_via: "self",
    signed_by: null,
    pending: true,
    sendFailed: s.status === "failed",
    sendError: s.status === "failed" ? s.lastError : null,
  };
}
