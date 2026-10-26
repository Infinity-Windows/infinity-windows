import { useCharts } from "./chartContext";
import { useState } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import type { ActivityRow } from "./activityRows";
import { activityRows } from "./activityRows";
import type { WorkUnit } from "../../lib/customWork/model";
import type { Profile } from "../../lib/install/types";
import { useRelativeOrigins, relativeOriginWindows } from "./relativeOrigins";
import { listWorkSessions, listWorkUnits } from "../../lib/customWork/api";
import { reportOwner, reportQueryPolicy } from "./reportQueries";

import { workDate } from "./generalLabor";
import { historicalRows, readHistoricalLabor, reconcileHistorical } from "./historicalLabor";
import { readOpeningContexts } from "./openingReviewContext";
import { enrichActivityRows } from "./reportingFacts";
import { JobWeekControls } from "./ChartTimeControls";
import { WeeklyUnitRates } from "./WeeklyUnitRateChart";

export function WeeklyUnitRatesReport({ rows, units, people = [], jobLabels = new Map(), jobs, from, until, source, filter, onInspect }: {
  jobLabels?: Map<string, string>; rows: ActivityRow[]; units: WorkUnit[]; people?: Profile[]; jobs: string[] | null; from: number; until: number; source: string;
  filter: (row: ActivityRow) => boolean; onInspect: (ids: string[], interval: [number, number], records?: ActivityRow[]) => void;
}) {
  const charts = useCharts();
  const [localAxis, setLocalAxis] = useState("calendar"), [localCount, setLocalCount] = useState(8);
  const axis = charts?.laborAxis ?? localAxis, setAxis = charts?.setLaborAxis ?? setLocalAxis;
  const count = charts?.laborWeeks ?? localCount, setCount = charts?.setLaborWeeks ?? setLocalCount;
  const owner = reportOwner(), relative = axis === "relative", ids = [...(jobs ?? [])].sort();
  const basis = charts?.laborStart ?? "clocked";
  const origins = useRelativeOrigins(owner, ids, basis, relative);
  const windows = relativeOriginWindows(origins.data ?? [], count);
  const timers = useQueries({ queries: windows.map(window => ({ ...reportQueryPolicy, queryKey: ["dataReview", owner, "workSessions", [window.jobId], workDate(window.from), workDate(window.until - 1)], queryFn: ({ signal }: { signal: AbortSignal }) => listWorkSessions(undefined, undefined, { projectIds: [window.jobId], from: window.from, until: window.until, signal }), enabled: relative && source !== "historical" })) });
  const visits = useQueries({ queries: windows.map(window => ({ ...reportQueryPolicy, queryKey: ["dataReview", owner, "historical", window.jobId, workDate(window.from), workDate(window.until - 1)], queryFn: ({ signal }: { signal: AbortSignal }) => readHistoricalLabor([window.jobId], window.from, window.until, signal), enabled: relative && source !== "custom" })) });
  const unitQuery = useQuery({ ...reportQueryPolicy, queryKey: ["dataReview", owner, "units", ids], queryFn: ({ signal }) => listWorkUnits(undefined, signal, ids), enabled: relative && ids.length > 0 });
  const allUnits = relative ? unitQuery.data ?? [] : units;
  const names = new Map(people.map(person => [person.id, person.display_name]));
  const raw = windows.flatMap((_, index) => {
    const custom = activityRows(timers[index]?.data ?? [], allUnits, names).rows;
    const historical = historicalRows(visits[index]?.data ?? [], allUnits, names, -Infinity, Infinity);
    return source === "custom" ? custom : source === "historical" ? historical : reconcileHistorical(custom, historical).rows;
  });
  const openingIds = [...new Set(raw.map(row => row.openingId).filter((id): id is string => !!id))].sort();
  const context = useQuery({ ...reportQueryPolicy, queryKey: ["dataReview", owner, "openingReview", openingIds.join(","), "taxonomy-v3-drawing-review"], queryFn: ({ signal }) => readOpeningContexts(openingIds, signal), enabled: relative && openingIds.length > 0 });
  const jobNames = new Map(origins.data?.map(shift => [shift.jobId, shift.job ?? jobLabels.get(shift.jobId) ?? rows.find(row => row.jobId === shift.jobId)?.job ?? "Unknown job"]) ?? []);
  const enriched = enrichActivityRows(raw, allUnits, context.data ?? new Map()).map(row => ({ ...row, job: jobNames.get(row.jobId ?? "") ?? row.job })).filter(filter);
  const anchors = new Map((origins.data ?? []).filter(shift => !!shift.jobId && Number.isFinite(Date.parse(shift.startedAt))).map(shift => [shift.jobId, workDate(Date.parse(shift.startedAt))]));
  const controls = <JobWeekControls label="Unit rates" axis={axis} count={count} onAxis={setAxis} onCount={setCount} />;
  const enabledQueries = [origins, unitQuery, ...(source === "historical" ? [] : timers), ...(source === "custom" ? [] : visits), ...(openingIds.length ? [context] : [])];
  const error = relative && enabledQueries.some(query => query.error);
  const loading = relative && enabledQueries.some(query => query.isPending);
  const missing = relative && ids.filter(id => !anchors.has(id));
  return <>{relative && (!ids.length || error || loading) ? <><div className="weekly-rate-controls">{controls}</div><p role={error ? "alert" : "status"}>{!ids.length ? "Select page jobs for relative unit rates." : error ? "Relative unit evidence could not be loaded; no rates shown." : "Loading first-work dates and selected unit evidence…"}</p></> : <>
    {missing && missing.length > 0 && <p role="status">{missing.length} jobs have no recorded origin for this alignment; not plotted.</p>}
    <WeeklyUnitRates metric={charts?.laborMeasure ?? "area"} format={charts?.laborFormat ?? "hours"} rows={relative ? enriched : rows} units={allUnits} people={people} from={relative ? -Infinity : from} until={relative ? Infinity : until} timeControls={controls} relative={relative ? { anchors, count, basis } : undefined} onInspect={(recordIds, interval) => onInspect(recordIds, interval, relative ? enriched : undefined)} />
  </>}</>;
}
