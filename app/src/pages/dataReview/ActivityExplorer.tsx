import {ReportDateRange} from "./ReportDateRange";
import {useEffect,useMemo,useState} from "react";
import {useQuery} from "@tanstack/react-query";
import {RecordScatter} from "./RecordScatter";
import {readAvailableJobs,includedJobs} from "./availableJobs";
import {UnitFirstTable} from "./UnitFirstTable";
import {useCharts} from "./chartContext";
import {FloatingCharts,ChartSlot} from "./FloatingCharts";
import {readOpeningContexts} from "./openingReviewContext";
import {enrichActivityRows} from "./reportingFacts";
import {ClockedLabor} from "./ClockedLaborPanel";
import {historicalRows,readHistoricalLabor,reconcileHistorical} from "./historicalLabor";
import {midnight} from "./generalLabor";
import {listWorkSessions,listWorkUnits} from "../../lib/customWork/api";
import {listProfiles} from "../../lib/install/api";
import {ReportingMultiSelect as MultiSelect} from "./ReportingMultiSelect";
import {facetColors,presetRange,denverToday,type RangePreset} from "./reportControls";
import {activityRows} from "./activityRows";
import {reportOwner,reportProjects,reportQueryPolicy} from "./reportQueries";

export function ActivityExplorer({ active = true }: { active?: boolean }) {
  return <FloatingCharts active={active}><ActivityWorkspace active={active} /></FloatingCharts>;
}
function ActivityWorkspace({ active }: { active: boolean }) {
  const charts = useCharts();
  const owner = reportOwner();
  const [pageJobs, setPageJobs] = useState<string[] | null>(null);

  const includeRework = true;
  const [rangePreset, setRangePreset] = useState<RangePreset>("month");
  const [initialRange] = useState(() => presetRange("month", denverToday()));
  const [from, setFrom] = useState(initialRange.from); const [until, setUntil] = useState(initialRange.until);

  // Owner-only discovery: the existing paginated reader checks completeness.
  const projects = useQuery(reportProjects(owner, active));

  const selectionBoundary = JSON.stringify([pageJobs, from, until, includeRework]);
  const clearChartScopes = () => charts?.setScopes([]);
  useEffect(() => { clearChartScopes?.(); /* Row selections belong to this filter window. */
    // The provider callback changes with its selection; only the boundary resets it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectionBoundary]);
  const rangeFrom = from ? midnight(from) : -Infinity;
  const rangeUntil = until ? midnight(new Date(Date.parse(`${until}T12:00:00Z`) + 86400000).toISOString().slice(0, 10)) : Infinity;
  const recentRefresh=active&&Number.isFinite(rangeFrom)&&Number.isFinite(rangeUntil)&&rangeUntil-rangeFrom<=45*86400000?5*60000:false;
  const available = useQuery({...reportQueryPolicy,refetchInterval:recentRefresh,refetchIntervalInBackground:false,queryKey:["dataReview",owner,"availableJobs",from,until],queryFn:({signal})=>readAvailableJobs(rangeFrom,rangeUntil,signal),enabled:active && rangeFrom<rangeUntil});
  const selectedJobIds = includedJobs(available.data ?? [],pageJobs);
  const effectiveJobs = selectedJobIds;
  useEffect(()=>{setPageJobs(null);},[from,until]);
  const scoped = active && !!projects.data && rangeFrom < rangeUntil && selectedJobIds.length > 0;
  const sessions = useQuery({ ...reportQueryPolicy, refetchInterval:recentRefresh,refetchIntervalInBackground:false,queryKey: ["dataReview", owner, "workSessions", selectedJobIds, from, until], queryFn: ({ signal }) => listWorkSessions(undefined, undefined, { projectIds: selectedJobIds, from: rangeFrom, until: rangeUntil, signal }), enabled: scoped });
  const historical = useQuery({ ...reportQueryPolicy, refetchInterval:recentRefresh,refetchIntervalInBackground:false,queryKey: ["dataReview", owner, "historical-phases-v1", selectedJobIds.join(","), from, until], queryFn: ({ signal }) => readHistoricalLabor(selectedJobIds, rangeFrom, rangeUntil, signal, true), enabled: scoped, placeholderData: undefined });
  const people = useQuery({ ...reportQueryPolicy, queryKey: ["dataReview", owner, "people"], queryFn: listProfiles, enabled: scoped });
  const jobStatuses = useMemo(()=>new Map((projects.data ?? []).map(p => [p.id, p.status ?? "Unknown"])),[projects.data]);
  const jobNames = useMemo(()=>new Map((projects.data ?? []).map(p => [p.id, p.job_code || p.name])),[projects.data]);

  const unitJobs = selectedJobIds;
  const units = useQuery({ ...reportQueryPolicy, queryKey: ["dataReview", owner, "units", unitJobs], queryFn: ({ signal }) => listWorkUnits(undefined, signal, unitJobs), enabled: scoped && unitJobs.length > 0 });
  const allUnits = units.data ?? [];
  const timedUnitIds = new Set((sessions.data ?? []).map(session => session.unit_id));
  const openingIds = [...new Set([...allUnits.filter(unit => timedUnitIds.has(unit.id)).map(unit => unit.opening_id), ...(historical.data ?? []).map(session => session.opening_id)].filter((id): id is string => !!id))].sort();
  const openingContext = useQuery({ ...reportQueryPolicy, queryKey: ["dataReview", owner, "openingReview", openingIds.join(","), "taxonomy-v4-catalog-dimensions"], queryFn: ({ signal }) => readOpeningContexts(openingIds, signal), enabled: scoped && !!openingIds.length });
  const enrich = (records: ReturnType<typeof activityRows>["rows"]) => enrichActivityRows(records, allUnits, openingContext.data ?? new Map());
  const personNames = useMemo(() => new Map((people.data ?? []).map(p => [p.id, p.display_name])), [people.data]);
  const source=useMemo(()=>activityRows((sessions.data??[]).filter(s=>!!s.project_id),allUnits,personNames,rangeFrom,rangeUntil),[sessions.data,allUnits,personNames,rangeFrom,rangeUntil]);
  const oldRows=useMemo(()=>historicalRows(historical.data??[],allUnits,personNames,rangeFrom,rangeUntil),[historical.data,allUnits,personNames,rangeFrom,rangeUntil]);
  const reconciliation=useMemo(()=>reconcileHistorical(source.rows,oldRows),[source.rows,oldRows]);
  const reportRows = enrich(reconciliation.rows);
  const laborRows = reportRows;
  const pageRows = laborRows.map(r => ({ ...r, job: jobNames.get(r.jobId ?? "") ?? r.job })).filter(row => pageJobs === null || pageJobs.includes(row.jobId ?? ""));
  const inspectedRows=pageRows;
  const jobOptions=(available.data??[]).map(id=>({key:id,label:jobNames.get(id)??id})).sort((a,b)=>a.label.localeCompare(b.label));
  const datesValid=rangeFrom<rangeUntil;
  const pageControls = <div className="report-page-controls">

    <div className="report-top-controls">
      <MultiSelect label="Jobs" options={jobOptions} value={pageJobs===null ? null : effectiveJobs} onChange={job => { setPageJobs(job);   }} color={facetColors.job} />

    </div>
    <ReportDateRange from={from} until={until} preset={rangePreset} onChange={(start,end,preset)=>{setFrom(start);setUntil(end);setRangePreset(preset);}}/>
    <div className="report-top-controls"><select aria-label="Charts" className="report-chart-shortcuts" value="" onChange={event=>{const view=event.target.value as "records"|"clockCompare";charts?.show(view);}}><option value="" disabled>Charts</option><option value="records">Record scatter</option><option value="clockCompare">Clocked labor by job</option></select></div>


  </div>;
  const recordInspector = <>
    <section className="activity-inspection report-records-workspace" aria-label="Activity table">
      <div id="activity-record-table">
        <UnitFirstTable jobs={effectiveJobs} jobNames={jobNames} rows={inspectedRows} reviewRows={enrich([...reconciliation.rows,...reconciliation.held]).map(row=>({...row,job:jobNames.get(row.jobId ?? "") ?? row.job}))} active={active} />
      </div>
    </section>
  </>;
  return <div className="activity-explorer">
    {pageControls}
    {!datesValid ? <p role="alert">Start date must not be after the end date.</p> : <>
      <ClockedLabor includeUnassigned={pageJobs === null || pageJobs.length === 0} jobStatuses={jobStatuses} includeRework={includeRework} jobNames={jobNames} active={active} jobs={effectiveJobs} from={rangeFrom} until={rangeUntil} activityRecords={null} />
    <section className="activity-partial-evidence" aria-label="Units and linked work">
    {available.error||projects.error?<p role="alert">Job availability could not be loaded.</p>:sessions.error||historical.error||units.error||openingContext.error||people.error?<p role="alert">Activity evidence could not be loaded. Clocked hours remain separate.</p>:scoped&&(sessions.isPending||historical.isPending||units.isPending||people.isPending||(openingIds.length>0&&openingContext.isPending))?<p role="status">Tracing recorded activities…</p>:recordInspector}
      <ChartSlot view="records"><RecordScatter people={personNames} roles={new Map((people.data??[]).map(p=>[p.id,p.role]))} jobs={effectiveJobs} jobNames={jobNames} from={rangeFrom} until={rangeUntil} timers={[...reconciliation.rows,...reconciliation.held]} active={active && !!charts?.open && charts.view === "records"}/></ChartSlot>
    </section>
    </>}
  </div>;
}
