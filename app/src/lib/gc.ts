// The GC handshake: check-ins, links, and the thread (Wave H, transcripts
// grill 2026-09-03, Q10 + Q11 + Q20).
//
// Six questions get asked on every job — when the GC thinks the house is
// finished, when the roof goes on, whether the framing has been checked,
// whether he wants the windows inset or outset, and what is going on the
// outside and the inside. The answers used to live in somebody's memory of a
// phone call. Filing one here is what "communicated with the GC" means, and it
// is what the 7 AM sweep reads before deciding a job needs a call.
//
// The pure half of this file (the validator, the link URL) is unit-tested next
// door in gc.test.ts; the rest is thin api plumbing.

import { supabase } from "./supabase";
import { isMissingTable } from "./schemaErrors";

/** How the conversation happened. Mirrors the CHECK on the table. */
export const GC_CHANNELS = ["call", "text", "email", "site"] as const;
export type GcChannel = (typeof GC_CHANNELS)[number];

/**
 * What the builder said he wants, at the JOB level. It decides nothing about a
 * unit — the per-unit spec field in the signature stays authoritative for what
 * actually gets installed where. This is what he SAID, which is a different
 * fact and sometimes a different answer.
 */
export const GC_SET_PREFERENCES = ["inset", "outset", "unknown"] as const;
export type GcSetPreference = (typeof GC_SET_PREFERENCES)[number];

/** Who filed it: the office after a call, or the GC himself on the link. */
export type GcCheckinSource = "crew" | "gc";

/** The brand a job is presented to its GC under (Q20, the owner's design). */
export const GC_BRANDS = ["stg", "forge"] as const;
export type GcBrand = (typeof GC_BRANDS)[number];

/** The full name each brand is written out as, on the page and in the email. */
export const GC_BRAND_NAMES: Record<GcBrand, string> = {
  stg: "STG Windows & Doors",
  forge: "Forge Windows and Doors",
};

/** A brand value from the database, narrowed — anything unknown reads as stg,
 * which is the default and the outward-facing brand. */
export function gcBrandOf(value: string | null | undefined): GcBrand {
  return value === "forge" ? "forge" : "stg";
}

export interface GcCheckin {
  id: string;
  project_id: string;
  author_id: string | null;
  contacted_at: string;
  contact_name: string | null;
  channel: string;
  expected_end_date: string;
  roof_on_date: string;
  framing_checked: boolean;
  set_preference: string;
  exterior_material: string;
  interior_material: string;
  notes: string | null;
  source: string;
  created_at: string;
}

/** Explicit, like every select in this repo: a `*` is how a column nobody meant
 * to publish reaches a screen. */
const CHECKIN_COLS =
  "id, project_id, author_id, contacted_at, contact_name, channel, expected_end_date, " +
  "roof_on_date, framing_checked, set_preference, exterior_material, interior_material, " +
  "notes, source, created_at";

/** What the form holds while somebody is filling it in — every field a string
 * or null, because that is what an <input> gives back. */
export interface GcCheckinDraft {
  expectedEndDate: string;
  roofOnDate: string;
  framingChecked: boolean | null;
  setPreference: string;
  exteriorMaterial: string;
  interiorMaterial: string;
  channel?: string;
  contactName?: string;
  notes?: string;
}

/**
 * Which of the six required answers is still missing, as a key the caller
 * translates — or null when the check-in is complete.
 *
 * PURE, and deliberately the same rule the SQL enforces (log_gc_checkin refuses
 * each of these with its own plain sentence). Two copies, because the browser's
 * is a courtesy that saves a round trip and the server's is the one that holds
 * when somebody posts from a script; a test names them together.
 *
 * Returned in FORM ORDER rather than by importance, so the message always
 * points at the first empty box on the screen instead of scrolling somebody
 * up and down the card.
 */
export type GcCheckinProblem =
  | "expectedEndDate"
  | "roofOnDate"
  | "framingChecked"
  | "setPreference"
  | "exteriorMaterial"
  | "interiorMaterial"
  | "channel";

