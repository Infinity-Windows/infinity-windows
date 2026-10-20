import type { TimeShift } from "./timeclock";
import { SHIFT_CAP_SECONDS, shiftGuard } from "./shiftGuard";

export interface ClockReadState {
  status: "checking" | "verified" | "saved" | "unavailable";
  recoveryRequired: boolean;
  checking: boolean;
}

export const CLOCK_READ_TIMEOUT_MS = 15_000;
export const CLOCK_READ_MAX_AGE_MS = 5 * 60_000;

/** A local cache write is not evidence that Forge answered this clock read. */
export function clockReadFingerprint(shift: TimeShift | null | undefined): string {
  return shift === undefined ? "unknown" : JSON.stringify(shift === null ? null : [
    shift.id, shift.profile_id, shift.clock_in_at, shift.clock_out_at,
    shift.status, shift.break_started_at, shift.break_seconds,
    shift.project_id, shift.cost_code_id,
  ]);
}

export function savedShiftIsPlausible(shift: TimeShift | null | undefined, now: number): boolean {
  if (!shift || shift.status !== "open" || shift.clock_out_at) return false;
  const start = new Date(shift.clock_in_at);
  const ms = start.getTime();
  if (!Number.isFinite(ms) || ms > now || now - ms >= SHIFT_CAP_SECONDS * 1000) return false;
  return start.toDateString() === new Date(now).toDateString() && shiftGuard(shift, now).workedSeconds != null;
}

export function clockReadState(input: {
  shift: TimeShift | null | undefined;
  profileId: string | null;
  actorMatches: boolean;
  checking: boolean;
  verified: boolean;
  recentVerifiedNull: boolean;
  /** Explicit stored null, after the owned queue was applied; never missing data. */
  savedNull?: boolean;
  queueHasState: boolean;
  now: number;
}): ClockReadState {
  const { shift, checking } = input;
  const owned = !shift || shift.profile_id === input.profileId;
  if (input.actorMatches && owned) {
    if (input.verified) return { status: "verified", recoveryRequired: false, checking };
    // This phone's actual saved punch remains usable offline. A queued-out
    // is evidence too; an unrelated queued break/out is not.
    if ((input.queueHasState && (!shift || savedShiftIsPlausible(shift, input.now))) ||
        savedShiftIsPlausible(shift, input.now) || (!shift && input.recentVerifiedNull) ||
        (shift === null && input.savedNull)) {
      return { status: "saved", recoveryRequired: false, checking };
    }
  }
  return { status: checking ? "checking" : "unavailable", recoveryRequired: true, checking };
}
