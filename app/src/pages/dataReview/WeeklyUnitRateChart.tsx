import { WeeklyLaborPlot } from "./WeeklyLaborPlot";
import type { LaborMetric } from "./laborMetrics";
import { weeklyRateScale } from "./weeklyRateScale";
import { Info } from "lucide-react";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import type { ActivityRow } from "./activityRows";
import type { WorkUnit } from "../../lib/customWork/model";
import type { Profile } from "../../lib/install/types";
import { ReportingMultiSelect } from "./ReportingMultiSelect";
import { midnight } from "./generalLabor";
import { nextWeekDate, weeklyUnitRates, relativeWeeklyUnitRates } from "./weeklyUnitRateData";

const colors = ["#69b5cf", "#d9aa72", "#a99bd1", "#83b49b", "#cf91aa", "#bbc76c", "#82a0df", "#d38978"];
export function WeeklyUnitRates({ rows, units, people = [], from, until, onInspect, relative, timeControls, metric = "area", format = "hours" }: { metric?: LaborMetric; format?: string; relative?: { anchors: Map<string, string>; count: number; basis?: "clocked" | "unit" }; timeControls?: ReactNode; rows: ActivityRow[]; units: WorkUnit[]; people?: Profile[]; from: number; until: number; onInspect: (ids: string[], interval: [number, number]) => void }) {
  const infoId = useId();
  const plotRef = useRef<HTMLDivElement>(null);
  const [plotHeight, setPlotHeight] = useState(330);
  const [hiddenActivities, setHiddenActivities] = useState<string[]>([]);
  const [hiddenJobs, setHiddenJobs] = useState<string[]>([]);
  const [persons, setPersons] = useState<string[] | null>(null);
  const [colorBy, setColorBy] = useState("job");
  const [selected, setSelected] = useState<string | null>(null);
  const specific = rows.filter(row => row.scope === "Specific");
  const profiles = new Map(people.map(person => [person.id, person]));
  const personOptions = [...new Map(specific.map(row => [row.personId, { key: row.personId, label: `${row.person}${profiles.get(row.personId)?.role ? ` · ${profiles.get(row.personId)!.role} (current)` : " · role unknown"}` }])).values()].sort((a, b) => a.label.localeCompare(b.label));
  const jobs = [...new Map(specific.map(row => [row.jobId ?? "", row.job ?? "Unknown job"])).entries()].sort((a, b) => a[1].localeCompare(b[1]));
  const visibleJobs = jobs.filter(([id]) => !hiddenJobs.includes(id) && (!relative || relative.anchors.has(id)));
  const activities = [...new Set(specific.map(row => row.activity))].sort();
  const included = specific.filter(row => !hiddenActivities.includes(row.activity) && !hiddenJobs.includes(row.jobId ?? "") && (persons === null || persons.includes(row.personId)));
  const report = relative ? relativeWeeklyUnitRates(included, units, relative.anchors, relative.count, Date.now(), metric) : weeklyUnitRates(included, units, from, until, Date.now(), undefined, metric);
  const rateUnit = metric === "opening" ? "min/opening" : "min/ft²";
  const hasPoints = report.points.length > 0;
  useEffect(() => {
    const plot = plotRef.current;
    if (!plot || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry.contentRect.width > 0 && entry.contentRect.height > 0) {
        const height = Math.max(220, Math.round(entry.contentRect.height / entry.contentRect.width * 740));
        setPlotHeight(old => old === height ? old : height);
      }
    });
    observer.observe(plot);
    return () => observer.disconnect();
  }, [hasPoints]);
  const current = report.points.find(point => point.key === selected);
  const jobColor = (id: string) => colors[Math.max(0, jobs.findIndex(([key]) => key === id)) % colors.length];
  const personColor = (id: string) => colors[Math.max(0, personOptions.findIndex(person => person.key === id)) % colors.length];
  const contributors = (records: ActivityRow[]) => [...new Map(records.map(row => [row.personId, row.person])).entries()].map(([id, name]) => ({ id, name, seconds: records.filter(row => row.personId === id).reduce((total, row) => total + row.seconds, 0) }));
  const width = 740, weekWidth = 650 / Math.max(1, report.weeks.length);
  const laneWidth = weekWidth / Math.max(1, visibleJobs.length);
  const axis = weeklyRateScale(report.points.map(point => point.value!));
  const plotBottom = plotHeight - 65;
  const y = (value: number) => plotBottom - axis.position(value) * (plotBottom - 45);
  const groupCenter = (week: string, job: string) => 70 + report.weeks.indexOf(week) * weekWidth + (visibleJobs.findIndex(([id]) => id === job) + .5) * weekWidth / Math.max(1, visibleJobs.length);
  return <section aria-label={metric === "hours" ? "Unit-linked labor over time" : "Weekly unit rates"} className="weekly-unit-rates">
    <div className="weekly-rate-controls">{timeControls}
      <div className="unit-rate-activities" role="group" aria-label="Weekly included activities">{activities.map(activity => <button key={activity} type="button" aria-pressed={!hiddenActivities.includes(activity)} onClick={() => { setHiddenActivities(old => old.includes(activity) ? old.filter(item => item !== activity) : [...old, activity]); setSelected(null); }}>{activity}</button>)}</div>
      <ReportingMultiSelect label="Recorded people" options={personOptions} value={persons} onChange={value => { setPersons(value); setSelected(null); }} />
      {metric !== "hours" && <label className="weekly-rate-color">Color<select aria-label="Color weekly dots by" value={colorBy} onChange={event => setColorBy(event.target.value)}><option value="job">Job</option><option value="person">Person</option></select></label>}
      <button type="button" className="weekly-rate-info" aria-label="Weekly chart information" popoverTarget={infoId}><Info size={16} aria-hidden="true" /></button>
    </div>
    <div className="unit-rate-legend" role="group" aria-label="Weekly included jobs">{jobs.map(([id, name]) => <button type="button" key={id} aria-pressed={!hiddenJobs.includes(id)} onClick={() => { setHiddenJobs(old => old.includes(id) ? old.filter(value => value !== id) : [...old, id]); setSelected(null); }}><i style={{ background: jobColor(id) }} />{name}</button>)}</div>
    {metric !== "hours" && colorBy === "person" && <div className="unit-rate-legend" aria-label="Person colors">{personOptions.filter(person => persons === null || persons.includes(person.key)).map(person => <span key={person.key}><i style={{ background: personColor(person.key) }} />{person.label}</span>)}<span><i style={{ background: "#bbc2ca" }} />Multiple people · tap for contributors</span></div>}
    <aside id={infoId} popover="auto" className="weekly-rate-info-popover" aria-label="Weekly chart information">
    <p className="unit-rate-coverage">{report.points.length} {metric === "hours" ? "linked unit-weeks" : "unit-week dots"} · {report.excluded} excluded unit-weeks ({metric === "area" ? "area" : "linkage"}) · {report.unlinked} unlinked weekly records{report.invalid ? ` · ${report.invalid} invalid intervals` : ""}. {metric === "hours" ? "Hours from explicitly unit-linked timers; unlinked records and Job-level work excluded. Percent is each job-week’s selected timer hours." : metric === "opening" ? "Dots: selected activity minutes per linked opening; one opening per dot." : "Dots: selected people’s activity minutes ÷ stored opening ft²."} Weekly contributions, not completed units. {relative ? `${relative.basis === "unit" ? "First linked unit timer" : "First finished clocked shift"} starts each job’s seven-day weeks; page dates ignored. Relative week is not equivalent phase.` : "Monday weeks · Denver."} {relative ? "* = at least one job’s week is incomplete or not reached." : "* = incomplete week."}</p>
    {relative && <p className="unit-rate-coverage">Week 1 origins: {[...relative.anchors].map(([job, date]) => `${jobs.find(([id]) => id === job)?.[1] ?? job} · ${date}`).join("; ")}. Origins stay fixed when activities or people are filtered.</p>}
    <p className="unit-rate-coverage">Partial timer evidence; {metric === "area" ? "area may be unverified." : "unit linkage does not establish complete installation capture."} People filter recorded contributors, not assigned crews. Current roles do not establish who supervised a historical crew.</p>
    {metric !== "hours" && <p className="unit-rate-coverage">The main Y range is linear. A marked upper section compresses large values when needed; exact rates remain available on each dot. Empty weeks have no eligible data.</p>}
    </aside>
    {metric === "hours" ? <>
      <div className="activity-legend">{activities.filter(activity => !hiddenActivities.includes(activity)).map(activity => <span key={activity}><i style={{ background: colors[activities.indexOf(activity) % colors.length] }} />{activity}</span>)}</div>
      <WeeklyLaborPlot laborLabel="selected unit-linked timer hours" metric={format} color={activity => colors[activities.indexOf(activity) % colors.length]} from={from} until={until} onInspect={(ids, interval) => { if (interval) onInspect(ids, interval); }} buckets={report.weeks.flatMap((week, index) => visibleJobs.map(([job, name]) => {
        const points = report.points.filter(point => point.week === week && point.jobId === job);
        const records = points.flatMap(point => point.records);
        const actual = relative ? nextWeekDate(relative.anchors.get(job)!, index * 7) : week;
        const total = records.reduce((sum, row) => sum + row.seconds, 0);
        return { key: actual, seriesKey: job, seriesLabel: name, groupKey: week, ...(relative ? { groupLabel: week } : {}), seconds: total, totalSeconds: total, percent: total ? 100 : null, ids: [...new Set(records.map(row => row.id))], partial: midnight(nextWeekDate(actual)) > Math.min(until, Date.now()) || midnight(actual) < from, unavailable: !records.length, future: midnight(actual) > Date.now(), segments: activities.filter(activity => !hiddenActivities.includes(activity)).map(activity => ({ activity, seconds: records.filter(row => row.activity === activity).reduce((sum, row) => sum + row.seconds, 0), ids: [...new Set(records.filter(row => row.activity === activity).map(row => row.id))] })).filter(segment => segment.ids.length) };
      }))} />
    </> : report.points.length ? <div ref={plotRef} className="weekly-unit-fit"><svg viewBox={`0 0 ${width} ${plotHeight}`} className="unit-rate-plot" aria-label={relative ? "Unit rates grouped by relative job week" : "Unit rates grouped by calendar week"}>
      <text x="62" y="20">{rateUnit}</text>
      {axis.cutoff !== null && <g aria-label={`Upper range compressed above ${axis.cutoff} ${rateUnit}`}><line x1="62" x2={width - 12} y1={y(axis.cutoff)} y2={y(axis.cutoff)} className="weekly-compression-divider" /><path d={`M57 ${y(axis.cutoff) + 5} l8 -5 l-8 -5 l8 -5`} className="weekly-axis-break" /><text x={width - 14} y={y(axis.cutoff) - 9} textAnchor="end">Upper range compressed · above {axis.cutoff.toPrecision(3)}</text></g>}
      {axis.ticks.map(tick => <g key={tick}><line x1="62" x2={width - 12} y1={y(tick)} y2={y(tick)} /><text x="53" y={y(tick) + 4} textAnchor="end">{tick !== 0 && (tick < .01 || tick >= 1000) ? tick.toExponential(0) : Number(tick.toPrecision(3))}</text></g>)}
      {report.weeks.map((week, index) => <g key={week}><line x1={70 + index * weekWidth} x2={70 + index * weekWidth} y1="36" y2={plotBottom + 10} />{(report.weeks.length <= 8 || index % Math.ceil(report.weeks.length / 8) === 0 || index === report.weeks.length - 1) && <text x={70 + (index + .5) * weekWidth} y={plotHeight - 20} textAnchor="middle">{relative ? `W${index + 1}` : week.slice(5)}{report.partialWeeks.includes(week) ? "*" : ""}</text>}{!report.points.some(point => point.week === week) && <text x={70 + (index + .5) * weekWidth} y={plotBottom + 15} textAnchor="middle">—</text>}</g>)}
      {report.points.map(point => {
        const peers = report.points.filter(other => other.week === point.week && other.jobId === point.jobId);
        const index = peers.findIndex(other => other.key === point.key);
        const crew = contributors(point.records);
        const fill = colorBy === "job" ? jobColor(point.jobId) : crew.length === 1 ? personColor(crew[0].id) : "#bbc2ca";
        const label = `${point.job} · Unit ${point.unit} · ${relative ? point.week : `week ${point.week}`} (from ${point.actualWeek}) · ${point.value!.toFixed(3)} ${rateUnit} · ${crew.map(person => person.name).join(", ")}`;
        return <circle key={point.key} role="button" tabIndex={0} aria-label={label} aria-pressed={selected === point.key} cx={groupCenter(point.week, point.jobId) + (peers.length < 2 ? 0 : (index / (peers.length - 1) - .5) * Math.min(30, laneWidth * .65))} cy={y(point.value!)} r={selected === point.key ? 7 : 5} fill={fill} onClick={() => setSelected(point.key)} onKeyDown={event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setSelected(point.key); } }}><title>{label}</title></circle>;
      })}
    </svg></div> : <p role="status">No eligible unit rates for these activities, people and dates.</p>}
    {metric !== "hours" && current && <div className="unit-rate-detail"><strong>{current.job} · Unit {current.unit} · {relative ? current.week : `week ${current.week}`} · from {current.actualWeek}</strong><span>{(current.seconds / 60).toFixed(2)} min ÷ {metric === "area" ? `${current.area.toFixed(2)} ft²` : "1 opening"} = {current.value!.toFixed(3)} {rateUnit}</span>{contributors(current.records).map(person => <span key={person.id}>{person.name} · {profiles.get(person.id)?.role ?? "role unknown"} · {(person.seconds / 60).toFixed(2)} min</span>)}<button type="button" onClick={() => onInspect([...new Set(current.records.map(row => row.id))], [Math.max(from, midnight(current.actualWeek)), Math.min(until, midnight(nextWeekDate(current.actualWeek)))])}>Inspect records</button><button type="button" onClick={() => setSelected(null)}>Clear</button></div>}
  </section>;
}
