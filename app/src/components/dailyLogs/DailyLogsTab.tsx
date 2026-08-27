// The job page's Logs tab (wave L, L3). Mounted from ProjectDetail.tsx only
// when isLead (foreman+) — the same tab-gating idiom the Dispatch tab uses.
// That's UI convenience only: the real gate is daily_logs' RLS policy
// (Q7) — an installer whose session somehow reached this component would
// still get an empty list back, never a peek at another role's notes.
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { QueryError, SkeletonList } from "../ui/States";
import { listDailyLogs, type DailyLog } from "../../lib/dailyLogs";
import { localDateISO, formatLogDateLabel } from "../../lib/dailyLogDay";
import { useEffectiveRole } from "../../lib/useEffectiveRole";
import { isSupervisorPlus } from "../../lib/install/types";
import { DayFlowChip } from "./DayFlowChip";
import { ShareWithBuilderChip } from "./ShareWithBuilderChip";
import { DailyLogDialog } from "./DailyLogDialog";

export function DailyLogsTab({
  projectId,
  jobLabel,
}: {
  projectId: string;
  jobLabel: string;
}) {
  const logs = useQuery({
    queryKey: ["dailyLogs", projectId],
    queryFn: () => listDailyLogs(projectId),
  });
  const [openFor, setOpenFor] = useState<string | null>(null);
  const { effectiveRole } = useEffectiveRole();
  const canShare = isSupervisorPlus(effectiveRole);

  return (
    <div className="daily-logs-tab">
      <div className="row-between">
        <h2 style={{ fontSize: 16 }}>Daily logs</h2>
        <button
          type="button"
          className="button-like active-pill"
          onClick={() => setOpenFor(localDateISO())}
        >
          + Log today
        </button>
      </div>

      {logs.isLoading && <SkeletonList rows={3} />}
      {logs.isError && <QueryError error={logs.error} />}
      {logs.isSuccess && logs.data.length === 0 && (
        <p className="muted">No logs filed yet — the first one starts here.</p>
      )}
      {logs.isSuccess && logs.data.length > 0 && (
        <ul className="unit-list work-list">
          {logs.data.map((log: DailyLog) => (
            <li
              key={log.id}
              className="find-row"
              role="button"
              tabIndex={0}
              onClick={() => setOpenFor(log.log_date)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") setOpenFor(log.log_date);
              }}
              style={{ cursor: "pointer" }}
            >
              <div style={{ minWidth: 0, flex: 1 }}>
                <p style={{ margin: 0, fontWeight: 650 }}>{formatLogDateLabel(log.log_date)}</p>
                <p className="muted" style={{ margin: "2px 0 0", fontSize: 13 }}>
                  {log.headline || log.notes}
                </p>
                {log.filer?.display_name && (
                  <p className="muted" style={{ margin: "2px 0 0", fontSize: 11.5 }}>
                    Filed by {log.filer.display_name}
                  </p>
                )}
              </div>
              <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 6 }}>
                {log.day_flow && <DayFlowChip flow={log.day_flow} />}
                {canShare && (
                  <ShareWithBuilderChip
                    logId={log.id}
                    visible={log.customer_visible}
                    onChanged={() => logs.refetch()}
                  />
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      {openFor && (
        <DailyLogDialog
          projectId={projectId}
          logDate={openFor}
          jobLabel={jobLabel}
          onClose={() => setOpenFor(null)}
        />
      )}
    </div>
  );
}
