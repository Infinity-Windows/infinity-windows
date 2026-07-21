import { Plus } from "lucide-react";
import {
  addDaysISO,
  agendaDayLabel,
  enumerateDays,
  formatStartTime,
} from "../../lib/schedule/dates";
import { assignmentColor } from "../../lib/schedule/color";
import type { ScheduleAssignment } from "../../lib/schedule/types";

interface Props {
  weekStart: string;
  todayISO: string;
  assignments: ScheduleAssignment[];
  conflictIds: Set<string>;
  onOpen: (a: ScheduleAssignment) => void;
  onCreate: (day: string) => void;
}

export function WeekView({
  weekStart,
  todayISO,
  assignments,
  conflictIds,
  onOpen,
  onCreate,
}: Props) {
  const days = enumerateDays(weekStart, addDaysISO(weekStart, 6));

  return (
    <div className="sched-week" role="list">
      {days.map((day) => {
        const dayItems = assignments.filter(
          (a) => a.start_date <= day && a.end_date >= day,
        );
        const isToday = day === todayISO;
        return (
          <div key={day} className={`sched-week-col${isToday ? " is-today" : ""}`} role="listitem">
            <div className="sched-week-head">
              <span>{agendaDayLabel(day)}</span>
              <button
                className="icon-button"
                aria-label={`Add crew on ${day}`}
                onClick={() => onCreate(day)}
              >
                <Plus size={15} />
              </button>
            </div>
            <div className="sched-week-body">
              {dayItems.map((a) => (
                <button
                  key={a.id}
                  className={blockClass(a, conflictIds)}
                  style={blockStyle(a)}
                  onClick={() => onOpen(a)}
                >
                  <span className="sched-block-title">
                    {a.project?.job_code ?? "Job"} · {a.project?.name ?? ""}
                  </span>
                  <span className="sched-block-sub">
                    {a.members.length} crew
                    {a.start_time ? ` · ${formatStartTime(a.start_time)}` : ""}
                    {a.start_date === day && a.end_date > day ? " · starts" : ""}
                  </span>
                </button>
              ))}
              {dayItems.length === 0 && (
                <button className="sched-week-empty" onClick={() => onCreate(day)}>
                  + crew
                </button>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function blockClass(a: ScheduleAssignment, conflictIds: Set<string>): string {
  const parts = ["sched-block"];
  parts.push(a.status === "draft" ? "is-draft" : "is-published");
  if (conflictIds.has(a.id)) parts.push("is-conflict");
  return parts.join(" ");
}

function blockStyle(a: ScheduleAssignment): React.CSSProperties {
  return { "--sched-color": assignmentColor(a) } as React.CSSProperties;
}
