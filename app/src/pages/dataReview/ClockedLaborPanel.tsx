import { useRelativeOrigins, relativeOriginWindows } from "./relativeOrigins";
import { ChartFormatToggle, JobWeekControls } from "./ChartTimeControls";
import { isGroupRowControl } from "./groupRowInteraction";
import { TableSelection } from "./TableSelection";
import { useCharts } from "./chartContext";
import { ChartSlot } from "./FloatingCharts";
import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import { useReportShifts } from "./useReportShifts";
import { useQueries } from "@tanstack/react-query";
import { shiftHours } from "../../lib/timeclock";
import { jobTimeReport } from "../../lib/jobTimeReport";
import { reportOwner, reportShifts } from "./reportQueries";
import { clockedDays, clockedWeeks, clockedJobWeeks, clockedRelativeJobWeeks } from "./clockedWeeks";
import { WeeklyLaborPlot } from "./WeeklyLaborPlot";
import { midnight, workDate } from "./generalLabor";

const palette = ["#55b9d2", "#ff743d", "#b29aed", "#e5bb55", "#79c39b", "#e887aa", "#a3b962", "#7994d4", "#cf9d7b", "#b2c8c4", "#d9895f", "#927baf", "#83a6bb"];
export function ClockedLabor({ jobs, from, until, activityRecords, active = true, breakdown = "weekly", jobNames = new Map() }: { jobs: string[] | null; from: number; until: number; activityRecords: ReactNode; active?: boolean; breakdown?: "daily" | "weekly"; onBreakdown?: (value: "daily" | "weekly") => void; jobNames?: Map<string, string> }) {
  const owner = reportOwner();
  const charts = useCharts();
  const [now, setNow] = useState(Date.now);
  useEffect(() => { if (!active) return; setNow(Date.now()); const timer = setInterval(() => setNow(Date.now()), 30000); return () => clearInterval(timer); }, [active]);
  const [open, setOpen] = useState(false);
  const [ids, setIds] = useState<string[] | null>(null);
  const [localChartJobs, setLocalChartJobs] = useState<string[]>([]);
  const chartJobs = charts?.clockedJobs ?? localChartJobs;
  const setChartJobs = (ids: string[]) => charts ? charts.setClockedJobs(ids) : setLocalChartJobs(ids);
  const [expandedJobs, setExpandedJobs] = useState<string[]>([]);
  const [localMetric, setLocalMetric] = useState("hours");
  const metric = charts?.laborFormat ?? localMetric, setMetric = charts?.setLaborFormat ?? setLocalMetric;
  const [separateJobs, setSeparateJobs] = useState(true);
  const [hiddenCodes, setHiddenCodes] = useState<string[]>([]);
  const [localAxis, setLocalAxis] = useState("calendar");
  const timeAxis = charts?.laborAxis ?? localAxis, setTimeAxis = charts?.setLaborAxis ?? setLocalAxis;
  const [localCount, setLocalCount] = useState(8);
  const relativeCount = charts?.laborWeeks ?? localCount, setRelativeCount = charts?.setLaborWeeks ?? setLocalCount;
  const daily = false;
  const relative = !daily && timeAxis === "relative";
  const relativeActive = active && (!charts || (charts.open && charts.view === "clocked" && charts.laborSource === "clocked")) && relative;
  const relativeJobIds = (chartJobs.length ? chartJobs.filter(id => jobs === null || jobs.includes(id)) : [...(jobs ?? [])]).sort();
  const basis = charts?.laborStart ?? "clocked";
  const origins = useRelativeOrigins(owner, relativeJobIds, basis, relativeActive);
  const relativeWindows = relativeOriginWindows(origins.data ?? [], relativeCount);
  const originDates = new Map((origins.data ?? []).filter(origin => origin.jobId && Number.isFinite(Date.parse(origin.startedAt))).map(origin => [origin.jobId, workDate(Date.parse(origin.startedAt))]));
  const relativeQueries = useQueries({ queries: relativeWindows.map(window => ({ ...reportShifts(owner, [window.jobId], window.from, window.until, relativeActive), refetchInterval: false as const })) });
  const relativeRecords = relativeQueries.flatMap(query => query.data ?? []);
  useEffect(() => { if (breakdown === "daily") setTimeAxis("calendar"); }, [breakdown, setTimeAxis]);
  const records = useRef<HTMLDetailsElement>(null);
  const query = useReportShifts(owner, jobs, from, until, active);
  const history = (query.data ?? []).filter(shift => shift.status !== "voided" && (jobs === null || jobs.includes(shift.project_id ?? "")));
  const shifts = history.filter(shift => Date.parse(shift.clock_in_at) >= from && Date.parse(shift.clock_in_at) < until);
  const report = jobTimeReport(shifts, now);
  const chartRecords = relative ? relativeRecords : shifts;
  const chartShifts = chartJobs.length ? chartRecords.filter(shift => chartJobs.includes(shift.project_id ?? "")) : chartRecords;
  const originJobs = [...new Set(shifts.map(shift => shift.project_id ?? ""))].sort();
  const tableJobs = [...originJobs].sort((a, b) => (jobNames.get(a) ?? shifts.find(shift => shift.project_id === a)?.projects?.job_code ?? a).localeCompare(jobNames.get(b) ?? shifts.find(shift => shift.project_id === b)?.projects?.job_code ?? b, undefined, { numeric: true }));
  const split = relative || (separateJobs && (chartJobs.length > 1 || (jobs !== null && jobs.length > 1)));
  const dailyJobs = split ? new Map((chartJobs.length ? chartJobs : jobs ?? originJobs).map(id => [id || "unassigned", jobNames.get(id) ?? shifts.find(shift => shift.project_id === id)?.projects?.job_code ?? (id || "No job")])) : undefined;
  const weeks = (daily ? clockedDays(chartShifts, from, until, dailyJobs, now) : relative ? clockedRelativeJobWeeks(chartShifts, [], relativeCount, originDates) : split ? clockedJobWeeks(chartShifts) : clockedWeeks(chartShifts)).map(week => ({ ...week, partial: week.partial || (!relative && (midnight(week.key) < from || midnight(new Date(Date.parse(`${week.key}T12:00:00Z`) + (daily ? 1 : 7) * 86400000).toISOString().slice(0, 10)) > until)) }));
  const codes = [...new Set(weeks.flatMap(week => week.segments.map(segment => segment.activity)))].sort();

  const plotted = weeks.map(week => {
    const segments = week.segments.filter(segment => !hiddenCodes.includes(segment.activity));
    const seconds = segments.reduce((total, segment) => total + segment.seconds, 0);
    return { ...week, segments, seconds, ids: segments.flatMap(segment => segment.ids), percent: week.totalSeconds ? seconds / week.totalSeconds * 100 : null };
  });
  const inspected = ids ? [...new Map([...shifts, ...relativeRecords].map(shift => [shift.id, shift])).values()].filter(shift => ids.includes(shift.id)) : shifts;
  const showRecords = (next: string[]) => { charts?.close(); setIds(next); setOpen(true); requestAnimationFrame(() => records.current?.scrollIntoView({ behavior: "smooth", block: "start" })); };
  // Never retain a point selection across a different job or date window.
  const selectionKey = `${jobs?.join(",") ?? "all"}/${from}/${until}`;
  useEffect(() => { setChartJobs([]); setExpandedJobs([]);
    // Selection belongs to this page window, not provider callback identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectionKey]);
  useEffect(() => { setIds(null); }, [selectionKey, hiddenCodes, metric, separateJobs, timeAxis, breakdown]);
  const clockTable = (records: typeof shifts, groupedByJob = false) => <div className="activity-table"><table><caption className="activity-sr-only">Saved clock records</caption><thead><tr><th>Date</th>{!groupedByJob && <th>Job</th>}<th>Person</th><th>Cost code</th><th>Hours</th><th>Status</th></tr></thead><tbody>{records.map(shift => <tr key={shift.id}><td>{workDate(Date.parse(shift.clock_in_at))}</td>{!groupedByJob && <td>{shift.projects?.job_code ?? "No job"}</td>}<td>{shift.profiles?.display_name ?? "Unknown"}</td><td>{shift.cost_codes?.code ?? "No code"}</td><td>{shift.clock_out_at ? shiftHours(shift).toFixed(2) : "Running / unresolved"}</td><td>{shift.status}</td></tr>)}</tbody></table></div>;
  return <section className="clocked-labor" aria-label="Clocked labor baseline">
    {jobs?.length === 0 ? <p role="status">Select jobs to load clocked labor.</p> : query.isPending ? <p role="status">Loading clocked labor…</p> : query.error ? <p role="alert">Clocked labor could not be loaded. No clocked totals are shown.</p> : <>
      <div className="clocked-stats"><div><strong>{report.totalHours.toFixed(1)} h</strong><span>Clocked · after breaks</span></div><div><strong>{report.peopleCount}</strong><span>People</span></div><div><strong>{report.recordedCount}</strong><span>Finished shifts</span></div></div>
      <p className="activity-unit-note">{report.recordedHours.toFixed(1)} finished h · {report.runningHours.toFixed(1)} running h · {report.unresolvedCount} unresolved shifts. Activity timers are separate evidence, never added to clocked hours.</p>
      <details className="clocked-records" ref={records} open={open} onToggle={event => setOpen(event.currentTarget.open)}>
        <summary>{ids ? "Selected chart clock records" : "Clock records"} · {ids ? inspected.length : shifts.length}</summary>
        {charts && <div className="activity-table report-standard-table"><table><caption className="activity-sr-only">Clocked labor by job</caption><thead><tr><th className="report-check-cell"><TableSelection label="Select all clocked jobs" checked={originJobs.length > 0 && originJobs.every(id => chartJobs.includes(id))} mixed={chartJobs.length > 0} onChange={() => setChartJobs(originJobs.every(id => chartJobs.includes(id)) ? [] : originJobs)} /></th><th scope="col">Job</th><th scope="col" className="report-number">Shifts</th><th scope="col" className="report-number">People</th><th scope="col" className="report-number">Hours</th></tr></thead><tbody>{tableJobs.map(id => {
          const matching = shifts.filter(shift => (shift.project_id ?? "") === id);
          const totals = jobTimeReport(matching, now);
          const label = jobNames.get(id) ?? matching[0]?.projects?.job_code ?? "No job";
          const expanded = expandedJobs.includes(id);
          return <Fragment key={id}><tr className="report-group-row" onClick={event => { if (!isGroupRowControl(event.target)) setExpandedJobs(old => old.includes(id) ? old.filter(value => value !== id) : [...old, id]); }} data-selected={chartJobs.includes(id) || undefined}><td className="report-check-cell"><TableSelection label={`Select clocked ${label}`} checked={chartJobs.includes(id)} onChange={() => setChartJobs(chartJobs.includes(id) ? chartJobs.filter(value => value !== id) : [...chartJobs, id])} /></td><th scope="row"><button type="button" className="report-expand" aria-label={`${expanded ? "Collapse" : "Expand"} clocked ${label}`} aria-expanded={expanded} onClick={() => setExpandedJobs(old => old.includes(id) ? old.filter(value => value !== id) : [...old, id])}><span aria-hidden="true">{expanded ? "▾" : "▸"}</span>{label}</button></th><td className="report-number">{matching.length}</td><td className="report-number">{totals.peopleCount}</td><td className="report-number">{totals.totalHours.toFixed(2)}</td></tr>{expanded && <tr className="report-leaf-row"><td colSpan={5}>{clockTable(matching, true)}</td></tr>}</Fragment>;
        })}</tbody></table></div>}
        {ids && <button type="button" onClick={() => setIds(null)}>Clear clock selection</button>}
        {open && (!charts || ids) && clockTable(inspected)}
      </details>
    </>}
    {!query.isPending && !query.error && <ChartSlot view="clocked"><section aria-label="Weekly clocked labor">{chartJobs.length > 0 && <p>{chartJobs.map(id => jobNames.get(id) ?? id).join(" + ")} <button type="button" onClick={() => setChartJobs([])}>All selected jobs</button></p>}<h2>Clocked labor</h2><p className="activity-unit-note">Finished clocked hours after breaks, stacked by saved cost code. {daily ? "Denver calendar days; shifts belong to their clock-in day." : relative ? "Week 1 starts on each job’s selected recorded origin; each week spans seven Denver days. This chart uses the first N weeks and ignores page dates. Page totals/tables keep the calendar range. Recorded start is not an agreed job start or phase." : "Calendar weeks start Monday in Denver; shifts belong to their clock-in week."} Running hours stay in the totals above.</p>
      <div className="clocked-chart-controls">
        {!charts && <ChartFormatToggle value={metric} onChange={setMetric} />}
        <JobWeekControls label="Clocked chart" axis={timeAxis} count={relativeCount} onAxis={setTimeAxis} onCount={setRelativeCount} />
        {!relative && jobs !== null && jobs.length > 1 && <label>Compare<select aria-label="Clocked chart comparison" value={separateJobs ? "jobs" : "combined"} onChange={event => setSeparateJobs(event.target.value === "jobs")}><option value="jobs">Separate jobs</option><option value="combined">Combined</option></select></label>}
      </div>
      <div className="clocked-code-legend" role="group" aria-label="Chart cost codes">{codes.map((code, index) => <button type="button" key={code} aria-pressed={!hiddenCodes.includes(code)} onClick={() => setHiddenCodes(old => old.includes(code) ? old.filter(value => value !== code) : [...old, code])}><i aria-hidden="true" style={{ background: palette[index % palette.length] }} />{code}</button>)}{hiddenCodes.some(code => codes.includes(code)) && <button type="button" className="clocked-code-reset" onClick={() => setHiddenCodes([])}>Show all</button>}</div>
      {relative && !relativeJobIds.length ? <p>Select page jobs to compare their first weeks.</p> : relative && (origins.error || relativeQueries.some(query => query.error)) ? <p role="alert">Relative-week records could not be loaded. No relative totals are shown.</p> : relative && (origins.isPending || relativeQueries.some(query => query.isPending)) ? <p role="status">Loading first-work dates and selected weeks…</p> : weeks.length ? <WeeklyLaborPlot period={daily ? "day" : "week"} buckets={plotted} metric={metric} color={code => palette[codes.indexOf(code) % palette.length]} from={relative ? -Infinity : from} until={relative ? Infinity : until} onInspect={showRecords} laborLabel={split ? daily ? "job-day clocked hours" : "job-week clocked hours" : "clocked labor"} /> : <p>{relative ? "No finished shifts in the selected job-week windows." : "No finished shifts for these jobs and dates."}</p>}
      <p className="activity-unit-note">Percent uses each job’s full {daily ? "day" : "week"}, including hidden cost codes. Cost codes describe saved shift allocations, not verified opening work. Tap segments to inspect shifts.</p>
    </section></ChartSlot>}
    {activityRecords}
  </section>;
}
