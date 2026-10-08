// Work's half of a Schedule-tab "Start work" tap (lib/work/scheduleStartWorkIntent.ts
// has the history half and why it exists).
//
// The rules, as the bounded safety review set them (2026-10-05):
//   - No intent: nothing here does anything. Work behaves exactly as before,
//     with no extra reads.
//   - An intent is read ONCE on mount and then removed from history (only our
//     key; the rest of the state, the search and the hash are kept), so a
//     reload, Back, another account or a design switch cannot replay it. The
//     phase it starts lives in this hook, so removing it from history never
//     lets first-job priming back in.
//   - While it is being checked, or after it failed, the strip primes
//     nothing and Start day does nothing; Work shows no job-specific
//     recommendation.
//   - Any shift the clock knows of — open, on break, queued on this phone,
//     waiting to be finished — wins: the intent is dropped and Work stays on
//     that shift. Nothing is checked until the clock is known.
//   - With no shift, the job is taken only from a FRESH read made after the
//     tap: the person's own published schedule (listMyPublished) and the job
//     list (listProjects), called directly — never a cached answer, never a
//     retry. Same real login and generation, same local day, no preview, one
//     published install of theirs, today, on a job in the list. Anything else
//     — offline, an error, a timeout, a malformed or someone else's intent —
//     says so and asks them to choose. It never falls back to the first job.
//   - Picking a job by hand ends it; a late answer is ignored. A change of
//     login, generation, preview or day while it is live turns it into
//     "choose".
// These reads authorize nothing: every punch still goes through the same
// clock-in path and the server's own checks.

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { listProjects } from "../../lib/api";
import { listMyPublished } from "../../lib/schedule/api";
import type { ScheduleAssignment } from "../../lib/schedule/types";
import { signInGeneration, signedInUserId, subscribeSignedIn } from "../../lib/signedIn";
import { useEffectiveRole } from "../../lib/useEffectiveRole";
import {
  hasScheduleStartWorkIntent,
  readScheduleStartWorkIntent,
  withoutScheduleStartWorkIntent,
  type CapturedIntent,
  type ScheduleStartWorkIntent,
} from "../../lib/work/scheduleStartWorkIntent";

/** How long the fresh check may take before it gives up and asks. */
export const VERIFY_TIMEOUT_MS = 15_000;

export type IntentPhase =
  | { kind: "none" }
  | { kind: "checking"; intent: ScheduleStartWorkIntent }
  | { kind: "choose" }
  | { kind: "selected"; assignmentId: string; projectId: string }
  /** The person picked a job by hand after a tap; that job is Work's context. */
  | { kind: "manual"; projectId: string };

export type IntentEvent =
  | { type: "shift" }
  | { type: "verified"; assignmentId: string; projectId: string }
  | { type: "failed" }
  | { type: "manual"; projectId: string }
  | { type: "invalidate" };

export function initialIntentPhase(captured: CapturedIntent): IntentPhase {
  if (captured.kind === "none") return { kind: "none" };
  if (captured.kind === "malformed") return { kind: "choose" };
  return { kind: "checking", intent: captured.intent };
}

export function nextIntentPhase(phase: IntentPhase, event: IntentEvent): IntentPhase {
  if (phase.kind === "none") return phase;
  switch (event.type) {
    case "shift":
      return { kind: "none" };
    case "verified":
      return phase.kind === "checking"
        ? { kind: "selected", assignmentId: event.assignmentId, projectId: event.projectId }
        : phase;
    case "failed":
      return phase.kind === "checking" ? { kind: "choose" } : phase;
    case "manual":
      return { kind: "manual", projectId: event.projectId };
    case "invalidate":
      // A hand pick made under the old login, preview, person or day is the
      // intent's too: it asks again rather than carrying over.
      return phase.kind === "choose" ? phase : { kind: "choose" };
  }
}

export type IntentRefusal =
  | "identity"
  | "preview"
  | "day"
  | "missing"
  | "duplicate"
  | "not-published"
  | "delivery"
  | "not-mine"
  | "not-today"
  | "unknown-project";

export interface VerifyInput {
  intent: ScheduleStartWorkIntent;
  signedInUserId: string | null;
  generation: number;
  profileId: string | null;
  isPreviewing: boolean;
  today: string;
  assignments: readonly ScheduleAssignment[];
  projects: readonly { id: string }[];
}

export type VerifyResult =
  | { ok: true; assignmentId: string; projectId: string }
  | { ok: false; reason: IntentRefusal };

/** Fail-closed check of an intent against fresh reads. Pure. */
export function verifyScheduleStartWorkIntent(input: VerifyInput): VerifyResult {
  const { intent } = input;
  const who = input.signedInUserId;
  if (!who || intent.ownerId !== who || input.profileId !== who || intent.generation !== input.generation) {
    return { ok: false, reason: "identity" };
  }
  if (input.isPreviewing) return { ok: false, reason: "preview" };
  if (intent.day !== input.today) return { ok: false, reason: "day" };
  const rows = input.assignments.filter((a) => a.id === intent.assignmentId);
  if (rows.length === 0) return { ok: false, reason: "missing" };
  if (rows.length > 1) return { ok: false, reason: "duplicate" };
  const a = rows[0];
  if (a.status !== "published") return { ok: false, reason: "not-published" };
  if (a.kind !== "install" || !a.project_id) return { ok: false, reason: "delivery" };
  if (!(a.members ?? []).some((m) => m.profile_id === who)) return { ok: false, reason: "not-mine" };
  if (!(a.start_date <= input.today && a.end_date >= input.today)) return { ok: false, reason: "not-today" };
  const projectId = a.project_id;
  if (!input.projects.some((p) => p.id === projectId)) return { ok: false, reason: "unknown-project" };
  return { ok: true, assignmentId: a.id, projectId };
}

