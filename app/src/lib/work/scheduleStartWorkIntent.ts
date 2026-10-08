// Which scheduled job a Schedule-tab "Start work" tap was about.
//
// The Schedule tab lists every job a person has today, each with its own
// Start work, and they all used to be a bare link to "/" — so Work could not
// tell which one was tapped and primed the clock strip with the FIRST of the
// day (e2e schedule-start-work.spec.ts, 2026-10-05: Start work on BLACK22 at
// 10:00 landed on OAKRIDGE at 07:00).
//
// The tap now carries an intent in browser history state, under one
// namespaced key: the assignment, who was signed in (the REAL login and its
// generation, lib/signedIn.ts — never a previewed person) and the local day.
// It names an assignment only. Work never trusts a project id or label from
// history; it re-reads the person's own published schedule and the job list
// and takes the project from those (pages/work/useScheduleStartWorkIntent.ts).
//
// This file is imported by App's landing (to drop an intent the classic
// design would otherwise leave sitting in history), so it stays tiny and
// imports nothing at runtime.

import type { SignInMark } from "../signedIn";

/** The one key this feature owns inside history state. */
export const SCHEDULE_START_WORK_KEY = "forgeScheduleStartWork";

export interface ScheduleStartWorkIntent {
  readonly v: 1;
  readonly assignmentId: string;
  /** The real signed-in auth id at the tap ("" when nobody was — fails closed). */
  readonly ownerId: string;
  /** lib/signedIn generation at the tap. */
  readonly generation: number;
  /** The tap's local day, YYYY-MM-DD. */
  readonly day: string;
}

/** The history state a Start work tap carries. Always an intent, so a tap
 * that cannot be tied to a sign-in still fails closed instead of priming the
 * first job. */
export function makeScheduleStartWorkState(
  assignmentId: string,
  day: string,
  mark: SignInMark,
): Record<string, ScheduleStartWorkIntent> {
  return {
    [SCHEDULE_START_WORK_KEY]: {
      v: 1,
      assignmentId,
      ownerId: mark.userId ?? "",
      generation: mark.generation,
      day,
    },
  };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Is there anything under our key at all (well-formed or not)? */
export function hasScheduleStartWorkIntent(state: unknown): boolean {
  return isRecord(state) && Object.prototype.hasOwnProperty.call(state, SCHEDULE_START_WORK_KEY);
}

export type CapturedIntent =
  | { kind: "none" }
  | { kind: "intent"; intent: ScheduleStartWorkIntent }
  /** Something is under our key but it is not an intent this build wrote. */
  | { kind: "malformed" };

export function readScheduleStartWorkIntent(state: unknown): CapturedIntent {
  if (!hasScheduleStartWorkIntent(state)) return { kind: "none" };
  const raw = (state as Record<string, unknown>)[SCHEDULE_START_WORK_KEY];
  if (!isRecord(raw)) return { kind: "malformed" };
  const { v, assignmentId, ownerId, generation, day } = raw;
  if (
    v !== 1 ||
    typeof assignmentId !== "string" || assignmentId === "" ||
    typeof ownerId !== "string" ||
    typeof generation !== "number" || !Number.isFinite(generation) ||
    typeof day !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(day)
  ) {
    return { kind: "malformed" };
  }
  return { kind: "intent", intent: { v: 1, assignmentId, ownerId, generation, day } };
}

/**
 * May App's landing drop an intent because this person is KNOWN to be on the
 * classic screens? Mirrors lib/design's resolveDesign: the owner's switch
 * being off, or the person's own choice being classic, each settles it on
 * its own. Neither known (the provisional classic shown while the design
 * loads) keeps the intent, so a new-design person's tap is not lost.
 */
export function classicDesignSettled(d: { choice: string | null | undefined; masterOn: boolean | null | undefined }): boolean {
  return d.masterOn === false || d.choice === "classic";
}

/** History state with ONLY our key removed; everything else kept as it was.
 * Null when nothing else was there. */
export function withoutScheduleStartWorkIntent(state: unknown): unknown {
  if (!hasScheduleStartWorkIntent(state)) return state;
  const rest: Record<string, unknown> = { ...(state as Record<string, unknown>) };
  delete rest[SCHEDULE_START_WORK_KEY];
  return Object.keys(rest).length > 0 ? rest : null;
}
