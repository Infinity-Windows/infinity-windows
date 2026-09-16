import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import type { TimeShift } from "../../lib/timeclock";
import type { Project } from "../../lib/types";
import { jobTimeReport } from "../../lib/jobTimeReport";
import { formatApiError } from "../../lib/errors";
import { useT } from "../../lib/i18n";
import { SkeletonList } from "../ui/States";

const hours = (h: number) => `${h.toFixed(1)}h`;

/** The same selected punches as the roster: this component never chooses dates. */
export function TimeByJobReport({ shifts, rangeLabel, isLoading, error, isFetching, onRefresh, allProjects }: {
  shifts: TimeShift[];
  rangeLabel: string;
  isLoading: boolean;
  error: unknown;
  isFetching: boolean;
  onRefresh: () => void;
  /** Data lists zero-hour jobs too, including completed jobs. */
  allProjects?: Project[];
}) {
  const t = useT();
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);
  const report = useMemo(() => jobTimeReport(shifts, now), [shifts, now]);
  const jobs = useMemo(() => {
    const byId = new Map(report.jobs.map((job) => [job.jobKey, job]));
    for (const p of allProjects ?? []) {
      if (!byId.has(p.id)) byId.set(p.id, {
        jobKey: p.id, jobCode: p.job_code, jobName: p.name, hours: 0,
        recordedHours: 0, runningHours: 0, unresolvedCount: 0, shiftCount: 0, costCodes: [],
      });
    }
    return [...byId.values()].sort((a, b) => b.hours - a.hours || a.jobCode.localeCompare(b.jobCode));
  }, [report.jobs, allProjects]);

  return <section className="detail-card job-time-report" aria-label={t("timereport.title")}>
    <div className="row-between" style={{ gap: 12, flexWrap: "wrap" }}>
      <h2 style={{ margin: 0, fontSize: 18 }}>{t("timereport.title")}</h2>
      <button type="button" disabled={isFetching} onClick={onRefresh}>{t("timereport.refresh")}</button>
    </div>
    <p><strong>{rangeLabel}</strong></p>
    <p className="muted">{t("timereport.help")}</p>
    {isLoading && <SkeletonList rows={3} />}
    {Boolean(error) && <p role="alert">{formatApiError(error, t("timereport.error"))}</p>}
    {!isLoading && !error && <>
      <p className="muted">{t("timereport.coverage", { people: report.peopleCount, shifts: report.recordedCount, running: report.runningCount })}</p>
      {report.unresolvedCount > 0 && <p role="status" className="warn-text">{t("timereport.unresolved", { n: report.unresolvedCount })}</p>}
      {jobs.length === 0 && <p className="muted">{t("timereport.empty")}</p>}
      {jobs.map((job) => {
        const project = allProjects?.find((p) => p.id === job.jobKey);
        return <div key={job.jobKey} className="job-time-row">
          <div className="row-between" style={{ gap: 12 }}>
            <strong style={{ minWidth: 0, overflowWrap: "anywhere" }}>
              {job.jobKey === "unassigned" ? t("timereport.noJob") : <Link to={`/projects/${job.jobKey}`}>{job.jobCode}{job.jobName ? ` · ${job.jobName}` : ""}</Link>}
            </strong>
            <strong style={{ whiteSpace: "nowrap" }}>{hours(job.hours)}</strong>
          </div>
          {job.runningHours > 0 && <p className="muted">{t("timereport.split", { closed: hours(job.recordedHours), live: hours(job.runningHours) })}</p>}
          {job.unresolvedCount > 0 && <p className="warn-text">{t("timereport.unresolved", { n: job.unresolvedCount })}</p>}
          {project && <p className="muted">
            {project.status === "completed" ? t("timereport.completed") : project.status === "cancelled" ? t("timereport.cancelled") : t("timereport.active")}
            {" · "}<Link to={`/projects/${project.id}`}>{t("timereport.manageJob")}</Link>
          </p>}
          {job.costCodes.length > 0 && <details open={!allProjects}>
            <summary>{t("timereport.codes")}</summary>
            <ul className="unit-list work-list">{job.costCodes.map((code) => <li key={code.costCodeKey} className="find-row">
              <span style={{ minWidth: 0 }}>{code.costCodeKey === "none" ? t("timereport.noCode") : `${code.code}${code.label ? ` — ${code.label}` : ""}`}</span>
              <span className="wh-actions">{hours(code.hours)}</span>
            </li>)}</ul>
          </details>}
        </div>;
      })}
      <div className="row-between" style={{ borderTop: "1px solid var(--border)", paddingTop: 12 }}>
        <strong>{t("timereport.total")}</strong><strong>{hours(report.totalHours)}</strong>
      </div>
      <p className="muted">{t("timereport.split", { closed: hours(report.recordedHours), live: hours(report.runningHours) })}</p>
    </>}
  </section>;
}
