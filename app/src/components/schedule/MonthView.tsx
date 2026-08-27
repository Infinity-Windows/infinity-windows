import {
  enumerateDays,
  monthGridRange,
  startOfMonthISO,
} from "../../lib/schedule/dates";
import { calendarColorStyle } from "../../lib/schedule/jobHue";
import type { ScheduleAssignment } from "../../lib/schedule/types";

interface Props {
  /** Any day in the month to render. */
  monthAnchor: string;
  todayISO: string;
  assignments: ScheduleAssignment[];
  conflictIds: Set<string>;
  onOpen: (a: ScheduleAssignment) => void;
  onCreate: (day: string) => void;
}

const WEEKDAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export function MonthView({
  monthAnchor,
  todayISO,
  assignments,
  conflictIds,
  onOpen,
  onCreate,
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
          return (
            <button
              key={day}
              className={`sched-month-cell${inMonth ? "" : " is-dim"}${isToday ? " is-today" : ""}`}
              onClick={() => (dayItems[0] ? onOpen(dayItems[0]) : onCreate(day))}
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
            </button>
          );
        })}
      </div>
    </div>
  );
}
