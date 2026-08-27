// The "Log today · N" chip (wave L, L4). Lives on all three "/" landings
// (Home for foremen, My Work for installers, Heartbeat for supervisors/
// owners — the role-map rule: a landing feature goes on all three) exactly
// like RoleMaps does: mounted unconditionally, and its OWN role check
// decides whether anything renders. isForemanPlus is true for foreman,
// supervisor, and owner alike, so a supervisor previewing My Work or an
// owner on Heartbeat sees it too — there is no separate "this is only for
// foremen" gate beyond the same rank Q7 gates daily_logs' own RLS with.
//
// Only click ever changes what's mounted here — no :hover-driven mount/
// unmount (the RoleMap oscillation bug this app already learned from: a
// hover that changes layout moves the cursor off the target, which
// un-hovers it, which reverts the layout, forever).
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useEffectiveRole } from "../../lib/useEffectiveRole";
import { isForemanPlus } from "../../lib/install/types";
import { jobsNeedingLogToday } from "../../lib/dailyLogs";
import { localDateISO } from "../../lib/dailyLogDay";
import { DailyLogDialog } from "./DailyLogDialog";

export function LogTodayChip() {
  const { effectiveRole } = useEffectiveRole();
  const enabled = isForemanPlus(effectiveRole);
  const needing = useQuery({
    queryKey: ["jobsNeedingLog"],
    queryFn: jobsNeedingLogToday,
    enabled,
  });
  const [pickerOpen, setPickerOpen] = useState(false);
  const [openProjectId, setOpenProjectId] = useState<string | null>(null);

  const jobs = needing.data ?? [];
  if (!enabled || jobs.length === 0) return null;

  const openJob = jobs.find((j) => j.projectId === openProjectId) ?? null;

  return (
    <>
      <button
        type="button"
        className="log-today-chip"
        onClick={() => {
          if (jobs.length === 1) setOpenProjectId(jobs[0].projectId);
          else setPickerOpen(true);
        }}
      >
        Log today · {jobs.length}
      </button>

      {pickerOpen && (
        <div className="modal-backdrop" role="dialog" aria-modal="true" onClick={() => setPickerOpen(false)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <p style={{ margin: 0, fontWeight: 700 }}>Which job?</p>
            <p className="muted" style={{ margin: "2px 0 10px", fontSize: 12.5 }}>
              These jobs had work today with no log filed yet.
            </p>
            <ul className="unit-list work-list">
              {jobs.map((j) => (
                <li key={j.projectId}>
                  <button
                    type="button"
                    className="button-like"
                    style={{ width: "100%", textAlign: "left" }}
                    onClick={() => {
                      setPickerOpen(false);
                      setOpenProjectId(j.projectId);
                    }}
                  >
                    {j.jobCode} — {j.name}
                  </button>
                </li>
              ))}
            </ul>
            <button className="button-like" style={{ marginTop: 8 }} onClick={() => setPickerOpen(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {openJob && (
        <DailyLogDialog
          projectId={openJob.projectId}
          logDate={localDateISO()}
          jobLabel={`${openJob.jobCode} — ${openJob.name}`}
          onClose={() => setOpenProjectId(null)}
        />
      )}
    </>
  );
}
