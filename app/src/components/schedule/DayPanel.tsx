// Wave C, C3: tap any day on the Scheduling calendar — past days included —
// to see its memory. Read-only by design: scheduling/editing crew stays
// AssignmentEditor's job, opened from here via onEditAssignment /
// onScheduleCrew so this panel never grows a second copy of that form.
import { Link } from "react-router-dom";
import { X } from "lucide-react";
import { agendaDayLabel } from "../../lib/schedule/dates";
import { calendarColorStyle } from "../../lib/schedule/jobHue";
import {
  dayMemoryFallbackLine,
  type DayMemory,
  type DayMemoryJobEntry,
} from "../../lib/schedule/dayMemory";
import { DayFlowChip } from "../dailyLogs/DayFlowChip";
import type { ScheduleAssignment } from "../../lib/schedule/types";

interface DayPanelProps {
  date: string;
  memory: DayMemory | null;
  loading: boolean;
  /** Foreman+ only (mirrors DailyLogsTab/LogTodayChip's isForemanPlus gate,
   * and daily_logs' own RLS): shows hours next to a worked name, and the
   * tap-through into a job's Logs tab an installer couldn't open anyway. */
  canSeeHours: boolean;
  /** The published/draft install assignment behind one job entry, if any —
   * "Edit crew" opens the real editor on it rather than re-deriving one. */
  assignmentFor: (projectId: string) => ScheduleAssignment | null;
  onEditAssignment: (assignment: ScheduleAssignment) => void;
  onScheduleCrew: () => void;
  onClose: () => void;
}

export function DayPanel({
  date,
  memory,
  loading,
  canSeeHours,
  assignmentFor,
  onEditAssignment,
  onScheduleCrew,
  onClose,
}: DayPanelProps) {
  const empty = memory != null && memory.jobs.length === 0 && memory.deliveries.length === 0;
  return (
    <div className="sched-sheet-backdrop" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="sched-sheet day-memory-sheet" onClick={(e) => e.stopPropagation()}>
        <div className="sched-sheet-head">
          <h2 style={{ margin: 0, fontSize: 16 }}>{agendaDayLabel(date)}</h2>
          <button
            type="button"
            className="icon-button sched-sheet-close"
            aria-label="Close"
            onClick={onClose}
          >
            <X size={16} />
          </button>
        </div>

        {loading ? (
          <p className="muted">Pulling up that day…</p>
        ) : empty ? (
          <p className="muted">No day record.</p>
        ) : (
          <>
            {memory?.jobs.map((entry) => (
              <DayMemoryJobCard
                key={entry.projectId}
                entry={entry}
                canSeeHours={canSeeHours}
                assignment={assignmentFor(entry.projectId)}
                onEditAssignment={onEditAssignment}
              />
            ))}
            {(memory?.deliveries.length ?? 0) > 0 && (
              <div className="day-memory-deliveries">
                <p className="day-memory-diff-label">Deliveries</p>
                <ul className="unit-list">
                  {memory!.deliveries.map((d) => (
                    <li key={d.assignmentId}>
                      {d.label}
                      {d.memberNames.length > 0 && (
                        <span className="muted"> — {d.memberNames.join(", ")}</span>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </>
        )}

        <div className="sched-sheet-actions">
          <button type="button" className="button-like active-pill" onClick={onScheduleCrew}>
            Schedule crew
          </button>
          <button type="button" className="button-like" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

function DayMemoryJobCard({
  entry,
  canSeeHours,
  assignment,
  onEditAssignment,
}: {
  entry: DayMemoryJobEntry;
  canSeeHours: boolean;
  assignment: ScheduleAssignment | null;
  onEditAssignment: (a: ScheduleAssignment) => void;
}) {
  const style = calendarColorStyle({ project_id: entry.projectId, color: assignment?.color });
  return (
    <div className="day-memory-card" style={style}>
      <div className="row-between">
        <strong className="day-memory-jobname">
          {entry.jobCode}
          {entry.jobName ? ` — ${entry.jobName}` : ""}
        </strong>
        {assignment && (
          <button
            type="button"
            className="button-like"
            style={{ fontSize: 12 }}
            onClick={() => onEditAssignment(assignment)}
          >
            Edit crew
          </button>
        )}
      </div>

      <div className="day-memory-diff">
        <div>
          <p className="day-memory-diff-label">Assigned</p>
          {entry.assigned.length === 0 ? (
            <p className="muted" style={{ fontSize: 12.5, margin: 0 }}>
              Nobody
            </p>
          ) : (
            <ul className="day-memory-namelist">
              {entry.assigned.map((name) => (
                <li key={name}>{name}</li>
              ))}
            </ul>
          )}
        </div>
        <div>
          <p className="day-memory-diff-label">Worked</p>
          {entry.worked.length === 0 ? (
            <p className="muted" style={{ fontSize: 12.5, margin: 0 }}>
              Nobody punched in
            </p>
          ) : (
            <ul className="day-memory-namelist">
              {entry.worked.map((w) => (
                <li key={w.profileId}>
                  {w.name}
                  {canSeeHours ? ` — ${w.hours}h` : ""}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {entry.log ? (
        <div className="day-memory-log">
          {entry.log.day_flow && <DayFlowChip flow={entry.log.day_flow} />}
          {entry.log.headline && <p className="day-memory-log-headline">{entry.log.headline}</p>}
          {entry.log.notes && <p className="day-memory-log-notes">{entry.log.notes}</p>}
          {canSeeHours && (
            <Link className="link" style={{ fontSize: 12.5 }} to={`/projects/${entry.projectId}?tab=logs`}>
              Open the Logs tab
            </Link>
          )}
        </div>
      ) : (
        <p className="muted day-memory-fallback">{dayMemoryFallbackLine(entry)}</p>
      )}
    </div>
  );
}
