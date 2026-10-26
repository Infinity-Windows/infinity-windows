import { workAttribution, workAttributions } from "./workAttribution";
import { useState } from "react";
import type { ActivityRow } from "./activityRows";
import { generalLabor, weeklyScale } from "./generalLabor";
import { WeeklyLaborPlot } from "./WeeklyLaborPlot";
import { MultiSelect } from "./MultiSelect";

const colors = ["#55b9d2", "#ff743d", "#b29aed"];
export function ActivityOverview({ rows, from, until, onInspect }: {
  rows: ActivityRow[]; from: number; until: number; onInspect: (ids: string[], interval?: [number, number]) => void;
}) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const [metric, setMetric] = useState("hours");
  const [compare, setCompare] = useState("none");
  const [chosenJobs, setChosenJobs] = useState<string[] | null>(null);
  const source = rows.map(row => ({ ...row, activity: `${workAttribution(row)} · ${row.activity}` }));
  const total = rows.reduce((sum, row) => sum + row.seconds, 0);
  const activities = [...new Set(source.map(row => row.activity))].map(key => {
    const matching = source.filter(row => row.activity === key);
    return { key, scope: workAttribution(matching[0]), label: matching[0].activity.slice(workAttribution(matching[0]).length + 3), seconds: matching.reduce((sum, row) => sum + row.seconds, 0), ids: matching.map(row => row.id) };
  }).sort((a, b) => b.seconds - a.seconds);
  const jobs = [...new Map(rows.map(row => [row.jobId ?? "", { key: row.jobId ?? "", label: row.job ?? "Unknown job" }])).values()].sort((a, b) => a.label.localeCompare(b.label));
  const selectedJobs = (chosenJobs ?? jobs.slice(0, 3).map(job => job.key)).filter(id => jobs.some(job => job.key === id)).slice(0, 3);
  const cohorts = compare === "job" ? selectedJobs.map((id, index) => ({ key: id, label: jobs.find(job => job.key === id)!.label, rows: source.filter(row => row.jobId === id), color: colors[index] })) : [{ key: "all", label: "Selected jobs", rows: source, color: colors[0] }];
  const weeks = expanded ? generalLabor(source, expanded, true, from, until, Date.now(), "all") : [];
  const series = expanded ? cohorts.map(cohort => {
    const buckets = generalLabor(cohort.rows, expanded, true, from, until, Date.now(), "all");
    return { ...cohort, buckets: weeks.map(week => buckets.find(bucket => bucket.key === week.key) ?? { ...week, seconds: 0, totalSeconds: 0, percent: null, ids: [], segments: [] }) };
  }) : [];
  const scale = weeklyScale(Math.max(0, ...series.flatMap(item => item.buckets.map(bucket => bucket.seconds / 3600))));
  return <section className="activity-overview" aria-label="Activity overview">
    <div className="activity-unit-heading"><h2>Activities</h2><span>{(total / 3600).toFixed(2)} activity h</span></div>
    <p className="activity-unit-note">Activity evidence only · hours and share of captured activity time</p>
    {workAttributions.map(scope => <section key={scope} aria-label={`${scope} activity overview`}>
      <h3>{scope}</h3>
      {activities.filter(activity => activity.scope === scope).map(activity => <div key={activity.key} className="activity-overview-item">
        <button type="button" className="activity-overview-row" aria-expanded={expanded === activity.key} aria-controls="activity-investigation" onClick={() => setExpanded(old => old === activity.key ? null : activity.key)}>
          <span>{activity.label}<strong>{(activity.seconds / 3600).toFixed(2)} h <small>· {total ? (activity.seconds / total * 100).toFixed(1) : "0"}%</small> {expanded === activity.key ? "▾" : "▸"}</strong></span>
          <span className="activity-mix-track"><i style={{ width: `${total ? activity.seconds / total * 100 : 0}%`, background: scope === "Unit-linked work" ? colors[0] : scope === "Job-level work" ? colors[1] : colors[2] }} /></span>
        </button>
        {expanded === activity.key && <div id="activity-investigation" className="activity-investigation" aria-label={`${activity.label} investigation`}>
          <div className="general-chart-controls">
            <label>Measure<select value={metric} onChange={event => setMetric(event.target.value)}><option value="hours">Hours</option><option value="percent">Labor share</option></select></label>
            <label>Compare by<select value={compare} onChange={event => setCompare(event.target.value)}><option value="none">None</option><option value="job">Job</option></select></label>
          </div>
          {compare === "job" && <><MultiSelect label="Compare jobs" options={jobs} value={selectedJobs} onChange={value => setChosenJobs(value === null ? jobs.slice(0, 3).map(job => job.key) : value.slice(0, 3))} color={colors[0]} /><p className="activity-unit-note">Up to 3 jobs · aligned weeks and shared scale</p></>}
          <p className="activity-unit-note">{metric === "percent" ? "Share of captured activity time in each job and week." : "Recorded person-hours each week."} Tap a column to inspect. Gaps mean no recorded activity.</p>
          {series.map(item => <div key={item.key} className="activity-job-series"><h4>{item.label}</h4><WeeklyLaborPlot buckets={item.buckets} metric={metric} color={() => item.color} from={from} until={until} scaleMax={scale} laborLabel="captured activity time" onInspect={onInspect} /></div>)}
          {!series.length && <p>Select a job to compare.</p>}
          <button type="button" className="activity-inspect-records" onClick={() => onInspect(activity.ids)}>Inspect all {activity.ids.length} records</button>
        </div>}
      </div>)}
      {!activities.some(activity => activity.scope === scope) && <p className="activity-unit-note">No recorded {scope.toLowerCase()} activity.</p>}
    </section>)}
  </section>;
}
