// Credentials: the cards a crew member holds, and the day each one runs out
// (Wave O, transcripts grill 2026-09-03, Q14).
//
// The app already knows what somebody is GOOD at — a skill tier, a capability
// badge, a per-type training clearance. It has never known what they are
// CERTIFIED to do, and those are the pieces of paper a general contractor asks
// for at the gate and a bid asks for on page two.
//
// The pure half of this file is the rule, and it lives twice on purpose: the
// SQL copy is claim_credential_nudges() (migration 20260983000000), because the
// 7 AM sweep has to decide and claim in one statement, and credentials.test.ts
// carries a block named after that function which spells its clauses out here.
// A change made to one side and not the other fails a test rather than going
// quietly live.
//
// Dates are plain YYYY-MM-DD day strings throughout. `daysBetween` is borrowed
// from lib/pipeline.ts rather than written again: it is the same question ("how
// many days from today to this day"), and its one subtlety — rounding, so the
// two mornings a year daylight saving makes a "day" 23 hours long do not move a
// warning — is worth having in exactly one place.

import { supabase } from "./supabase";
import { isMissingTable } from "./schemaErrors";
import { daysBetween } from "./pipeline";
import { signedMedia } from "./photos";

/** The cards this company is actually asked for. Mirrors the CHECK. */
export type CertificationKind =
  | "osha10"
  | "osha30"
  | "first_aid_cpr"
  | "aerial_lift"
  | "forklift"
  | "fall_protection"
  | "other";

/**
 * The order cards are LISTED and COUNTED in, which is not the order the CHECK
 * declares them. OSHA 30 leads because it is the card a bid is asked for first
 * and the one fewest people hold; `other` trails because it is a bucket, not a
 * card. The spec's own example — "4 OSHA 30 · 12 OSHA 10 · 6 aerial lift" —
 * is this order.
 */
export const CERTIFICATION_KINDS: CertificationKind[] = [
  "osha30",
  "osha10",
  "first_aid_cpr",
  "aerial_lift",
  "forklift",
  "fall_protection",
  "other",
];

/** How close to the expiry date the app starts saying something. The SQL uses
 * the same number; changing one means changing both. */
export const EXPIRY_WARN_DAYS = 30;

/**
 * How long after a card has expired the sweep still bothers to say so. A card
 * that ran out in 2019, typed in today as history, must not wake three
 * supervisors' phones about a fact everybody already knows.
 */
export const EXPIRED_NUDGE_GRACE_DAYS = 30;

export interface Certification {
  id: string;
  profileId: string;
  kind: CertificationKind;
  /** Only ever set when kind is "other". */
  otherLabel: string | null;
  issuedOn: string | null;
  /** Null = the card carries no expiry date. A real answer, not a gap. */
  expiresOn: string | null;
  /** "<profile_id>/<uuid>.jpg" inside the private credential-docs bucket. */
  documentPath: string | null;
  verifiedBy: string | null;
  verifiedAt: string | null;
  createdBy: string | null;
  createdAt: string;
  voidedAt: string | null;
}

interface CertificationRow {
  id: string;
  profile_id: string;
  kind: string;
  other_label: string | null;
  issued_on: string | null;
  expires_on: string | null;
  document_path: string | null;
  verified_by: string | null;
  verified_at: string | null;
  created_by: string | null;
  created_at: string;
  voided_at: string | null;
}

const CERT_COLS =
  "id, profile_id, kind, other_label, issued_on, expires_on, document_path, " +
  "verified_by, verified_at, created_by, created_at, voided_at";

function mapRow(row: CertificationRow): Certification {
  return {
    id: row.id,
    profileId: row.profile_id,
    kind: row.kind as CertificationKind,
    otherLabel: row.other_label,
    issuedOn: row.issued_on,
    expiresOn: row.expires_on,
    documentPath: row.document_path,
    verifiedBy: row.verified_by,
    verifiedAt: row.verified_at,
    createdBy: row.created_by,
    createdAt: row.created_at,
    voidedAt: row.voided_at,
  };
}

// ------------------------------------------------------------------ pure

/**
 * What colour the chip beside a card is.
 *
 *   "none"    — the card has no expiry date. Grey. Not a warning and not a
 *               clean bill of health: nobody has said when it runs out.
 *   "ok"      — more than thirty days left. Green.
 *   "soon"    — thirty days or fewer. Amber. This is the window the sweep
 *               pushes about.
 *   "expired" — the day has passed. Red.
 *
 * The boundary is deliberately "30 or fewer is amber", not "under 30": the day
 * a card enters its last month is the day it should start looking urgent, and a
 * push goes out on the same day for the same reason.
 */
