// "You're 14 miles from Mad Moose. Switch to Travel?" (Wave K, K1 + K3.)
//
// Mounted once, by the clock provider, so it rides every screen the way the
// clock sheet does. It does two things when the app comes to the FOREGROUND
// while somebody is on the clock:
//
//   1. Stamps their own open shift with "the app was open, here, just now"
//      (touch_shift_location — K3), which is what the supervisor's "Still on
//      the clock" list reads back.
//   2. If it can SEE that the phone is nowhere near where this job's clock-ins
//      happen, asks the one question worth asking: switch to Travel?
//
// There is NO background location here and there must not be. The check runs on
// mount and on `visibilitychange`, from a fix the phone had already granted —
// it never raises a permission prompt of its own (captureGeoIfGranted).
//
// The decision itself is pure and tested in lib/farFromJob.ts. This file is the
// wiring and the sheet.

import { useCallback, useEffect, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { ArrowLeftRight, X } from "lucide-react";
import {
  captureGeoIfGranted,
  captureGeoSoft,
  type GeoFix,
  type GrantedFix,
} from "../../lib/geo";
import { haversineMeters } from "../../lib/jobProximity";
import {
  STILL_HERE_HOLD_MS,
  describeMiles,
  holdKey,
  milesFromMeters,
  shouldAskAboutTravel,
} from "../../lib/farFromJob";
import {
  clockIn,
  getJobLastGeo,
  getTravelCostCode,
  isOnTheClock,
  touchShiftLocation,
  type TimeShift,
} from "../../lib/timeclock";
import { toastError, toastSuccess } from "../../lib/toast";
import { useT } from "../../lib/i18n";

/** localStorage, but a private window or a locked-down browser can throw. */
function readHold(shiftId: string): number | null {
  try {
    const raw = window.localStorage.getItem(holdKey(shiftId));
    const n = raw ? Number(raw) : Number.NaN;
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

function writeHold(shiftId: string, untilMs: number): void {
  try {
    window.localStorage.setItem(holdKey(shiftId), String(untilMs));
  } catch {
    /* a hold we cannot store just means the question may come back */
  }
}

export function FarFromJobPrompt({
  shift,
  onChanged,
}: {
  shift: TimeShift | null;
  onChanged: () => void;
}) {
  const t = useT();
  const [asking, setAsking] = useState(false);
  const [metersAway, setMetersAway] = useState<number | null>(null);
  /** The fix the check ran on, reused if they tap Switch. */
  const fixRef = useRef<GrantedFix | null>(null);
  /** Guards a check already in flight — foregrounding can fire twice. */
  const runningRef = useRef(false);

  const shiftId = shift?.id ?? null;
  const projectId = shift?.project_id ?? null;
  const onClock = isOnTheClock(shift);

  const check = useCallback(async () => {
    if (!shift || !shiftId || !projectId || !isOnTheClock(shift)) return;
    if (runningRef.current) return;
    runningRef.current = true;
    try {
      const fix = await captureGeoIfGranted();
      fixRef.current = fix;
      // The stamp goes in either way: "they had the app open at 4:12" is true
      // and useful even when the phone would not say where.
      await touchShiftLocation(fix?.lat ?? null, fix?.lng ?? null);
      if (!fix) return;

      let jobGeo: { lat: number; lng: number } | null = null;
      try {
        jobGeo = await getJobLastGeo(projectId);
      } catch {
        // No reference point, no opinion. Silence is the safe answer.
        return;
      }
      const ask = shouldAskAboutTravel({
        shift,
        myFix: fix,
        jobGeo,
        heldUntilMs: readHold(shiftId),
      });
      if (ask && jobGeo) {
        setMetersAway(haversineMeters(fix, jobGeo));
        setAsking(true);
      }
    } finally {
      runningRef.current = false;
    }
  }, [shift, shiftId, projectId]);

  // On mount, and every time the app is brought back to the foreground. Not a
  // timer: an app in somebody's pocket must not be checking where they are.
  useEffect(() => {
    if (!onClock) {
      setAsking(false);
      return;
    }
    void check();
    const onVisible = () => {
      if (document.visibilityState === "visible") void check();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [onClock, check]);

  const hold = useCallback(() => {
    if (shiftId) writeHold(shiftId, Date.now() + STILL_HERE_HOLD_MS);
    setAsking(false);
  }, [shiftId]);

  // The existing switch path, exactly: clock_in again on the SAME job with the
  // Travel code, which auto-closes the current punch so there is no gap. The
  // worker's note and the job mode ride along so nothing about the day is lost.
  const switchToTravel = useMutation({
    mutationFn: async () => {
      const travel = await getTravelCostCode();
      if (!travel) {
        throw new Error(
          "There's no Travel cost code set up, so this can't switch for you.",
        );
      }
      // A fresh fix if there is one — the punch's own geo should be where the
      // switch happened, not where the check ran a moment ago. captureGeoSoft
      // resolves to {} rather than null when it has nothing, so the fallback
      // tests the coordinates, not the object.
      const fresh = await captureGeoSoft();
      const geo: GeoFix =
        fresh.lat != null ? fresh : (fixRef.current ?? {});
      await clockIn(
        shift!.project_id,
        travel.id,
        geo,
        shift!.note ?? null,
        shift!.job_mode ?? null,
      );
    },
    onSuccess: () => {
      toastSuccess(t("farjob.switched"));
      setAsking(false);
      onChanged();
    },
    onError: (e) => toastError(e),
  });

  if (!asking || !shift) return null;

  const jobName =
    shift.projects?.name || shift.projects?.job_code || t("clock.noJob");
  const miles = describeMiles(milesFromMeters(metersAway ?? 0));
  const body = t(miles.one ? "farjob.bodyOneMile" : "farjob.bodyMiles", {
    miles: miles.value,
    job: jobName,
  });

  return (
    <div className="clock-sheet-backdrop" onClick={hold} role="presentation">
      <div
        className="clock-sheet"
        role="dialog"
        aria-modal="true"
        aria-label={t("farjob.title")}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="clock-sheet-grip" aria-hidden />
        <div className="clock-sheet-head">
          <h2 className="clock-sheet-title">{t("farjob.title")}</h2>
          <button
            type="button"
            className="clock-sheet-x"
            onClick={hold}
            aria-label={t("clock.a11y.close")}
          >
            <X size={18} />
          </button>
        </div>
        <div className="clock-sheet-body">
          <p className="clock-pick-summary">{body}</p>
          <button
            type="button"
            className="clock-btn primary big"
            disabled={switchToTravel.isPending}
            onClick={() => switchToTravel.mutate()}
          >
            {switchToTravel.isPending ? (
              t("clock.action.switching")
            ) : (
              <>
                <ArrowLeftRight size={18} aria-hidden /> {t("farjob.switch")}
              </>
            )}
          </button>
          <button
            type="button"
            className="clock-cancel"
            disabled={switchToTravel.isPending}
            onClick={hold}
          >
            {t("farjob.stillHere")}
          </button>
          <p className="muted clock-switch-note">{t("farjob.note")}</p>
        </div>
      </div>
    </div>
  );
}
