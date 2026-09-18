import { useState } from "react";
import type { Project } from "../../lib/types";
import { useT } from "../../lib/i18n";
import { useEffectiveRole } from "../../lib/useEffectiveRole";
import { isForemanPlus } from "../../lib/install/types";
import { addDays, timecardRange } from "../../lib/timeclock";
import { dateFieldValue } from "../../lib/timeReportFilters";
import { TimeEntryExportDialog } from "./TimeEntryExportDialog";

/** Available on active jobs and in history; completing a job never hides its labor. */
export function JobTimecardExport({ project, compact = false }: { project: Project; compact?: boolean }) {
  const t = useT();
  const { effectiveRole } = useEffectiveRole();
  const [open, setOpen] = useState(false);
  if (!isForemanPlus(effectiveRole)) return null;
  const period = timecardRange("pay", new Date());
  const completed = project.status === "completed";
  return <section className={`${compact ? "" : "detail-card "}job-timecard-export${completed ? " job-billing-reminder" : ""}`}>
    <div>
      {completed && <h2>{t("timeexport.billingTitle")}</h2>}
      {(!compact || completed) && <p className="muted">{t(completed ? "timeexport.billingHelp" : "timeexport.jobHelp")}</p>}
    </div>
    <button className="button-like" onClick={() => setOpen(true)}>{t("timeexport.jobsTitle")}</button>
    {open && <TimeEntryExportDialog byJob initialJobs={[project.id]}
      fromDate={dateFieldValue(period.start)} throughDate={dateFieldValue(addDays(period.end, -1))}
      onClose={() => setOpen(false)} />}
  </section>;
}
