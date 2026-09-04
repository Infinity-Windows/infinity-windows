// "You're 14 miles from Mad Moose — switch to Travel?" (Wave K, K1).
//
// WHY THIS EXISTS (transcripts grill, 2026-09-03, Q6a): the honest failure of a
// day is not somebody cheating, it is somebody driving to the supply house at
// 2pm with the clock still charging the job they left. Nobody remembers to
// switch. So the app asks — once, when it is brought to the foreground, and only
// when it can actually SEE that the phone is nowhere near the job.
//
// Three laws this file exists to keep:
//   1. FOREGROUND ONLY. There is no background location in this app and there
//      must not be. The check runs when a person opens the app, never on a
//      timer, never while it is closed.
//   2. SILENT WHEN UNSURE. `farFromJob()` (lib/jobProximity.ts) already refuses
//      to say "far" without a real fix, a real reference point, and enough
//      accuracy to tell them apart. Everything here inherits that: a missing
//      anything means no prompt, not a guess.
//   3. NEVER BLOCKS. The prompt is a question with two answers, and "I'm still
//      here" is a legitimate one — a shop day, a staging yard, a bad address on
//      a brand-new job. It holds the question for an hour and the clock keeps
//      running either way.
//
// Pure on purpose: the decision is tested here with fixtures, and the component
// only supplies today's inputs.

import { farFromJob, type DeviceFix, type LatLng } from "./jobProximity";

/** The seeded Travel cost code (20260717001000_time_clock.sql). */
export const TRAVEL_COST_CODE = "900";

/** How long "I'm still here" holds the question. */
export const STILL_HERE_HOLD_MS = 60 * 60 * 1000;

const METERS_PER_MILE = 1609.344;

/**
 * True when this cost code is JOB work rather than driving. Travel is the one
 * code the prompt must never fire on — a person already on Travel is doing
 * exactly what the prompt would ask them to do. An unknown/absent code is
 * treated as job work, because that is the state a normal install punch is in.
 */
export function isJobCostCode(code: string | null | undefined): boolean {
  return (code ?? "").trim() !== TRAVEL_COST_CODE;
}

/** The shape the decision needs off a shift — kept tiny so tests read clearly. */
export interface TravelPromptShift {
  status: string;
  project_id: string | null;
  cost_codes?: { code: string } | null;
}

export interface TravelPromptInput {
  shift: TravelPromptShift | null | undefined;
  /** The device's current fix, or null when we never got one. */
  myFix: DeviceFix | null | undefined;
  /** Where this job's clock-ins actually happen (getJobLastGeo). */
  jobGeo: LatLng | null | undefined;
  /** Epoch ms the "I'm still here" hold runs until, or null. */
  heldUntilMs?: number | null;
  now?: number;
}

/**
 * Should the app ask about switching to Travel right now?
 *
 * Every "no" is silent. The order below is the order of certainty: we need to
 * be on the clock, on a job (not Travel), not inside an hour we were already
 * told to hold, and only THEN does the distance question get asked at all.
 */
export function shouldAskAboutTravel(input: TravelPromptInput): boolean {
  const { shift, myFix, jobGeo, heldUntilMs, now = Date.now() } = input;
  if (!shift) return false;
  // 'needs_finish' is not on the clock — that person went home hours ago and
  // the app is asking them a different question entirely.
  if (shift.status !== "open") return false;
  if (!shift.project_id) return false;
  if (!isJobCostCode(shift.cost_codes?.code)) return false;
  if (heldUntilMs != null && Number.isFinite(heldUntilMs) && now < heldUntilMs) {
    return false;
  }
  return farFromJob(myFix, jobGeo ?? null);
}

/** Metres → miles. Miles because that is what a Utah crew says out loud. */
export function milesFromMeters(meters: number): number {
  return meters / METERS_PER_MILE;
}

/**
 * How far, said the way a person would say it: whole miles once you are past
 * one, one decimal below that (the "far" threshold is half a mile, so "0.6"
 * is a real answer and "0 miles" would be a lie), and never zero.
 */
export function describeMiles(miles: number): { value: string; one: boolean } {
  if (!Number.isFinite(miles) || miles <= 0) return { value: "0.1", one: false };
  if (miles < 1) {
    const tenths = Math.max(0.1, Math.round(miles * 10) / 10);
    return { value: tenths.toFixed(1), one: false };
  }
  const whole = Math.round(miles);
  return { value: String(whole), one: whole === 1 };
}

/** The localStorage key holding an "I'm still here" hold for one shift. */
export function holdKey(shiftId: string): string {
  return `forge:far-from-job-hold:${shiftId}`;
}