/**
 * What Work should use as its job while an intent is live. `override: false`
 * means there is no intent (or it was dropped): Work's existing choice stands.
 */
export function intentJobContext(phase: IntentPhase): { override: false } | { override: true; jobId: string | null } {
  switch (phase.kind) {
    case "none":
      return { override: false };
    case "checking":
    case "choose":
      return { override: true, jobId: null };
    case "selected":
    case "manual":
      return { override: true, jobId: phase.projectId };
  }
}

/** The ClockStrip's view of the phase; null = behave exactly as before. */
export type ClockIntent = { kind: "checking" } | { kind: "choose" } | { kind: "selected"; projectId: string } | null;

export function clockIntentFor(phase: IntentPhase): ClockIntent {
  switch (phase.kind) {
    case "checking":
      return { kind: "checking" };
    case "choose":
      return { kind: "choose" };
    case "selected":
      return { kind: "selected", projectId: phase.projectId };
    default:
      return null;
  }
}

function todayLocalISO(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export interface ScheduleStartWorkInput {
  profileId: string | null;
  /** Any shift the clock knows of (open, break, queued, needs finish). */
  shift: unknown;
  clockKnown: boolean;
  today: string;
}

export function useScheduleStartWorkIntent({ profileId, shift, clockKnown, today }: ScheduleStartWorkInput) {
  const location = useLocation();
  const navigate = useNavigate();
  const [phase, setPhase] = useState<IntentPhase>(() => initialIntentPhase(readScheduleStartWorkIntent(location.state)));
  const attemptRef = useRef(0);

  // Remove ONLY our key from this history entry, once it has been read.
  useEffect(() => {
    if (!hasScheduleStartWorkIntent(location.state)) return;
    navigate(
      { pathname: location.pathname, search: location.search, hash: location.hash },
      { replace: true, state: withoutScheduleStartWorkIntent(location.state) },
    );
  }, [location, navigate]);

  const userId = useSyncExternalStore(subscribeSignedIn, signedInUserId, signedInUserId);
  const generation = useSyncExternalStore(subscribeSignedIn, signInGeneration, signInGeneration);
  const { isPreviewing, isLoading: roleLoading } = useEffectiveRole();

  const apply = useCallback((event: IntentEvent) => {
    attemptRef.current++;
    setPhase((p) => nextIntentPhase(p, event));
  }, []);

  // Login, generation, preview, person or day moved while live: ask instead.
  // The person (profileId) is part of it because a person preview changes it
  // even when isPreviewing does not move. Its first arrival (unknown → known,
  // the profile read answering after mount) is not a move; any later change,
  // to another person or back to unknown, is.
  const contextKey = `${userId ?? ""}|${generation}|${isPreviewing ? 1 : 0}|${today}`;
  const contextRef = useRef<{ key: string; profileId: string | null }>({ key: contextKey, profileId });
  useEffect(() => {
    const prev = contextRef.current;
    const moved = prev.key !== contextKey || (prev.profileId !== null && prev.profileId !== profileId);
    contextRef.current = { key: contextKey, profileId };
    if (moved) apply({ type: "invalidate" });
  }, [contextKey, profileId, apply]);

  // A shift wins.
  useEffect(() => {
    if (clockKnown && shift) apply({ type: "shift" });
  }, [clockKnown, shift, apply]);

  // The fresh check: one attempt per settled context, never cached.
  const checking = phase.kind === "checking" ? phase.intent : null;
  useEffect(() => {
    if (!checking || !clockKnown || shift || !profileId || roleLoading) return;
    const attempt = ++attemptRef.current;
    let live = true;
    const settle = (event: IntentEvent) => {
      if (!live || attemptRef.current !== attempt) return;
      live = false;
      apply(event);
    };
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      settle({ type: "failed" });
      return;
    }
    const timer = setTimeout(() => settle({ type: "failed" }), VERIFY_TIMEOUT_MS);
    // strictRemote: a missing table must fail the check, never be answered
    // from this browser's local draft store or as "no time off".
    void Promise.all([listMyPublished(profileId, checking.day, checking.day, { strictRemote: true }), listProjects()]).then(
      ([assignments, projects]) => {
        const result = verifyScheduleStartWorkIntent({
          intent: checking,
          signedInUserId: signedInUserId(),
          generation: signInGeneration(),
          profileId,
          // A preview that starts meanwhile also invalidates (contextKey), which
          // ends this attempt before its answer can land.
          isPreviewing,
          today: todayLocalISO(),
          assignments: assignments ?? [],
          projects: projects ?? [],
        });
        settle(result.ok ? { type: "verified", assignmentId: result.assignmentId, projectId: result.projectId } : { type: "failed" });
      },
      () => settle({ type: "failed" }),
    );
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [checking, clockKnown, shift, profileId, roleLoading, isPreviewing, apply]);

  const onExplicitProjectChoice = useCallback((projectId: string) => apply({ type: "manual", projectId }), [apply]);

  return { phase, onExplicitProjectChoice };
}
