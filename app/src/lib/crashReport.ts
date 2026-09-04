// When the ErrorBoundary catches a render crash, the screen it replaced is
// usually a phone on a jobsite — nobody is watching the console. The wave-M
// TDZ crash in JobMaterials shipped invisible for exactly that reason: the
// boundary said "Something went wrong" and the only evidence went to a
// devtools pane no installer will ever open. This module gives a crash two
// ways out of the field:
//
//   - a short DIGEST the crew can read out loud over the phone, shown on the
//     crash screen and stamped on every log line and report, so "it says
//     K7F3Q" is enough to find the matching stack, and
//   - a fire-and-forget bug row on the owners' suggestions list
//     (app_feedback), so field crashes surface where app problems already do.
//
// Reporting a crash must never crash: everything here swallows its own
// failures, and a device that is offline or signed out simply skips the
// upload — the console line and the on-screen digest still happen.

import { supabase, supabaseConfigured } from "./supabase";

/**
 * Crockford base32: no I, L, O, or U, so the code survives being read out
 * loud on a bad connection and typed back by whoever answered the phone.
 */
const DIGEST_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const DIGEST_LENGTH = 5;

/** app_feedback.body has a CHECK of at most 2000 chars; stay under it. */
const MAX_BODY = 2000;

/**
 * Short code identifying one crash site: same error at the same place gives
 * the same code (within one build — minified frame names shift between
 * builds, and that is fine; the code only has to match the console and the
 * report rows it was born with).
 */
export function crashDigest(error: unknown): string {
  const err = error instanceof Error ? error : null;
  const firstFrame =
    err?.stack
      ?.split("\n")
      .map((l) => l.trim())
      .find((l) => l.startsWith("at ") || l.includes("@")) ?? "";
  const seed = `${err?.name ?? typeof error}|${err?.message ?? String(error)}|${firstFrame}`;
  // FNV-1a, 32-bit — tiny, deterministic, and plenty for telling a handful
  // of distinct crash sites apart.
  let hash = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  hash >>>= 0;
  let code = "";
  for (let i = 0; i < DIGEST_LENGTH; i++) {
    code = DIGEST_ALPHABET[hash % 32] + code;
    hash = Math.floor(hash / 32);
  }
  return code;
}

/**
 * The app_feedback row body: plain words first (the reporter sees this row in
 * their own suggestions tab), then the technical trail for whoever fixes it.
 */
export function buildCrashReportBody(
  error: unknown,
  componentStack: string | null | undefined,
  path: string,
): string {
  const digest = crashDigest(error);
  const err = error instanceof Error ? error : null;
  const headline = err ? `${err.name}: ${err.message}` : String(error);
  const stack = (err?.stack ?? "")
    .split("\n")
    .slice(0, 8)
    .join("\n")
    .trim();
  const components = (componentStack ?? "").trim().split("\n").slice(0, 12).join("\n");
  const body = [
    `A screen crashed and this report was sent automatically. Code ${digest}, on ${path}.`,
    headline,
    stack && stack !== headline ? stack : "",
    components ? `Component stack:\n${components}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
  return body.length > MAX_BODY ? body.slice(0, MAX_BODY) : body;
}

/** One report per crash site per page load — a Try-again loop must not spam. */
const reported = new Set<string>();

/** Test-only: forget which digests this page load already reported. */
export function resetCrashReportsForTest(): void {
  reported.clear();
}

/**
 * Log the crash where a developer will find it and file it where an owner
 * will. Never throws, never rejects; the boundary calls this from
 * componentDidCatch and must be able to fire-and-forget it.
 */
export async function reportCrash(
  error: unknown,
  componentStack: string | null | undefined,
): Promise<void> {
  const digest = crashDigest(error);
  // The console line carries the full objects — the digest is what ties a
  // read-out-loud code back to this exact line.
  console.error(`App crashed [${digest}]`, error, componentStack ?? "");
  if (reported.has(digest)) return;
  reported.add(digest);
  if (!supabaseConfigured) return;
  try {
    // getSession reads local storage — no network, so it cannot hang the
    // crash screen. Signed out means RLS would refuse the insert anyway.
    const { data } = await supabase.auth.getSession();
    const userId = data.session?.user?.id;
    if (!userId) return;
    const body = buildCrashReportBody(error, componentStack, window.location.pathname);
    await supabase.from("app_feedback").insert({ author: userId, kind: "bug", body });
  } catch {
    // A crash reporter that throws takes the crash screen down with it.
  }
}