export type ExpiryState = "none" | "ok" | "soon" | "expired";

export function expiryState(
  expiresOn: string | null | undefined,
  today: string,
): ExpiryState {
  const days = daysBetween(today, expiresOn);
  if (days === null) return "none";
  if (days < 0) return "expired";
  return days <= EXPIRY_WARN_DAYS ? "soon" : "ok";
}

/** A card that has not been voided. Voided cards are kept forever and shown
 * nowhere, because "who said this person had an OSHA 30" outlives the mistake. */
export function isLive(cert: Pick<Certification, "voidedAt">): boolean {
  return cert.voidedAt == null;
}

/**
 * Does this card count on a bid? Verified, not voided, and not expired.
 *
 * All three matter. An unverified card is a claim nobody has checked; an
 * expired one is a card the GC will refuse at the gate; and a voided one was
 * never real. A card with NO expiry counts — that is what a card with no expiry
 * printed on it means.
 */
export function countsOnBid(cert: Certification, today: string): boolean {
  if (!isLive(cert) || !cert.verifiedAt) return false;
  return expiryState(cert.expiresOn, today) !== "expired";
}

export interface KindCount {
  kind: CertificationKind;
  n: number;
}

/**
 * How many verified, unexpired cards of each kind the company holds, in
 * CERTIFICATION_KINDS order, with the kinds nobody holds left out entirely.
 *
 * One person with two OSHA 10 cards counts twice, which is the honest answer to
 * "how many cards do we hold" and the wrong answer to "how many people are
 * OSHA 10". The summary says cards; the roster says people.
 */
export function summarizeCertifications(
  certs: Certification[],
  today: string,
): KindCount[] {
  const counts = new Map<CertificationKind, number>();
  for (const cert of certs) {
    if (!countsOnBid(cert, today)) continue;
    counts.set(cert.kind, (counts.get(cert.kind) ?? 0) + 1);
  }
  return CERTIFICATION_KINDS.filter((k) => (counts.get(k) ?? 0) > 0).map((kind) => ({
    kind,
    n: counts.get(kind) ?? 0,
  }));
}

/**
 * "4 OSHA 30 · 12 OSHA 10 · 6 aerial lift" — the line that gets pasted into a
 * bid.
 *
 * NO NAMES, ever. A bid says how many cards the company holds; who holds which
 * one is nobody outside the company's business, and a pasted list of names is a
 * list of names that then lives in somebody else's document forever.
 *
 * `label` comes from the caller so the line reads in the language the person
 * pasting it is using; the words themselves are in the catalog.
 */
export function summaryText(
  counts: KindCount[],
  label: (kind: CertificationKind) => string,
): string {
  return counts.map((c) => `${c.n} ${label(c.kind)}`).join(" · ");
}

/** Cards that expire inside the next `days` days and have not already gone —
 * the Heartbeat tile's number, and the same window the sweep pushes about. */
export function expiringSoon(
  certs: Certification[],
  today: string,
  days: number = EXPIRY_WARN_DAYS,
): Certification[] {
  return certs.filter((cert) => {
    if (!isLive(cert)) return false;
    const left = daysBetween(today, cert.expiresOn);
    return left !== null && left >= 0 && left <= days;
  });
}

/** The kinds of warning the sweep can claim. Mirrors the kinds
 * claim_credential_nudges() writes into credential_nudges. */
export type CredentialNudgeKind = "credential_30d" | "credential_expired";

export interface CredentialNudge {
  certificationId: string;
  profileId: string;
  kind: CredentialNudgeKind;
  /** The day the warning is ABOUT: the expiry date, never the day it was sent. */
  onDate: string;
  daysUntil: number;
}

/**
 * THE READABLE TWIN of claim_credential_nudges(). Same two rules, same windows,
 * same order.
 *
 *   (a) the card is inside its last thirty days — WINDOWED (0..30) rather than
 *       "exactly 30 days out", so one missed morning does not silently drop the
 *       warning. The ledger's unique key is what keeps it to once per expiry
 *       date, and a RENEWED card with a new date earns a fresh warning, which
 *       is right.
 *   (b) the card has run out inside the last thirty days.
 *
 * A voided card is silent. An UNVERIFIED card still warns: the office not
 * having got round to looking at the paper is not a reason to let somebody's
 * OSHA card lapse.
 *
 * This function does not know what has already been said — the ledger does, in
 * SQL. It answers "what is due today", which is what a chip and a tile need.
 */
