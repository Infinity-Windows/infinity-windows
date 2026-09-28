// The top-bar clock badge (crew redesign K1.1, 2026-09-23): "Clocked in 7:02"
// on every screen while a shift is open, one tap to break or clock out.
//
// WHY: the new phone bar has no Clock tab — the clock's big button lives at
// the top of Work — so somebody three screens deep in a job page needed a way
// to their break and their clock-out that did not mean finding Work first.
// This is that way. It opens the SAME clock sheet the classic tab opened (the
// sheet owns the injury flag, the runaway-shift finish, the offline queue), so
// nothing about a punch forks. Renders nothing off the clock: the empty
// state's job is Start day, and that button is on Work.

import { useEffect, useState } from "react";
import { Coffee, Clock as ClockIcon } from "lucide-react";
import { useClock } from "../../lib/clockContext";
import { useT } from "../../lib/i18n";
import { shiftGuard } from "../../lib/shiftGuard";
import { formatClock } from "../../lib/timeclock";

/** "7:02 AM" as the phone's locale prints it. */
function clockInLabel(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

export function ClockBadge() {
  const t = useT();
  const clock = useClock();
  const shift = clock.shift;
  const ticking = Boolean(shift);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!ticking) return;
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(tick);
  }, [ticking]);

  if (!shift) return null;

  const onBreak = Boolean(shift.break_started_at);
  const guard = shiftGuard(shift, now);
  const inAt = clockInLabel(shift.clock_in_at);
  // Past the believable maximum the total stops being evidence of a working
  // day (lib/shiftGuard.ts) — say what is needed instead of a number.
  const needsFinish = guard.workedSeconds == null;
  const breakSeconds = shift.break_started_at
    ? Math.max(0, Math.floor((now - new Date(shift.break_started_at).getTime()) / 1000))
    : 0;

  const text = needsFinish
    ? t("clockBadge.finish")
    : onBreak
      ? `${t("clockBadge.break")} · ${formatClock(breakSeconds)}`
      : `${t("clockBadge.in", { time: inAt })} · ${formatClock(guard.workedSeconds ?? 0)}`;

  return (
    <button
      type="button"
      className={`clock-badge${onBreak ? " clock-badge--break" : ""}${needsFinish ? " clock-badge--finish" : ""}`}
      aria-label={onBreak ? t("clockBadge.a11yBreak") : t("clockBadge.a11y", { time: inAt })}
      onClick={clock.openClock}
      data-testid="clock-badge"
    >
      <span className="clock-badge-icon" aria-hidden>
        {onBreak ? <Coffee size={18} /> : <ClockIcon size={18} />}
      </span>
      <span className="clock-badge-text">{text}</span>
    </button>
  );
}
