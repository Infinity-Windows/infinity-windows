// Daily reporting is available on every crew landing. The database enforces
// internal-crew access independently of this UI role check.
import { useT } from "../../lib/i18n";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useEffectiveRole } from "../../lib/useEffectiveRole";
import { canUseDailyLogs } from "../../lib/dailyLogAccess";
import { jobsNeedingLogToday } from "../../lib/dailyLogs";
import { localDateISO } from "../../lib/dailyLogDay";
import { DailyLogDialog } from "./DailyLogDialog";

export function LogTodayChip() {
  const t = useT();
  const { effectiveRole } = useEffectiveRole();
  const enabled = canUseDailyLogs(effectiveRole);
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
        {t("dailyLog.todayCount", { count: jobs.length })}
      </button>

      {pickerOpen && (
        <div className="modal-backdrop" role="dialog" aria-modal="true" onClick={() => setPickerOpen(false)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <p style={{ margin: 0, fontWeight: 700 }}>{t("dailyLog.whichJob")}</p>
            <p className="muted" style={{ margin: "2px 0 10px", fontSize: 12.5 }}>
              {t("dailyLog.jobsWithoutLog")}
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
              {t("dailyLog.action.cancel")}
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
