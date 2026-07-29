// Which Supabase project are we actually talking to?
//
// Infinity Windows has exactly one shared Supabase project. A second project
// existed for a while and two people unknowingly worked against different
// databases — every write landed somewhere the other person could never see,
// with nothing in the app to say so. This module is the pure core behind the
// banner that makes that mismatch visible (see components/WrongProjectBanner).
//
// Which project counts as "the right one" is configurable via
// `VITE_EXPECTED_SUPABASE_PROJECT_REF`, for the case where someone is knowingly
// working against another project; unset, it stays the shared project.
//
// Browser-free on purpose: the URL comes in as a string so every branch
// (matching, mismatched, unset, self-hosted, malformed) is unit-testable.

/** The project we expect unless someone deliberately overrides it. */
export const DEFAULT_EXPECTED_PROJECT_REF = "czprjcskmzzagdztqonm";

/**
 * The project this app expects to be talking to. Defaults to the shared project
 * that `app/.env.example` pins; `VITE_EXPECTED_SUPABASE_PROJECT_REF` overrides it
 * for anyone deliberately working against a different project, so they can
 * silence the banner from their own `.env` instead of editing code.
 *
 * This only moves the goalposts for the warning. Which project the app actually
 * connects to is still `VITE_SUPABASE_URL`, and nothing here touches it.
 */
export const EXPECTED_PROJECT_REF = resolveExpectedRef(
  import.meta.env.VITE_EXPECTED_SUPABASE_PROJECT_REF as string | undefined,
);

/** What the configured `VITE_SUPABASE_URL` turned out to be. */
export type ProjectCheck =
  /** Connected to the shared project. Nothing to say. */
  | { status: "ok"; ref: string }
  /** A real Supabase project, but the wrong one. Warn loudly. */
  | { status: "mismatch"; ref: string }
  /** No URL configured — the app already reports this via `supabaseConfigured`. */
  | { status: "unset" }
  /** Not a hosted Supabase URL (localhost, self-hosted, or unparseable). */
  | { status: "unknown"; url: string };

/**
 * Pull the project ref out of a hosted Supabase URL — the subdomain in front of
 * `.supabase.co` (or `.supabase.in`). Returns null for anything else: an empty
 * value, a self-hosted/localhost URL, or a string that isn't a URL at all.
 */
export function parseProjectRef(url: string | undefined | null): string | null {
  if (!url) return null;
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return null;
  }
  const match = /^([a-z0-9-]+)\.supabase\.(co|in)$/i.exec(host);
  return match ? match[1].toLowerCase() : null;
}

/**
 * Normalise whatever `VITE_EXPECTED_SUPABASE_PROJECT_REF` was set to into a
 * project ref. Blank, missing or unrecognisable values fall back to the default
 * rather than disabling the guard — a fat-fingered env var must never quietly
 * turn the "wrong database" warning off. A whole Supabase URL is accepted too,
 * because that is what people paste.
 */
export function resolveExpectedRef(
  raw: string | undefined | null,
  fallback: string = DEFAULT_EXPECTED_PROJECT_REF,
): string {
  const value = raw?.trim();
  if (!value) return fallback;
  const fromUrl = parseProjectRef(value) ?? parseProjectRef(`https://${value}`);
  if (fromUrl) return fromUrl;
  const bare = value.toLowerCase();
  return /^[a-z0-9-]+$/.test(bare) ? bare : fallback;
}

/**
 * Decide whether the configured URL points at the shared project. Never throws
 * — a bad URL degrades to "unknown" so a typo can't take the app down.
 */
export function checkProject(
  url: string | undefined | null,
  expected: string = EXPECTED_PROJECT_REF,
): ProjectCheck {
  if (!url || !url.trim()) return { status: "unset" };
  const ref = parseProjectRef(url);
  if (!ref) return { status: "unknown", url };
  return ref === expected.toLowerCase()
    ? { status: "ok", ref }
    : { status: "mismatch", ref };
}

/**
 * The warning to show, or null when there is nothing to warn about. We stay
 * quiet for "unset" (the app already surfaces missing config) and for
 * "unknown" URLs, which are how local/self-hosted development legitimately runs.
 */
export function projectWarning(
  url: string | undefined | null,
  expected: string = EXPECTED_PROJECT_REF,
): { connected: string; expected: string } | null {
  const check = checkProject(url, expected);
  if (check.status !== "mismatch") return null;
  return { connected: check.ref, expected };
}
