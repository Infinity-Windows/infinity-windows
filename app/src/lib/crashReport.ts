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

import { formatApiError, rawErrorMessage } from "./errors";
import { captureCrash } from "./monitoring/sentry";
import { supabase, supabaseConfigured } from "./supabase";

/**
 * What to call a thrown thing that is NOT an Error.
 *
 * `String(err)` is the shape this repo forbids (CLAUDE.md): a plain thrown
 * payload stringifies to "[object Object]", which would give every one of them
 * the same digest and tell whoever reads the report nothing at all.
 * rawErrorMessage digs a message out of a Supabase-shaped payload, and
 * formatApiError is the fallback sentence when there is nothing to dig out.
 */
function describeThrowable(error: unknown): string {
  return rawErrorMessage(error) || formatApiError(error);
}

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
  const seed = `${err?.name ?? typeof error}|${err?.message ?? describeThrowable(error)}|${firstFrame}`;
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
 * How every automatically-filed crash row begins.
 *
 * The row is inserted as the crashing crew member — RLS requires it — so it
 * lands in the "Your reports" list of somebody who never wrote it, under an
 * English headline and a JavaScript stack trace. A Spanish-reading installer
 * would find it there and have no idea what it was.
 *
 * There is no column that says "the app filed this", and adding one is a
 * migration, so the opening sentence is the marker: Suggestions.tsx keeps
 * these off the crew's own list and shows them only to the owners, who are the
 * people the stack is for. Both sides read this one constant so they cannot
 * drift apart.
 */
export const CRASH_REPORT_OPENING =
  "A screen crashed and this report was sent automatically.";

/** True for a row this app filed itself rather than one a person wrote. */
export function isAutoFiledCrashReport(body: string | null | undefined): boolean {
  return typeof body === "string" && body.startsWith(CRASH_REPORT_OPENING);
}

/**
 * The app_feedback row body: plain words first (the reporter sees this row in
 * their own suggestions tab), then the technical trail for whoever fixes it.
 *
 * ENGLISH ONLY, by decision — unlike the crash SCREEN, which is translated.
 * This text is written once and stored forever, and the person who acts on it
 * is the owner reading the suggestions list. A row whose language depended on
 * whichever phone crashed would give him half a bug list he cannot read.
 */
export function buildCrashReportBody(
  error: unknown,
  componentStack: string | null | undefined,
  path: string,
): string {
  const digest = crashDigest(error);
  const err = error instanceof Error ? error : null;
  const headline = err ? `${err.name}: ${err.message}` : describeThrowable(error);
  const stack = (err?.stack ?? "")
    .split("\n")
    .slice(0, 8)
    .join("\n")
    .trim();
  const components = (componentStack ?? "").trim().split("\n").slice(0, 12).join("\n");
  const body = [
    `${CRASH_REPORT_OPENING} Code ${digest}, on ${path}.`,
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
  // The crash monitor, when one is configured. It gets the SAME five-character
  // code as a tag, so "it says K7F3Q" finds the report there too. With no DSN
  // this returns false without loading anything at all. It is fired off rather
  // than awaited: the app_feedback row below must not wait on somebody else's
  // server, least of all on a phone with no signal.
  void captureCrash(error, componentStack, digest);
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
