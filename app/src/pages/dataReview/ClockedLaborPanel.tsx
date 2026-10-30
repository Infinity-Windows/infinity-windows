import {ClockedJobComparison} from "./ClockedJobComparison";
import { UsersRound, Clock3, PanelsTopLeft, Gauge } from "lucide-react";
import { useJobScope } from "./useJobScope";
import { JobsTable } from "./JobsTable";
import { isReworkShift } from "./reworkEvidence";
import { useCharts } from "./chartContext";
import { ChartSlot } from "./FloatingCharts";
import { useEffect, useState, useId, type ReactNode } from "react";
import { useReportShifts } from "./useReportShifts";
import { useQuery } from "@tanstack/react-query";
import { jobTimeReport } from "../../lib/jobTimeReport";
import { reportOwner, reportUnassignedShifts } from "./reportQueries";

export function ClockedLabor({ includeRework = true, includeUnassigned = true, jobs, from, until, activityRecords, active = true, jobNames = new Map(), jobStatuses = new Map() }: { includeRework?: boolean; includeUnassigned?: boolean; jobs: string[] | null; from: number; until: number; activityRecords: ReactNode; active?: boolean; breakdown?: "daily" | "weekly"; onBreakdown?: (value: "daily" | "weekly") => void; jobStatuses?: Map<string,string>; jobNames?: Map<string, string> }) {
  const rateInfoId=useId();
  const [excludedCodes,setExcludedCodes]=useState<string[]>([]);
  const owner = reportOwner();
  const charts = useCharts();
  const [now, setNow] = useState(Date.now);
  useEffect(() => { if (!active) return; setNow(Date.now()); const timer = setInterval(() => setNow(Date.now()), 30000); return () => clearInterval(timer); }, [active]);
  const [localChartJobs, setLocalChartJobs] = useState<string[]>([]);
  const chartJobs = charts?.clockedJobs ?? localChartJobs;
  const setChartJobs = (ids: string[]) => charts ? charts.setClockedJobs(ids) : setLocalChartJobs(ids);
  const query = useReportShifts(owner, jobs, from, until, active);
  const separateUnassigned=includeUnassigned&&jobs!==null;
  const unassigned = useQuery(reportUnassignedShifts(owner, from, until, active && separateUnassigned));
  const history = [...(query.data ?? []), ...(separateUnassigned ? (unassigned.data ?? []).filter(shift=>!shift.project_id) : [])].filter(shift => shift.status !== "voided" && (includeRework || !isReworkShift(shift)) && (includeUnassigned && !shift.project_id || jobs === null || jobs.includes(shift.project_id ?? "")));
  const shifts = [...new Map(history.map(shift=>[shift.id,shift])).values()].filter(shift => Date.parse(shift.clock_in_at) >= from && Date.parse(shift.clock_in_at) < until);
  const includedShifts=shifts.filter(shift=>!excludedCodes.includes(shift.cost_code_id??"no-code"));
  const report = jobTimeReport(includedShifts, now);
  const originJobs = [...new Set(shifts.map(shift => shift.project_id ?? ""))].sort();

  const jobScope = useJobScope(jobs ?? originJobs, active);
  const rateJobs=[...jobScope.scopes].map(([id,facts])=>({facts,report:jobTimeReport(includedShifts.filter(shift=>shift.project_id===id),now)})).filter(item=>item.facts.area>0&&item.report.recordedCount>0);
  const rateArea=rateJobs.reduce((sum,item)=>sum+item.facts.area,0);
  const rateMinutes=rateJobs.reduce((sum,item)=>sum+item.report.recordedHours*60,0);
  const approximateRate=rateArea>0?rateMinutes/rateArea:null;
  const rateHelp=`Approximate clocked minutes per known opening sq ft: ${rateMinutes.toFixed(1)} finished minutes after breaks / ${rateArea.toLocaleString("en-US",{maximumFractionDigits:0})} known ft² across ${rateJobs.length} jobs. Includes visible cost codes and rework in page dates; uses each job's current known opening area once, including unfinished openings. Excludes running time, unassigned labor and jobs without usable area. This is period labor intensity, not completed-unit installation productivity. Consistent, confirmed measurements improve the denominator; reliable unit activity links, worker attribution and completion dates would support more precise installed-work comparisons. Activity timers are separate and are not added to clocked hours.`;
  const installedScopes=[...jobScope.scopes.values()];
  const installedTotal=installedScopes.reduce((sum,scope)=>sum+scope.installed,0);
  const installedDated=installedScopes.flatMap(scope=>scope.installedDates??[]);
  const installedInDates=installedDated.filter(date=>Date.parse(date)>=from&&Date.parse(date)<until).length;
  // Never retain a point selection across a different job or date window.
  const selectionKey = `${jobs?.join(",") ?? "all"}/${from}/${until}`;
  useEffect(() => { setChartJobs([]);
    // Selection belongs to this page window, not provider callback identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectionKey]);

  return <section className="clocked-labor" aria-label="Clocked labor baseline">
    {jobs?.length === 0 && !includeUnassigned ? <p role="status">Select jobs to load clocked labor.</p> : (jobs?.length !== 0 && query.isPending || separateUnassigned && unassigned.isPending) ? <p role="status">Loading clocked labor…</p> : (query.error || separateUnassigned && unassigned.error) ? <p role="alert">Clocked labor could not be loaded. No clocked totals are shown.</p> : <>
      <div className="clocked-stats"><div title="Clocked hours after breaks; includes running clocks"><strong>{report.totalHours.toLocaleString("en-US",{maximumFractionDigits:0})} <Clock3 size={18} aria-label="Clocked hours"/></strong></div><div><strong>{jobScope.loading?"…":jobScope.error||approximateRate===null?"--":`${approximateRate.toFixed(2)} m/ft²`} <button type="button" className="clocked-rate-info" aria-label="About approximate minutes per square foot" title="About this approximation" popoverTarget={rateInfoId}><Gauge size={18} aria-hidden="true"/></button></strong><span id={rateInfoId} popover="auto" className="clocked-rate-explanation">{rateHelp}</span></div><div title="People with clock records"><strong>{report.peopleCount} <UsersRound size={18} aria-hidden="true"/></strong></div><div title={`${installedInDates} recorded installed openings have a completion timestamp in page dates; ${installedTotal} currently installed across these jobs, ${installedTotal-installedDated.length} without completion timestamps. Status evidence does not establish full job completion.`}><strong>{jobScope.loading?"…":jobScope.error?"—":installedTotal>0&&!installedDated.length?"—":installedInDates} <PanelsTopLeft size={18} aria-label="Installed openings with completion dates in range"/></strong></div></div>
      <JobsTable excludedCodes={excludedCodes} onExcludedCodes={setExcludedCodes} scope={jobScope} includeUnassigned={includeUnassigned} key={selectionKey} jobs={jobs ?? originJobs} records={shifts} names={jobNames} statuses={jobStatuses} selected={chartJobs} onSelect={setChartJobs} onCompare={()=>{charts?.setScopes([]);charts?.show("clockCompare");}} />
    </>}
    <ChartSlot view="clockCompare"><ClockedJobComparison records={chartJobs.length?includedShifts.filter(shift=>chartJobs.includes(shift.project_id??"")):includedShifts} scopes={jobScope.scopes} names={jobNames} loading={jobScope.loading} error={!!jobScope.error}/></ChartSlot>
    {activityRecords}
  </section>;
}