export function firstMissingAnswer(draft: GcCheckinDraft): GcCheckinProblem | null {
  if (!isDay(draft.expectedEndDate)) return "expectedEndDate";
  if (!isDay(draft.roofOnDate)) return "roofOnDate";
  if (draft.framingChecked === null || draft.framingChecked === undefined) {
    return "framingChecked";
  }
  if (!GC_SET_PREFERENCES.includes(draft.setPreference as GcSetPreference)) {
    return "setPreference";
  }
  if (!draft.exteriorMaterial.trim()) return "exteriorMaterial";
  if (!draft.interiorMaterial.trim()) return "interiorMaterial";
  // Absent means "the caller does not ask" (the GC's own page never does — he
  // is answering on the page, and that is the channel). A value that is present
  // still has to be one of the four.
  if (draft.channel !== undefined && !GC_CHANNELS.includes(draft.channel as GcChannel)) {
    return "channel";
  }
  return null;
}

/** A YYYY-MM-DD day, and a real one. `new Date("2026-02-31")` rolls forward
 * silently, so the round trip is what actually checks it. */
function isDay(value: string | null | undefined): boolean {
  const day = (value ?? "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return false;
  const at = new Date(`${day}T00:00:00`);
  if (Number.isNaN(at.getTime())) return false;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}` === day;
}

/**
 * Every check-in on a job, newest first.
 *
 * Degrades to an empty list on a database that is behind the migration, and
 * says so: `known: false` is what keeps needsCall from counting "no check-in"
 * against a job the app simply cannot ask about yet. That distinction is the
 * whole reason this returns an object rather than an array.
 */
export interface GcCheckinHistory {
  rows: GcCheckin[];
  /** False when project_gc_checkins does not exist here yet. */
  known: boolean;
}

export async function listGcCheckins(projectId: string): Promise<GcCheckinHistory> {
  const { data, error } = await supabase
    .from("project_gc_checkins")
    .select(CHECKIN_COLS)
    .eq("project_id", projectId)
    .order("contacted_at", { ascending: false })
    .limit(50);
  if (error) {
    if (isMissingTable(error, "project_gc_checkins")) return { rows: [], known: false };
    throw error;
  }
  return { rows: (data ?? []) as unknown as GcCheckin[], known: true };
}

/**
 * The latest check-in day per job, for the Jobs list's "Needs a call" chip.
 *
 * One query for the whole list rather than one per card: the chip is drawn on
 * every job on the page, and a query per card is how a jobs list on a phone in
 * a driveway stops loading.
 */
export interface LatestCheckins {
  /** project id -> the contacted_at of its newest check-in. */
  byProject: Record<string, string>;
  known: boolean;
}

export async function latestGcCheckins(): Promise<LatestCheckins> {
  const { data, error } = await supabase
    .from("project_gc_checkins")
    .select("project_id, contacted_at")
    .order("contacted_at", { ascending: false });
  if (error) {
    if (isMissingTable(error, "project_gc_checkins")) return { byProject: {}, known: false };
    throw error;
  }
  const byProject: Record<string, string> = {};
  for (const row of (data ?? []) as { project_id: string; contacted_at: string }[]) {
    // Newest first, so the first one seen for a job wins.
    if (!byProject[row.project_id]) byProject[row.project_id] = row.contacted_at;
  }
  return { byProject, known: true };
}

/**
 * The query key the GC card and the Pipeline card BOTH read, so the two cards
 * on one screen share a single read and filing a check-in clears the chip on
 * both at once. It lives here rather than in the component because a file that
 * exports anything besides components loses React Fast Refresh (oxlint says so,
 * and the repo's warning count is a gate).
 */
export const gcCheckinsKey = (projectId: string) => ["gcCheckins", projectId] as const;

/** The Jobs list's batched read, keyed once so any filed check-in can clear it. */
export const gcCheckinsLatestKey = ["gcCheckinsLatest"] as const;

/** Foreman+: file one conversation with a job's GC. */
export async function logGcCheckin(
  projectId: string,
  draft: GcCheckinDraft,
): Promise<void> {
  const { error } = await supabase.rpc("log_gc_checkin", {
    p_project_id: projectId,
    p_expected_end_date: draft.expectedEndDate,
    p_roof_on_date: draft.roofOnDate,
    p_framing_checked: draft.framingChecked,
    p_set_preference: draft.setPreference,
    p_exterior_material: draft.exteriorMaterial,
    p_interior_material: draft.interiorMaterial,
    p_channel: draft.channel ?? "call",
    p_contact_name: draft.contactName ?? null,
    p_notes: draft.notes ?? null,
    p_contacted_at: null,
  });
  if (error) throw error;
}

// ---------------------------------------------------------------------------
// H2 — the link, the thread, and the email
// ---------------------------------------------------------------------------

export interface GcLink {
  id: string;
  project_id: string;
  brand: string;
  sent_to_email: string | null;
  sent_at: string | null;
  expires_at: string;
  used_at: string | null;
  revoked_at: string | null;
  created_at: string;
}

/** Note what is NOT selected: token_hash. The office has no use for it, and a
 * column nobody reads is a column that cannot leak into a screenshot. */
const LINK_COLS =
  "id, project_id, brand, sent_to_email, sent_at, expires_at, used_at, revoked_at, created_at";

/** What the GC card's standing line should say about the email:
 * `sent` names the address, `unsent` says nothing went, `silent` says nothing
 * at all. */
export type GcLinkDelivery = "sent" | "unsent" | "silent";

/** Did an email actually go out on this link?
 *
 * ONLY sent_at ANSWERS THAT. sent_to_email is who the office meant to mail,
 * written when the link was minted, and the first cut of the card read the
 * line off that address alone — so a link said "Sent to bob@builder.com" the
 * instant it existed, before any mail was attempted. The case that made it
 * matter is the one this feature ships in: with RESEND_API_KEY unset the
 * send-email function answers "email is not configured" and nothing leaves the
 * building, while the card claimed the builder had been written to. Only the
 * send-email function writes sent_at, and only on a real 2xx from Resend.
 *
 * A sent_at with no address is unreachable (send-email refuses a link with no
 * address) and reads as `silent` rather than as a claim with a blank name in
 * it — an impossible row should make the card quiet, not wrong. */
export function gcLinkDelivery(
  link: Pick<GcLink, "sent_at" | "sent_to_email"> | null,
): GcLinkDelivery {
  if (!link?.sent_to_email) return "silent";
  return link.sent_at ? "sent" : "unsent";
}

export interface GcLinkState {
  link: GcLink | null;
  known: boolean;
}

/** The job's live link, if it has one. One job, one live link — create_gc_link
 * revokes any earlier one in the same statement. */
export async function currentGcLink(projectId: string): Promise<GcLinkState> {
  const { data, error } = await supabase
    .from("gc_links")
    .select(LINK_COLS)
    .eq("project_id", projectId)
    .is("revoked_at", null)
    .order("created_at", { ascending: false })
    .limit(1);
  if (error) {
    if (isMissingTable(error, "gc_links")) return { link: null, known: false };
    throw error;
  }
  return { link: ((data ?? []) as unknown as GcLink[])[0] ?? null, known: true };
}

/** What create_gc_link hands back — including the plaintext token, ONCE. */
export interface MintedGcLink {
  link_id: string;
  token: string;
  expires_at: string;
  brand: string;
}

/**
 * Foreman+: mint a link for this job's GC, revoking any earlier live one.
 *
 * The token in the result is the only copy that will ever exist on this side —
 * the database keeps a sha256 and nothing else. Hold it in component state long
 * enough to copy or email it; once the card is closed it is gone, and "send
 * again" mints a fresh one.
 */
export async function createGcLink(
  projectId: string,
  email: string | null,
  brand: GcBrand | null,
): Promise<MintedGcLink> {
  const { data, error } = await supabase.rpc("create_gc_link", {
    p_project_id: projectId,
    p_email: email,
    p_brand: brand,
  });
  if (error) throw error;
  const row = (data as MintedGcLink[] | MintedGcLink | null);
  const minted = Array.isArray(row) ? row[0] : row;
  if (!minted?.token) throw new Error("The link came back empty. Try again.");
  return minted;
}

/** Foreman+: turn a link off. Idempotent. */
export async function revokeGcLink(linkId: string): Promise<void> {
  const { error } = await supabase.rpc("revoke_gc_link", { p_link_id: linkId });
  if (error) throw error;
}

/** Foreman+: choose which of the company's two names this job's GC sees. */
export async function setProjectGcBrand(projectId: string, brand: GcBrand): Promise<void> {
  const { error } = await supabase.rpc("set_project_gc_brand", {
    p_project_id: projectId,
    p_brand: brand,
  });
  if (error) throw error;
}

export interface GcMessage {
  id: string;
  project_id: string;
  author: string;
  author_profile_id: string | null;
  body: string;
  created_at: string;
}

export interface GcThread {
  rows: GcMessage[];
  known: boolean;
}

/** The query key the GC card reads the thread under. */
export const gcThreadKey = (projectId: string) => ["gcThread", projectId] as const;
/** The query key the GC card reads the live link under. */
export const gcLinkKey = (projectId: string) => ["gcLink", projectId] as const;

/** The whole conversation with this job's builder, oldest first. NEVER crew
 * chat: project_messages is a different table for a different audience. */
export async function listGcMessages(projectId: string): Promise<GcThread> {
  const { data, error } = await supabase
    .from("gc_messages")
    .select("id, project_id, author, author_profile_id, body, created_at")
    .eq("project_id", projectId)
    .order("created_at", { ascending: true })
    .limit(200);
  if (error) {
    if (isMissingTable(error, "gc_messages")) return { rows: [], known: false };
    throw error;
  }
  return { rows: (data ?? []) as unknown as GcMessage[], known: true };
}

/** Foreman+: reply to the GC on the page he already has open. */
export async function postGcMessage(projectId: string, body: string): Promise<void> {
  const { error } = await supabase.rpc("post_gc_message", {
    p_project_id: projectId,
    p_body: body,
  });
  if (error) throw error;
}

/** What send-email answers with. `unconfigured` is not a failure: it means the
 * owner has not added a Resend key yet, and the card says so and offers the
 * link to copy instead. */
export interface SendEmailResult {
  ok: boolean;
  unconfigured?: boolean;
  error?: string;
  to?: string;
}

/**
 * Foreman+: email the link to the address stored on it.
 *
 * The function is NOT a relay — it will not take a recipient, a subject or a
 * body from here. It takes the link id, the token (checked against the link's
 * own hash), and the origin this app is being served from, and writes the mail
 * itself. `appBase` is what makes the link right on github.io today and on the
 * custom domain after the cutover.
 */
export async function sendGcLinkEmail(
  linkId: string,
  token: string,
  appBase: string,
): Promise<SendEmailResult> {
  const { data, error } = await supabase.functions.invoke("send-email", {
    body: { linkId, token, appBase },
  });
  if (error) {
    // A non-2xx from an edge function arrives as a FunctionsHttpError whose
    // useful half is in the response body, so read that rather than showing
    // "Edge Function returned a non-2xx status code" to a foreman.
    const detail = await readFunctionError(error);
    return { ok: false, error: detail };
  }
  return (data ?? { ok: false, error: "Email did not go." }) as SendEmailResult;
}

/** Pull the plain sentence out of an edge function's error response. */
async function readFunctionError(error: unknown): Promise<string> {
  const res = (error as { context?: { json?: () => Promise<unknown> } })?.context;
  try {
    const body = (await res?.json?.()) as { error?: unknown } | undefined;
    if (typeof body?.error === "string" && body.error) return body.error;
  } catch {
    // No JSON body — fall through to the error's own message.
  }
  return error instanceof Error ? error.message : "Email did not go.";
}
