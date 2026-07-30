/**
 * Crew invites: every rule, in one place, shared by the server and the browser.
 *
 * Runtime-agnostic on purpose. It uses only Web Crypto and string maths, which
 * behave identically in Deno (the Edge Functions), Vite (the app) and Node 22
 * (the vitest suite), so `app/src/lib/crewInvites.test.ts` tests the very code
 * that runs in production rather than a copy of it. That matters more here than
 * anywhere else in the app: an invite decides who gets a login and at what
 * role, so a UI that disagreed with the server about "may this person invite an
 * owner?" would be a privilege-escalation bug waiting to happen. There is one
 * `canInviteRole` and both sides call it.
 *
 * The server still re-checks everything. Nothing in this module is a control on
 * its own — the browser can lie about which role it is. The controls are in
 * supabase/functions/manage-crew-access/index.ts, which reads the caller's role
 * from the database, and in the migration's row-level security. This module is
 * how the two sides stay in step, not how they are enforced.
 */
import { hashPin } from "./pin.ts";

// ---------------------------------------------------------------------------
// Roles
// ---------------------------------------------------------------------------

export type CrewRoleName = "installer" | "foreman" | "supervisor" | "owner";

/** The roles an invite may name, weakest first. */
export const INVITABLE_ROLES: CrewRoleName[] = [
  "installer",
  "foreman",
  "supervisor",
  "owner",
];

export const ROLE_TITLES: Record<CrewRoleName, string> = {
  installer: "Installer",
  foreman: "Foreman",
  supervisor: "Supervisor",
  owner: "Owner",
};

/**
 * Rank a role so access is a single `>=`. Mirrors roleRank() in
 * app/src/lib/install/types.ts and public.role_rank() in the database, legacy
 * aliases included. Unknown or missing is the installer floor (0) so a legacy
 * or absent role can never over-grant.
 */
export function roleRank(role: string | null | undefined): number {
  switch (role) {
    case "owner":
    case "big_boss":
      return 3;
    case "supervisor":
    case "admin":
      return 2;
    case "foreman":
    case "lead":
      return 1;
    default:
      return 0;
  }
}

/**
 * The floor for handing out access at all: supervisor. This is deliberately the
 * same floor as public.set_profile_role() and the Admin screen, because
 * "invite someone as a foreman" and "promote someone to foreman" are the same
 * power wearing different clothes — if one is supervisor+ and the other is
 * foreman+, the weaker door is the real permission and the stronger one is
 * decoration. Installers and foremen cannot invite.
 */
export const MIN_RANK_TO_INVITE = 2;

export type InviteDenial =
  | "not-allowed-to-invite"
  | "above-own-role"
  | "unknown-role";

export interface InviteVerdict {
  ok: boolean;
  reason?: InviteDenial;
  /** Plain English, safe to show a non-technical user or return from the API. */
  message?: string;
}

/**
 * May `callerRole` create an invite for `targetRole`?
 *
 * Two rules, and the second is the one that matters:
 *   1. You must be a supervisor or the owner (MIN_RANK_TO_INVITE).
 *   2. You may never invite someone ABOVE your own rank.
 *
 * Rule 2 is what stops an invite becoming a privilege ladder. Without it a
 * supervisor could invite an owner, sign in as them, and hold every permission
 * their own account was denied — the same escalation that was closed on
 * profiles.role, rebuilt as a feature. Equal rank is allowed (an owner may
 * appoint a second owner, a supervisor a second supervisor), because that is a
 * lateral move that grants nothing the caller does not already have.
 */
export function canInviteRole(
  callerRole: string | null | undefined,
  targetRole: string | null | undefined,
): InviteVerdict {
  if (!INVITABLE_ROLES.includes(targetRole as CrewRoleName)) {
    return {
      ok: false,
      reason: "unknown-role",
      message: "Pick one of: Installer, Foreman, Supervisor, Owner.",
    };
  }

  const caller = roleRank(callerRole);
  if (caller < MIN_RANK_TO_INVITE) {
    return {
      ok: false,
      reason: "not-allowed-to-invite",
      message: "Only a supervisor or the owner can give someone access.",
    };
  }

  if (roleRank(targetRole) > caller) {
    return {
      ok: false,
      reason: "above-own-role",
      message: `You can't invite someone as ${
        ROLE_TITLES[targetRole as CrewRoleName]
      } — that is above your own role.`,
    };
  }

  return { ok: true };
}

