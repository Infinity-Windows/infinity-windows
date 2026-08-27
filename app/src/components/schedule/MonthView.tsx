import {
  enumerateDays,
  monthGridRange,
  startOfMonthISO,
} from "../../lib/schedule/dates";
import { calendarColorStyle, jobHue } from "../../lib/schedule/jobHue";
import type { DayMemory } from "../../lib/schedule/dayMemory";
import type { ScheduleAssignment } from "../../lib/schedule/types";

interface Props {
  /** Any day in the month to render. */
  monthAnchor: string;
  todayISO: string;
  assignments: ScheduleAssignment[];
  conflictIds: Set<string>;
  /** This month's day-by-day memory (C2) — undefined/empty while it's
   * still loading; worked-chips simply don't render yet, same as any other
   * still-loading calendar data. */
  dayMemoryByDate: Map<string, DayMemory>;
  /** Tapping ANY day, past included, opens the day panel (C3) — the panel
   * itself offers "Edit crew" / "Schedule crew" for anything this used to
   * do by opening the editor directly. */
  onOpenDay: (day: string) => void;
}

const WEEKDAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export function MonthView({
  monthAnchor,
  todayISO,
  assignments,
  conflictIds,
  dayMemoryByDate,
  onOpenDay,
}: Props) {
  const monthISO = startOfMonthISO(monthAnchor);
  const { from, to } = monthGridRange(monthISO);
  const days = enumerateDays(from, to);
  const currentMonth = monthISO.slice(0, 7);

  return (
    <div className="sched-month">
      <div className="sched-month-weekdays">
        {WEEKDAY_LABELS.map((w) => (
          <span key={w}>{w}</span>
        ))}
      </div>
      <div className="sched-month-grid">
        {days.map((day) => {
          const dayItems = assignments.filter(
            (a) => a.start_date <= day && a.end_date >= day,
          );
          const inMonth = day.slice(0, 7) === currentMonth;
          const isToday = day === todayISO;
          // Worked-chips (tinted, jobHue) are a PAST day's cell earning
          // proof of who actually showed — a live/future day has no
          // punches to be honest about yet.
          const isPast = day < todayISO;
          const workedJobs = isPast
            ? (dayMemoryByDate.get(day)?.jobs.filter((j) => j.worked.length > 0) ?? [])
            : [];
          return (
            <button
              key={day}
              className={`sched-month-cell${inMonth ? "" : " is-dim"}${isToday ? " is-today" : ""}`}
              onClick={() => onOpenDay(day)}
            >
              <span className="sched-month-daynum">{Number(day.slice(-2))}</span>
              <span className="sched-month-dots">
                {dayItems.slice(0, 4).map((a) => (
                  <span
                    key={a.id}
                    className={`sched-dot${a.status === "draft" ? " is-draft" : ""}${
                      // Shape carries what color no longer does for a
                      // delivery — it has no single job to be colored by.
                      a.kind === "delivery" ? " is-delivery" : ""
                    }${conflictIds.has(a.id) ? " is-conflict" : ""}`}
                    style={calendarColorStyle(a)}
                  />
                ))}
                {dayItems.length > 4 && (
                  <span className="sched-month-more">+{dayItems.length - 4}</span>
                )}
              </span>
              {workedJobs.length > 0 && (
                <span className="sched-month-worked">
                  {workedJobs.map((j) => (
                    <span
                      key={j.projectId}
                      className="sched-worked-chip"
                      style={{ "--job-hue": jobHue(j.projectId) } as React.CSSProperties}
                    >
                      {j.jobCode}
                    </span>
                  ))}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
