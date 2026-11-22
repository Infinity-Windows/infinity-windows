import { useQueryClient } from "@tanstack/react-query";
import { useClock } from "./clockContext";
import { readWorkQueue, stopWorkForClock } from "./customWork/queue";
import type { WorkSession } from "./customWork/model";
import { captureGeoSoft } from "./geo";
import { enqueueBreakStart, enqueueBreakStop, enqueueClockOut } from "./offline/outbox";
import { isNetworkError } from "./offline/outbox-core";
import {
  clockOut, currentBreakSeconds, endBreak, isPendingShiftRef, mintPunch, startBreak,
  type BreakType, type TimeShift,
} from "./timeclock";

/** How a punch was saved: sent now, or kept on the phone to send with signal. */
export type ShiftPunchResult = { queued: boolean };

export type ClockOutAnswers = { injured: boolean; injuryNote: string; timeWrong: boolean };

/**
 * Break, resume and clock out on the open shift, for a screen that draws its
 * own controls instead of opening the clock sheet (Workday's timer; Matt,
 * 2026-11-20).
 *
 * These are the clock sheet's three punches, rule for rule
 * (components/clock/ClockSheet.tsx: doBreakStart, doBreakEnd, doClockOut):
 * the punch is stamped at the tap; running work is stopped first and the punch
 * queues behind it; a punch on a clock-in still on the phone queues behind
 * that; a network failure queues instead of failing. A change to those rules
 * belongs in both places.
 */
export function useShiftPunches() {
  const queryClient = useQueryClient();
  const { profileId, shift, pending, refresh } = useClock();

  const refreshShift = () => {
    void queryClient.invalidateQueries({ queryKey: ["openShift"] });
    void queryClient.invalidateQueries({ queryKey: ["myShifts"] });
    void queryClient.invalidateQueries({ queryKey: ["recentJobs"] });
    refresh();
  };
  const showNow = (next: TimeShift | null) => {
    queryClient.setQueryData(["openShift", profileId], next);
    refresh();
  };
  const stopWorkFirst = (at: string) => {
    if (!profileId) throw new Error("Sign in again before changing your work clock.");
    const sessions = queryClient.getQueryData<WorkSession[]>(["customWorkSessions", profileId, "mine"]) ?? [];
    if (!sessions.some(session => !session.ended_at) && !readWorkQueue(profileId).length) return Promise.resolve(false);
    return stopWorkForClock(profileId, sessions, at, pending ? [pending.entryId] : []);
  };
  const open = () => {
    if (!shift) throw new Error("You are not clocked in.");
    return shift;
  };

  return {
    async breakStart(type: BreakType): Promise<ShiftPunchResult> {
      const current = open();
      const punch = mintPunch();
      const waitsForWork = await stopWorkFirst(punch.tappedAt);
      if (navigator.onLine && !waitsForWork && !isPendingShiftRef(current.id)) {
        try {
          await startBreak(current.id, type, punch);
          void queryClient.invalidateQueries({ queryKey: ["myActivePhases"] });
          refreshShift();
          return { queued: false };
        } catch (e) {
          if (!isNetworkError(e)) throw e;
        }
      }
      await enqueueBreakStart(current.id, type, punch);
      showNow({ ...current, break_started_at: punch.tappedAt, break_type: type });
      void queryClient.invalidateQueries({ queryKey: ["myActivePhases"] });
      return { queued: true };
    },

    async breakEnd(): Promise<ShiftPunchResult> {
      const current = open();
      const punch = mintPunch();
      if (navigator.onLine && !isPendingShiftRef(current.id)) {
        try {
          await endBreak(current.id, punch);
          refreshShift();
          return { queued: false };
        } catch (e) {
          if (!isNetworkError(e)) throw e;
        }
      }
      await enqueueBreakStop(current.id, punch);
      showNow({
        ...current,
        break_seconds: currentBreakSeconds(current, Date.parse(punch.tappedAt)),
        break_started_at: null,
        break_type: null,
      });
      return { queued: true };
    },

    async clockOut({ injured, injuryNote, timeWrong }: ClockOutAnswers): Promise<ShiftPunchResult> {
      const current = open();
      // A break still running ends at the tap too, with the punch, not after
      // the location wait, which would count those seconds as break.
      const tapMs = Date.now();
      const punch = mintPunch(null, tapMs);
      const breakSeconds = currentBreakSeconds(current, tapMs);
      const waitsForWork = await stopWorkFirst(punch.tappedAt);
      const geo = navigator.onLine && !waitsForWork ? await captureGeoSoft() : {};
      if (navigator.onLine && !waitsForWork && !isPendingShiftRef(current.id)) {
        try {
          await clockOut(current.id, { injured, injuryNote, timeConfirmed: !timeWrong, breakSeconds, geo }, punch);
          refreshShift();
          return { queued: false };
        } catch (e) {
          if (!isNetworkError(e)) throw e;
        }
      }
      await enqueueClockOut({
        shiftRef: current.id,
        injured,
        injuryNote: injured ? injuryNote.trim() || null : null,
        timeConfirmed: !timeWrong,
        breakSeconds,
        lat: geo?.lat ?? null,
        lng: geo?.lng ?? null,
        punch,
      });
      showNow(null);
      return { queued: true };
    },
  };
}
