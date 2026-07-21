import { useMemo } from "react";
import {
  enumerateDays,
  formatStartTime,
  groupDaysByMonth,
  mapItemsToDays,
  weekdayISO,
} from "../../lib/schedule/dates";
import { assignmentColor } from "../../lib/schedule/color";
import type { ScheduleAssignment } from "../../lib/schedule/types";

interface Props {
  from: string;
  to: string;
  todayISO: string;
  assignments: ScheduleAssignment[];
  conflictIds: Set<string>;
  onOpen: (a: ScheduleAssignment) => void;
}

function weekdayShort(iso: string): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString(undefined, {
    weekday: "short",
    timeZone: "UTC",
  });
}

function entryClass(a: ScheduleAssignment, conflictIds: Set<string>): string {
  const parts = ["sched-cal-entry"];
  parts.push(a.status === "draft" ? "is-draft" : "is-published");
  if (conflictIds.has(a.id)) parts.push("is-conflict");
  return parts.join(" ");
}

export function TimelineView({
  from,
  to,
  todayISO,
  assignments,
  conflictIds,
  onOpen,
}: Props) {
  const sections = useMemo(() => groupDaysByMonth(from, to), [from, to]);
  const dayMap = useMemo(() => {
    const days = enumerateDays(from, to);
    return mapItemsToDays(assignments, days);
  }, [assignments, from, to]);

  return (
    <div className="sched-cal">
      {sections.map((section) => (
        <section key={section.key} className="sched-cal-month">
          <h3 className="sched-cal-monthhead">{section.label}</h3>
          {section.days.map((day) => {
            const items = dayMap.get(day) ?? [];
            const dow = weekdayISO(day);
            const cls = [
              "sched-cal-dayrow",
              day === todayISO ? "is-today" : "",
              dow === 0 || dow === 6 ? "is-weekend" : "",
              items.length === 0 ? "is-empty" : "",
            ]
              .filter(Boolean)
              .join(" ");
            return (
              <div key={day} className={cls}>
                <div className="sched-cal-daylabel">
                  <span className="sched-cal-dow">{weekdayShort(day)}</span>
                  <span className="sched-cal-date">{Number(day.slice(-2))}</span>
                </div>
                <div className="sched-cal-entries">
                  {items.map((a) => {
                    const time = formatStartTime(a.start_time);
                    return (
                      <button
                        key={a.id}
                        className={entryClass(a, conflictIds)}
                        style={
                          { "--sched-color": assignmentColor(a) } as React.CSSProperties
                        }
                        onClick={() => onOpen(a)}
                      >
                        <span className="sched-cal-entry-title">
                          {a.project?.job_code ?? a.project?.name ?? "Job"}
                          {a.project?.name ? ` · ${a.project.name}` : ""}
                        </span>
                        <span className="sched-cal-entry-sub">
                          {a.members.length} crew
                          {time ? ` · ${time}` : ""}
                          {a.start_date === day && a.end_date > day ? " · starts" : ""}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </section>
      ))}
      {sections.length === 0 && (
        <p className="muted" style={{ padding: 16 }}>
          No days in this range.
        </p>
      )}
    </div>
  );
}