/** The roles this caller may actually pick, for building a <select>. */
export function invitableRolesFor(
  callerRole: string | null | undefined,
): CrewRoleName[] {
  return INVITABLE_ROLES.filter((r) => canInviteRole(callerRole, r).ok);
}

/**
 * May `callerRole` take away, or re-issue a login for, someone who is currently
 * `targetRole`? Same ladder as inviting: you may act on your equals and your
 * juniors, never on someone above you.
 *
 * This is the rule that stops "send them a new login code" from being an
 * account takeover. Re-issuing a code for an existing account lets the holder
 * set that account's password, so if a supervisor could do it to the owner's
 * email, the supervisor would own the company's account. Being allowed to act
 * on an equal is a deliberate accepted risk: two owners can already change each
 * other's role today via set_profile_role.
 */
export function canManageMember(
  callerRole: string | null | undefined,
  targetRole: string | null | undefined,
): InviteVerdict {
  const caller = roleRank(callerRole);
  if (caller < MIN_RANK_TO_INVITE) {
    return {
      ok: false,
      reason: "not-allowed-to-invite",
      message: "Only a supervisor or the owner can change who has access.",
    };
  }
  if (roleRank(targetRole) > caller) {
    return {
      ok: false,
      reason: "above-own-role",
      message: "That person's role is above yours, so you can't change it.",
    };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// The code itself
// ---------------------------------------------------------------------------

/**
 * No I, L, O, 0 or 1. This code gets read off a cracked phone screen, or said
 * down a phone line on a windy site, so every pair that people mis-read is
 * simply absent from the alphabet rather than "handled" afterwards. 31 symbols.
 */
export const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

/** 10 symbols from 31 is ~49.5 bits — see the brute-force note on hashInviteCode. */
export const CODE_LENGTH = 10;

/**
 * A fresh invite code from the platform CSPRNG.
 *
 * Rejection-sampled: taking `byte % 31` directly would make the first four
 * symbols of the alphabet ~3% likelier than the rest, which quietly shrinks the
 * keyspace. Bytes at or above the largest multiple of 31 are thrown away
 * instead.
 */
export function generateInviteCode(length: number = CODE_LENGTH): string {
  const out: string[] = [];
  const buf = new Uint8Array(1);
  const limit = 256 - (256 % CODE_ALPHABET.length);
  while (out.length < length) {
    crypto.getRandomValues(buf);
    if (buf[0] >= limit) continue;
    out.push(CODE_ALPHABET[buf[0] % CODE_ALPHABET.length]);
  }
  return out.join("");
}

/**
 * What the person typed, turned into what we stored. Case, spaces and the
 * dashes we print for legibility are all noise; a code pasted out of a text
 * message often arrives wrapped in punctuation too.
 *
 * Deliberately NOT clever about confusable characters: because I/L/O/0/1 are
 * absent from CODE_ALPHABET there is no ambiguity to resolve, and guessing that
 * a typed "O" meant some other symbol would turn a wrong code into a different
 * wrong code.
 */
export function normalizeInviteCode(raw: string | null | undefined): string {
  return (raw ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/** Print it in two halves — far easier to read back than ten run-on symbols. */
export function formatInviteCode(code: string): string {
  const clean = normalizeInviteCode(code);
  if (clean.length !== CODE_LENGTH) return clean;
  return `${clean.slice(0, 5)}-${clean.slice(5)}`;
}

/** Is this even shaped like one of our codes? Cheap pre-check before hashing. */
export function looksLikeInviteCode(raw: string | null | undefined): boolean {
  const clean = normalizeInviteCode(raw);
  if (clean.length !== CODE_LENGTH) return false;
  return [...clean].every((c) => CODE_ALPHABET.includes(c));
}

/**
 * The fixed salt is NOT a secret and is not pretending to be one.
 *
 * A stored invite has to be findable from the code alone — the person redeeming
 * it has nothing else to identify their row with — so the hash must be
 * deterministic, which rules out a per-row random salt. What the salt does
 * still buy is domain separation: this hash is useless against the PIN hashes
 * produced by the same PBKDF2 helper.
 *
 * The real defence is the 100,000 PBKDF2 iterations combined with ~49.5 bits of
 * code entropy. Each guess costs a full derivation (~100ms of server CPU here,
 * and no cheaper offline), so working through even a thousandth of the keyspace
 * is not a thing an attacker can do inside the 7 days an invite lives. Storing
 * the code in plain text, or under a fast hash like SHA-256, would leave a
 * stolen backup of this table directly redeemable.
 */
const CODE_SALT_B64 = "aW52aXRlLWNvZGUtdjEtc2FsdA==";

/** The value stored in crew_invites.code_hash. Never store the code itself. */
export async function hashInviteCode(code: string): Promise<string> {
  return await hashPin(normalizeInviteCode(code), CODE_SALT_B64);
}

// ---------------------------------------------------------------------------
// Expiry and single use
// ---------------------------------------------------------------------------

/**
 * Seven days.
 *
 * The failure this bounds is not a stolen database, it is ordinary life: the
 * code goes into a group chat, gets screenshotted, forwarded to a brother-in-law
 * or scrolled past for a fortnight. A week is long enough that a foreman who
 * texts it on Friday can still walk a new hire through it on Monday, and short
 * enough that a link resting in someone's message history is dead by the time
 * anyone idly taps it. Anything longer is effectively a permanent password sat
 * in a text thread.
 */
export const INVITE_TTL_DAYS = 7;

export function inviteExpiryFrom(now: Date = new Date()): Date {
  return new Date(now.getTime() + INVITE_TTL_DAYS * 24 * 60 * 60 * 1000);
}

export type InviteStatus = "pending" | "redeemed" | "revoked" | "expired";

export interface CrewInviteRow {
  id: string;
  display_name: string;
  email: string;
  role: string;
  created_at: string;
  expires_at: string;
  redeemed_at: string | null;
  revoked_at: string | null;
  /** Set when this code re-issues a login for an account that already exists. */
  target_user_id?: string | null;
}

/**
 * One invite, one account. Order matters and is not arbitrary:
 *
 *   redeemed wins over everything, because it is a fact about the past — a code
 *   that was already used must never come back to life, whatever else happened
 *   to the row afterwards. This is the single-use rule as the UI sees it; the
 *   rule as the DATABASE enforces it is the atomic claim in
 *   redeem-crew-invite, and that is the one that actually stops two people
 *   racing the same code.
 *
 *   revoked next, so a code someone deliberately killed reads as killed rather
 *   than as merely stale.
 *
 *   expired before pending, so a live-looking row cannot outlive its date.
 */
export function inviteStatus(
  invite: Pick<CrewInviteRow, "expires_at" | "redeemed_at" | "revoked_at">,
  now: Date = new Date(),
): InviteStatus {
  if (invite.redeemed_at) return "redeemed";
  if (invite.revoked_at) return "revoked";
  const expires = Date.parse(invite.expires_at);
  // An unparseable date is treated as expired: refusing a good invite is a
  // phone call, honouring a bad one is an account.
  if (Number.isNaN(expires) || expires <= now.getTime()) return "expired";
  return "pending";
}

/** Can this code still be exchanged for a login right now? */
export function isRedeemable(
  invite: Pick<CrewInviteRow, "expires_at" | "redeemed_at" | "revoked_at">,
  now: Date = new Date(),
): boolean {
  return inviteStatus(invite, now) === "pending";
}

/** Why a code was refused, in words a crew member can act on. */
export function redemptionRefusal(status: InviteStatus): string {
  switch (status) {
    case "redeemed":
      return "That code has already been used. Ask for a new one.";
    case "revoked":
      return "That code was cancelled. Ask for a new one.";
    case "expired":
      return "That code has expired. Ask for a new one.";
    default:
      return "";
  }
}

/** "3 days left" / "Expires today" — for the pending-invites list. */
export function expiresInWords(
  expiresAt: string,
  now: Date = new Date(),
): string {
  const ms = Date.parse(expiresAt) - now.getTime();
  if (Number.isNaN(ms) || ms <= 0) return "Expired";
  const days = Math.floor(ms / (24 * 60 * 60 * 1000));
  if (days >= 2) return `${days} days left`;
  const hours = Math.floor(ms / (60 * 60 * 1000));
  if (hours >= 1) return hours === 1 ? "1 hour left" : `${hours} hours left`;
  return "Expires within the hour";
}

// ---------------------------------------------------------------------------
// The link Taylor actually sends
// ---------------------------------------------------------------------------

/**
 * A `?join=` query on the app's own root, and deliberately not a path like
 * `/join/CODE`.
 *
 * The app is served from a subpath on GitHub Pages (`/infinity-windows/`) by a
 * static host with no rewrite rules. `…/infinity-windows/` is a real file that
 * always resolves; `…/infinity-windows/join` is not, and lands on GitHub's 404
 * unless a fallback page happens to be deployed. One is a blank page for a new
 * hire holding the only code he will ever be sent, so the link is built out of
 * the URL that cannot 404. A single-page 404.html fallback does now ship (#199)
 * and makes deep paths work in general; this deliberately does not depend on it,
 * because a stale cached fallback is indistinguishable from a broken new hire.
 *
 * No Supabase Auth redirect allow-listing is involved, because this is not an
 * auth callback: it is an ordinary page in the app that happens to carry a code.
 */
export const JOIN_QUERY_PARAM = "join";

export function buildInviteLink(appUrl: string, code: string): string {
  const clean = normalizeInviteCode(code);
  const base = appUrl.split("#")[0].split("?")[0];
  const withSlash = base.endsWith("/") ? base : `${base}/`;
  return `${withSlash}?${JOIN_QUERY_PARAM}=${encodeURIComponent(clean)}`;
}

/** Pull a code out of a link the person pasted, or out of `location.search`. */
export function readCodeFromUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  const match = new RegExp(`[?&]${JOIN_QUERY_PARAM}=([^&#]+)`).exec(url);
  if (!match) return null;
  let raw: string;
  try {
    raw = decodeURIComponent(match[1]);
  } catch {
    raw = match[1];
  }
  return looksLikeInviteCode(raw) ? normalizeInviteCode(raw) : null;
}

/**
 * The text message. Written to be readable in a notification preview, with the
 * link last so the tap target is not buried, and the code spelled out as well
 * so it survives a chat app that mangles URLs.
 */
export function inviteShareMessage(
  name: string,
  role: string,
  link: string,
  code: string,
): string {
  const who = name.trim().split(/\s+/)[0] || "there";
  const title = ROLE_TITLES[role as CrewRoleName] ?? role;
  return [
    `${who} — here's your login for the Infinity Windows app (${title}).`,
    ``,
    `Tap this and pick a password:`,
    link,
    ``,
    `If the link won't open, go to the app and enter code ${formatInviteCode(code)}`,
    `This expires in ${INVITE_TTL_DAYS} days.`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// What the crew member types
// ---------------------------------------------------------------------------

export const MIN_PASSWORD_LENGTH = 8;

/**
 * Length only, and nothing else.
 *
 * Supabase's own floor is 6; 8 is a small, real improvement. What is
 * deliberately absent is a character-class rule ("one capital, one symbol"),
 * because for someone standing on a roof in gloves those rules produce
 * `Winter2026!` written on the inside of a hard hat, which is worse than a
 * long thing they can actually remember. Length is the property that helps.
 */
export function validateInvitePassword(
  password: unknown,
  confirm?: unknown,
): { ok: boolean; error?: string } {
  if (typeof password !== "string" || password.length === 0) {
    return { ok: false, error: "Pick a password." };
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    return {
      ok: false,
      error: `Make it at least ${MIN_PASSWORD_LENGTH} characters.`,
    };
  }
  if (confirm !== undefined && password !== confirm) {
    return { ok: false, error: "Those two passwords don't match." };
  }
  return { ok: true };
}

/**
 * Turn a name into the login they will type. Taylor is asked for a real email
 * where he has one, but a lot of installers do not have one they can recall on
 * a job site, so the app can mint a stable, obviously-internal address instead.
 * It is a USERNAME, never a mailbox: nothing in this project sends mail (there
 * is no SMTP sender configured), so an address that cannot receive is honest
 * about what it is rather than pretending.
 */
export const CREW_LOGIN_DOMAIN = "crew.infinitywindows.app";

export function crewLoginFromName(name: string, unique: string): string {
  const slug = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, ".")
    .replace(/^\.+|\.+$/g, "")
    .slice(0, 24);
  const stem = slug || "crew";
  return `${stem}.${unique.toLowerCase()}@${CREW_LOGIN_DOMAIN}`;
}

/** Is this address one we minted, i.e. one that can never receive mail? */
export function isMintedCrewLogin(email: string | null | undefined): boolean {
  return (email ?? "").toLowerCase().endsWith(`@${CREW_LOGIN_DOMAIN}`);
}