export function dueCredentialNudges(
  certs: Certification[],
  today: string,
): CredentialNudge[] {
  const out: CredentialNudge[] = [];
  for (const cert of certs) {
    if (!isLive(cert) || !cert.expiresOn) continue;
    const days = daysBetween(today, cert.expiresOn);
    if (days === null) continue;
    const kind: CredentialNudgeKind | null =
      days >= 0 && days <= EXPIRY_WARN_DAYS
        ? "credential_30d"
        : days < 0 && days >= -EXPIRED_NUDGE_GRACE_DAYS
          ? "credential_expired"
          : null;
    if (!kind) continue;
    out.push({
      certificationId: cert.id,
      profileId: cert.profileId,
      kind,
      onDate: cert.expiresOn,
      daysUntil: days,
    });
  }
  return out;
}

/**
 * Where this person's next document goes: "<profile_id>/<uuid>.jpg".
 *
 * The FIRST FOLDER IS THE PERMISSION — the storage policies read it directly
 * rather than joining back to the certifications table, so a path built any
 * other way is simply refused by the bucket. Minted client-side because the
 * photo is uploaded before the row exists.
 */
export function credentialDocPath(profileId: string, ext = "jpg"): string {
  const id =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `${profileId}/${id}.${ext}`;
}

// ------------------------------------------------------------------ data

/**
 * Cards on file. Everyone reads their own; foreman+ reads everybody's, which is
 * the RLS policy, not a filter here — asking for somebody else's simply comes
 * back empty rather than erroring.
 *
 * Voided rows are dropped here rather than in SQL so the caller cannot forget.
 * Degrades to empty on a phone whose database has the app but not yet
 * 20260983000000, so Crew and My Work still load.
 */
export async function listCertifications(profileId?: string): Promise<Certification[]> {
  let query = supabase
    .from("certifications")
    .select(CERT_COLS)
    .order("expires_on", { ascending: true, nullsFirst: false });
  if (profileId) query = query.eq("profile_id", profileId);
  const { data, error } = await query;
  if (isMissingTable(error, "certifications")) return [];
  if (error) throw error;
  return ((data ?? []) as CertificationRow[]).map(mapRow).filter(isLive);
}

export interface SetCertificationArgs {
  /** Absent = a new card. Present = an edit, which is supervisor+ in SQL. */
  id?: string;
  profileId?: string;
  kind?: CertificationKind;
  otherLabel?: string | null;
  issuedOn?: string | null;
  expiresOn?: string | null;
  documentPath?: string | null;
  verified?: boolean;
  voided?: boolean;
  clearIssued?: boolean;
  clearExpires?: boolean;
}

/**
 * The one writer. Partial by design: a field left out is left alone, and a date
 * is cleared through its own flag — so verifying a card cannot wipe the expiry
 * date the caller never mentioned.
 */
export async function setCertification(args: SetCertificationArgs): Promise<void> {
  const { error } = await supabase.rpc("set_certification", {
    p_id: args.id ?? null,
    p_profile_id: args.profileId ?? null,
    p_kind: args.kind ?? null,
    p_other_label: args.otherLabel ?? null,
    p_issued_on: args.issuedOn ?? null,
    p_expires_on: args.expiresOn ?? null,
    p_document_path: args.documentPath ?? null,
    p_verified: args.verified ?? null,
    p_voided: args.voided ?? null,
    p_clear_issued: args.clearIssued ?? false,
    p_clear_expires: args.clearExpires ?? false,
  });
  if (error) throw error;
}

/**
 * Put the photo of a card in the private bucket and hand back its path.
 *
 * Uploaded straight rather than through the offline outbox, unlike a job photo:
 * this is filed at a desk or at a toolbox talk with a phone in hand, once per
 * card per two years, and a queued upload whose row was never written is worse
 * than a failure the person can see and retry.
 */
export async function uploadCredentialDoc(
  profileId: string,
  file: File,
): Promise<string> {
  const ext = file.type === "application/pdf" ? "pdf" : "jpg";
  const path = credentialDocPath(profileId, ext);
  const { error } = await supabase.storage
    .from("credential-docs")
    .upload(path, file, { contentType: file.type || "image/jpeg", upsert: false });
  if (error) throw error;
  return path;
}

/** A short-lived signed URL for a stored card, or null when it cannot be read. */
export async function credentialDocUrl(path: string): Promise<string | null> {
  return signedMedia(`credential-docs/${path}`);
}
