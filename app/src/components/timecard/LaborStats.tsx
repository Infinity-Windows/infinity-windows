import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { listLaborStatsShifts } from "../../lib/laborStatsApi";
import { summarizeLabor, type LaborBucket } from "../../lib/laborStats";
import { formatApiError } from "../../lib/errors";
import { listProfiles } from "../../lib/install/api";
import { isForemanPlus } from "../../lib/install/types";
import { useEffectiveRole } from "../../lib/useEffectiveRole";
import { getLaborJobs, getLaborTargets, laborVariance } from "../../lib/jobExecution";
import "./laborStats.css";

const hours = (value: number) => `${value.toFixed(1)}h`;

function JobHours({ jobs }: { jobs: LaborBucket[] }) {
  return <div className="table-wrap"><table className="analytics-table">
    <thead><tr><th>Job</th><th className="num">Days</th><th className="num">Hours</th></tr></thead>
    <tbody>{jobs.map((job) => <tr key={job.id}>
      <td>{job.id === "unassigned" ? job.label : <Link to={`/projects/${job.id}`}>{job.label}</Link>}</td>
      <td className="num">{job.days.size}</td><td className="num">{hours(job.hours)}</td>
    </tr>)}</tbody>
  </table></div>;
}

export function LaborStats() {
  const { effectiveRole, isLoading } = useEffectiveRole();
  const allowed = !isLoading && isForemanPlus(effectiveRole);
  const [selected, setSelected] = useState<string | null>(null);
  const shifts = useQuery({ queryKey: ["laborStatsShifts"], queryFn: listLaborStatsShifts, enabled: allowed });
  const roster = useQuery({ queryKey: ["laborStatsRoster"], queryFn: listProfiles, enabled: allowed });
  const jobs = useQuery({ queryKey: ["laborStatsJobs"], queryFn: getLaborJobs, enabled: allowed });
  const targets = useQuery({ queryKey: ["jobLaborTargets"], queryFn: getLaborTargets, enabled: allowed });
  const report = useMemo(() => {
    const testIds = new Set((jobs.data ?? []).filter((job) => job.is_test).map((job) => job.id));
    return summarizeLabor((shifts.data ?? []).filter((row) => !row.project_id || !testIds.has(row.project_id)), roster.data ?? []);
  }, [shifts.data, roster.data, jobs.data]);
  const worker = report.workers.find((row) => row.id === selected);
  const coverage = report.totalHours > 0 ? 100 * report.codedHours / report.totalHours : null;
  if (!allowed) return null;
  return <section className="labor-stats" aria-label="Cost-code labor stats">
    <h2>Cost-code labor stats</h2>
    <p className="muted">All recorded time · Submitted and approved shifts, less breaks. Open, unfinished, rejected, and voided shifts are excluded from hours. Days are counted by clock-in date in Mountain time.</p>
    <button type="button" disabled={shifts.isFetching || roster.isFetching || jobs.isFetching || targets.isFetching} onClick={() => { void shifts.refetch(); void roster.refetch(); void jobs.refetch(); void targets.refetch(); }}>Refresh stats</button>
    {(shifts.isPending || roster.isPending || jobs.isPending) && <p role="status">Loading labor totals…</p>}
    {(shifts.isError || roster.isError || jobs.isError) && <p role="alert">{formatApiError(shifts.error ?? roster.error ?? jobs.error, "Could not load a complete labor report. Please refresh.")}</p>}
    {shifts.isSuccess && roster.isSuccess && jobs.isSuccess && <>
      <div className="detail-card">
        <div className="row-between"><strong>Hours assigned to cost codes</strong><strong>{coverage === null ? "—" : `${Math.round(coverage)}%`}</strong></div>
        <progress aria-label="Hours assigned to cost codes" max={100} value={coverage ?? 0} />
        <p className="muted">{hours(report.codedHours)} of {hours(report.totalHours)}. Missing codes stay visible as “No cost code.”</p>
      </div>
      {worker ? <div className="detail-card">
        <button type="button" onClick={() => setSelected(null)}>← Everyone</button>
        <h3>{worker.label}</h3>
        <p>{hours(worker.hours)} · {worker.days.size} days · {worker.openShifts} open shifts · {worker.needsReview} shifts needing review</p>
        <h4>By cost code</h4>
        {worker.costCodes.length === 0 && <p className="muted">No completed hours recorded.</p>}
        {worker.costCodes.map((code) => <div className="labor-code" key={code.id}>
          <div className="row-between"><span>{code.label}</span><span>{hours(code.hours)} · {Math.round(code.hours / worker.hours * 100)}%</span></div>
          <progress aria-label={code.label} max={worker.hours} value={code.hours} />
        </div>)}
        <h4>By job</h4><JobHours jobs={worker.jobs} />
      </div> : <>
        <h3>Everyone</h3>
        <div className="labor-people">{report.workers.map((row) => <button className="detail-card labor-person" type="button" key={row.id} onClick={() => setSelected(row.id)}>
          <span className="row-between"><strong>{row.label}</strong><strong>{hours(row.hours)}</strong></span>
          <span className="muted">{row.days.size} days · {row.openShifts} open · {row.needsReview} needing review</span>
        </button>)}</div>
        {report.workers.length === 0 && <p className="muted">No crew time recorded yet.</p>}
        <h3>Jobs — hours against the target</h3>
        <p className="muted">Whole-job totals. Scores compare recorded hours with projected hours on completed jobs. Goal is the separate foreman target. Test jobs are excluded.</p>
        {targets.isError && <p role="alert">{formatApiError(targets.error)}</p>}
        <div className="table-wrap"><table className="analytics-table">
          <thead><tr><th>Job</th><th>SQF</th><th>Hours</th><th>Expected</th><th>Goal</th><th>Score</th></tr></thead>
          <tbody>{(jobs.data ?? []).filter((job) => !job.is_test).map((job) => {
            const actual = report.jobs.find((row) => row.id === job.id)?.hours ?? 0;
            const target = targets.isSuccess ? targets.data.find((row) => row.project_id === job.id) : undefined;
            const score = job.status === "completed" && actual > 0 ? laborVariance(actual, target?.projected_hours) : null;
            return <tr key={job.id}><td><Link to={`/projects/${job.id}`}>{job.job_code} · {job.name}</Link><span className="muted"> · {job.status}</span></td>
              <td>{target?.square_feet ?? "—"}</td><td>{hours(actual)}</td><td>{target?.projected_hours == null ? "—" : hours(target.projected_hours)}</td>
              <td>{target?.goal_hours == null ? "—" : hours(target.goal_hours)}</td>
              <td className={score === null ? "" : score > 0 ? "warn-text" : "ok"}>{score === null ? "—" : `${score > 0 ? "+" : ""}${score.toFixed(1)}%`}</td></tr>;
          })}</tbody>
        </table></div>
        {report.jobs.some((job) => job.id === "unassigned") && <p className="muted">No job: {hours(report.jobs.find((job) => job.id === "unassigned")!.hours)}</p>}
      </>}
    </>}
  </section>;
}
