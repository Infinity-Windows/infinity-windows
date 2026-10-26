import { workAttribution } from "./workAttribution";
import { ChartFormatToggle } from "./ChartTimeControls";
import { useState } from "react";
import type { ActivityRow } from "./activityRows";
import { WeeklyLaborPlot } from "./WeeklyLaborPlot";
import { generalLabor } from "./generalLabor";

const colors = ["#55b9d2", "#ff743d", "#b29aed", "#e5bb55", "#79c39b", "#e887aa"];
export function GeneralLaborChart({ rows, from, until, onInspect, jobStatuses = new Map(), scope = "General", title = "Job-level work" }: { scope?: "General" | "all"; title?: string; jobStatuses?: Map<string, string>; rows: ActivityRow[]; from: number; until: number; onInspect: (ids: string[], interval?: [number, number]) => void }) {
  const [jobStatus, setJobStatus] = useState("all");
  const statusRows = rows.filter(row => jobStatus === "all" || jobStatuses.get(row.jobId ?? "") === jobStatus).filter(row => scope === "all" || workAttribution(row) === "Job-level work").map(row => scope === "all" ? { ...row, activity: `${workAttribution(row)} · ${row.activity}` } : row);
  const [view, setView] = useState("weekly");
  const [metric, setMetric] = useState("hours");
  const [activity, setActivity] = useState("");
  const activities = [...new Set(statusRows.filter(row => scope === "all" || workAttribution(row) === "Job-level work").map(row => row.activity))].sort();
  const selected = activities.includes(activity) ? activity : "";
  const buckets = generalLabor(statusRows, selected || null, view === "weekly", from, until, Date.now(), scope);
  const max = metric === "percent" ? 100 : Math.max(...buckets.map(bucket => bucket.seconds / 3600), .001);
  const color = (name: string) => colors[activities.indexOf(name) % colors.length];
  return <section className="general-labor" aria-label={title}>
    <h2>{title}</h2>
    <div className="general-chart-controls">
      <label>View<select value={view} onChange={e => setView(e.target.value)}><option value="activity">By activity</option><option value="weekly">Weekly trend</option></select></label>
      <ChartFormatToggle value={metric} onChange={setMetric} />
      <label>Activity<select value={selected} onChange={e => setActivity(e.target.value)}><option value="">All activities</option>{activities.map(name => <option key={name}>{name}</option>)}</select></label>
      <label>Job status<select value={jobStatus} onChange={e => setJobStatus(e.target.value)}><option value="all">All statuses</option><option value="active">In progress</option><option value="completed">Completed</option></select></label>
    </div>
    <p className="activity-unit-note">{view === "weekly" ? "Monday weeks · Denver time · gaps mean no recorded labor" : "Recorded person-hours by activity"} · {metric === "percent" ? (scope === "all" ? "share of recorded labor in the same period" : "share of all Job-level work in the same period") : "closed timers"}. Jobs and dates shared; unit and table filters do not apply.</p>
    {view === "weekly" && <div className="activity-legend">{activities.filter(name => !selected || name === selected).map(name => <span key={name}><i style={{ background: color(name) }} />{name}</span>)}</div>}
    <div className="general-chart-bars">{view === "weekly" ? <WeeklyLaborPlot laborLabel={scope === "all" ? "recorded labor" : "Job-level work"} buckets={buckets} metric={metric} color={color} from={from} until={until} onInspect={onInspect} /> : buckets.map(bucket => {
      const value = metric === "percent" ? bucket.percent : bucket.seconds / 3600;
      const display = value === null ? "—" : `${value > 0 && value < .01 ? "<0.01" : value.toFixed(2)}${metric === "percent" ? "%" : " h"}`;
      const label = view === "weekly" ? `Week of ${bucket.key}${bucket.partial ? " · partial" : ""}` : bucket.key;
      return <button type="button" className="general-chart-bar" key={bucket.key} disabled={!bucket.ids.length} aria-label={`${label}: ${display}; inspect ${bucket.ids.length} records`} onClick={() => onInspect(bucket.ids)}>
        <span>{label}<strong>{display}</strong></span><span className="general-chart-track"><i style={{ width: `${Math.min(100, (value ?? 0) / max * 100)}%`, background: color(bucket.key) }} /></span>
      </button>;
    })}</div>
    {!buckets.length && <p>{scope === "all" ? "No recorded labor" : "No recorded Job-level work"} for these jobs and dates.</p>}
  </section>;
}
