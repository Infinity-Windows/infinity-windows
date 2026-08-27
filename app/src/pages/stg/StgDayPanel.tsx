// Wave S, S4: the tap-a-day panel. System facts (worked, crew, hours, units
// finished) are never gated (Q14) and always show when the day was worked;
// the log itself only appears when stg_day already decided to include it —
// this component never re-derives or second-guesses that decision, it just
// renders whatever came back. Same .modal-backdrop/.modal-card pattern as
// DailyLogDialog.tsx (the app's standing generic dialog shape).
import { useQuery } from "@tanstack/react-query";
import { QueryError } from "../../components/ui/States";
import { DayFlowChip } from "../../components/dailyLogs/DayFlowChip";
import { stgDay } from "../../lib/stg";
import { formatLogDateLabel } from "../../lib/dailyLogDay";

export function StgDayPanel({
  projectId,
  jobName,
  date,
  onClose,
}: {
  projectId: string;
  jobName: string;
  date: string;
  onClose: () => void;
}) {
  const day = useQuery({
    queryKey: ["stgDay", projectId, date],
    queryFn: () => stgDay(projectId, date),
  });

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <div className="row-between">
          <div>
            <p className="muted" style={{ margin: 0, fontSize: 12.5 }}>{jobName}</p>
            <h2 style={{ margin: "2px 0 0", fontSize: 17 }}>{formatLogDateLabel(date)}</h2>
          </div>
          <button type="button" className="capture-close" aria-label="Close" onClick={onClose}>
            ✕
          </button>
        </div>

        {day.isLoading && <p className="muted">Loading…</p>}
        {day.isError && <QueryError error={day.error} onRetry={() => day.refetch()} />}

        {day.isSuccess && !day.data.worked && (
          <p className="muted" style={{ marginTop: 14 }}>No crew on site this day.</p>
        )}

        {day.isSuccess && day.data.worked && (
          <div style={{ marginTop: 14, display: "flex", flexDirection: "column", gap: 10 }}>
            <div>
              <p style={{ margin: 0 }}>
                {day.data.crew_names.length > 0
                  ? day.data.crew_names.join(", ")
                  : "Crew on site"}
              </p>
              <p className="muted" style={{ margin: "2px 0 0", fontSize: 13 }}>
                {day.data.total_hours} hour{day.data.total_hours === 1 ? "" : "s"} logged
                {day.data.units_finished > 0
                  ? ` · ${day.data.units_finished} unit${day.data.units_finished === 1 ? "" : "s"} finished`
                  : ""}
              </p>
            </div>

            <hr style={{ border: "none", borderTop: "1px solid var(--border)", margin: 0 }} />

            {day.data.log ? (
              <div>
                {day.data.log.day_flow && <DayFlowChip flow={day.data.log.day_flow} />}
                {day.data.log.headline && (
                  <p style={{ fontWeight: 650, margin: "8px 0 0" }}>{day.data.log.headline}</p>
                )}
                <p style={{ margin: "6px 0 0", whiteSpace: "pre-wrap" }}>{day.data.log.notes}</p>
              </div>
            ) : (
              <p className="muted" style={{ margin: 0 }}>No notes shared for this day yet.</p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
