import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { listProjectsAnyStatus } from "../lib/api";
import { useT } from "../lib/i18n";
import "../lib/i18n/workDataCatalog";
import type { WorkDataKey } from "../lib/i18n/workDataCatalog";
import { roleRank } from "../lib/nav";
import { signInMark, signInGeneration, subscribeSignedIn, stillSignedInAs } from "../lib/signedIn";
import { useEffectiveRole } from "../lib/useEffectiveRole";
import { fetchWorkDataSnapshot } from "../lib/workData/api";
import { reconcileWorkday } from "../lib/workData/reconcile";
import { unitLabor } from "../lib/workData/cohorts";
import { WorkDataExplorer } from "../components/workData/WorkDataExplorer";
import "./WorkData.css";

function subscribeNetwork(cb: () => void) {
  window.addEventListener("online", cb); window.addEventListener("offline", cb);
  return () => { window.removeEventListener("online", cb); window.removeEventListener("offline", cb); };
}
const onlineNow = () => navigator.onLine;
const day = (offset: number) => {
  const d = new Date(); d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const duration = (seconds: number) => `${(seconds / 3600).toFixed(2)} h`;
const stamp = (value: string) => new Date(value).toLocaleString();
const statuses = new Set(["open", "submitted", "approved", "rejected", "needs_finish", "voided"]);
const issueKeys = new Set(["dimensions_missing", "dimensions_unverified", "incomplete", "qc_not_accepted",
  "untimed_evidence", "rework", "unresolved_evidence", "payroll_not_approved", "coverage_exception", "outside_payroll",
  "no_attributed_labor", "break_placement_unknown", "overlapping_payroll_shifts", "project_mismatch", "outside_shift",
  "activity_during_break", "invalid_shift", "invalid_claim", "invalid_break", "invalid_running_break", "shift_needs_finish",
  "overlapping_breaks", "live_rounding", "finish_after_snapshot", "clock_review_required"]);

export function WorkData() {
  const t = useT();
  const generation = useSyncExternalStore(subscribeSignedIn, signInGeneration, signInGeneration);
  const online = useSyncExternalStore(subscribeNetwork, onlineNow, () => false);
  const role = useEffectiveRole();
  if (role.isLoading) return <div className="page"><p>{t("wdata.loading")}</p></div>;
  if (role.isPreviewing || roleRank(role.realRole) < roleRank("supervisor") || roleRank(role.effectiveRole) < roleRank("supervisor"))
    return <div className="page"><h1>{t("wdata.title")}</h1><p>{t("wdata.restricted")}</p></div>;
  if (!online) return <div className="page"><h1>{t("wdata.title")}</h1><p>{t("wdata.offline")}</p></div>;
  return <WorkDataReport key={`${generation}:${role.realRole}:${role.effectiveRole}`} boundary={`${generation}:${role.realRole}:${role.effectiveRole}`} />;
}

function WorkDataReport({ boundary }: { boundary: string }) {
  const t = useT();
  const client = useQueryClient();
  const [projectId, setProjectId] = useState("");
  const [fromDay, setFromDay] = useState(() => day(-6));
  const [untilDay, setUntilDay] = useState(() => day(0));
  const mark = signInMark();
  useEffect(() => () => {
    // Only this boundary's private in-memory data; no durable field queues.
    const predicate = (q: { queryKey: readonly unknown[] }) =>
      (q.queryKey[0] === "workDataSnapshot" || q.queryKey[0] === "workDataProjects") && q.queryKey[1] === boundary;
    void client.cancelQueries({ predicate }); client.removeQueries({ predicate });
  }, [boundary, client]);
  const projects = useQuery({ queryKey: ["workDataProjects", boundary], gcTime: 0, staleTime: 0,
    queryFn: async () => {
      const who = mark.userId;
      if (!who) throw new Error("Sign in before reading work evidence.");
      const rows = await listProjectsAnyStatus();
      if (!stillSignedInAs(mark, who)) throw new Error("Sign-in changed.");
      return rows;
    }, retry: false });
  const from = new Date(`${fromDay}T00:00:00`);
  const until = new Date(`${untilDay}T00:00:00`); until.setDate(until.getDate() + 1);
  const datesValid = Number.isFinite(from.getTime()) && Number.isFinite(until.getTime()) &&
    until > from && until.getTime() - from.getTime() <= 93 * 86400000;
  const fromIso = datesValid ? from.toISOString() : "";
  const untilIso = datesValid ? until.toISOString() : "";
  const snapshot = useQuery({ queryKey: ["workDataSnapshot", boundary, projectId, fromIso, untilIso],
    queryFn: ({ signal }) => fetchWorkDataSnapshot({ projectId, from: fromIso, until: untilIso, signal }),
    enabled: !!projectId && datesValid, gcTime: 0, staleTime: 0, retry: false });
  const report = useMemo(() => {
    if (!snapshot.data) return null;
    const data = snapshot.data;
    const coverage = reconcileWorkday(data.shifts, data.claims, [], Date.parse(data.asOf));
    const units = unitLabor(data.units, data.claims, coverage);
    const sources = new Map(data.claims.map(c => [c.sourceId, c]));
    const activities = new Map<string, { label: string; scope: "general" | "specific" | "setup" | "other"; seconds: number }>();
    for (const row of coverage) for (const slice of row.slices) {
      if (slice.sourceIds.length !== 1 || !["general", "specific", "setup", "other"].includes(slice.kind)) continue;
      const source = sources.get(slice.sourceIds[0]); if (!source) continue;
      const key = `${source.scope}:${source.activityId}`;
      const activity = activities.get(key) ?? { label: source.label, scope: source.scope, seconds: 0 };
      activity.seconds += slice.seconds; activities.set(key, activity);
    }
    return { data, coverage, units, activities: [...activities].sort((a, b) => b[1].seconds - a[1].seconds) };
  }, [snapshot.data]);
  const sum = (key: "payrollSeconds" | "classifiedSeconds" | "unknownSeconds" | "conflictSeconds" | "unpaidBreakSeconds") =>
    report?.coverage.reduce((n, row) => n + row[key], 0) ?? 0;
  const issue = (value: string) => {
    const code = value.split(":")[0];
    return issueKeys.has(code) ? t(`wdata.${code}` as WorkDataKey) : t("wdata.coverage_exception");
  };
  return <div className="page work-data">
    <header className="page-header"><h1>{t("wdata.title")}</h1><Link to="/summary" className="button-like">{t("wdata.summary")}</Link></header>
    <p>{t("wdata.intro")}</p>
    <div className="work-data-filters">
      <label>{t("wdata.job")}<select value={projectId} onChange={e => setProjectId(e.target.value)}>
        <option value="">{t("wdata.choose")}</option>{projects.data?.map(p => <option key={p.id} value={p.id}>{p.job_code} · {p.name}</option>)}
      </select></label>
      <label>{t("wdata.from")}<input type="date" value={fromDay} onChange={e => setFromDay(e.target.value)} /></label>
      <label>{t("wdata.until")}<input type="date" value={untilDay} onChange={e => setUntilDay(e.target.value)} /></label>
    </div>
    <p className="muted">{t("wdata.basis")}</p>
    {!datesValid && <p role="alert">{t("wdata.invalidDates")}</p>}
    {(projects.isLoading || (projectId && snapshot.isLoading && datesValid)) && <p role="status">{t("wdata.loading")}</p>}
    {(projects.isError || snapshot.isError) && <div role="alert"><p>{t("wdata.failed")}</p><button onClick={() => { void projects.refetch(); if (projectId && datesValid) void snapshot.refetch(); }}>{t("wdata.retry")}</button></div>}
    {report && !snapshot.isError && datesValid && <>
      <p className="muted">{t("wdata.asOf", { time: stamp(report.data.asOf) })}</p>
      <div className="work-data-stats">{([
        ["wdata.payroll", "payrollSeconds"], ["wdata.classified", "classifiedSeconds"], ["wdata.unknown", "unknownSeconds"],
        ["wdata.conflict", "conflictSeconds"], ["wdata.unpaid", "unpaidBreakSeconds"],
      ] as const).map(([label, key]) => <div key={key}><span>{t(label)}</span><strong>{duration(sum(key))}</strong></div>)}</div>
      <p>{t("wdata.coverageHelp")}</p>
      <p>{t("wdata.statusHelp")}</p>
      <ul>{[...statuses].filter(status => report.coverage.some(row => row.shift.status === status)).map(status => <li key={status}>{t(`wdata.${status}` as WorkDataKey)}: {duration(report.coverage.filter(row => row.shift.status === status).reduce((n, row) => n + row.payrollSeconds, 0))}</li>)}</ul>
      <h2>{t("wdata.activities")}</h2><p>{t("wdata.activityHelp")}</p>
      {report.activities.map(([key, row]) => <p key={key}><strong>{row.label}</strong> · {t(`wdata.${row.scope}`)} · {duration(row.seconds)}</p>)}
      <h2>{t("wdata.people")}</h2>
      {!report.coverage.length && <p>{t("wdata.noShifts")}</p>}
      {report.coverage.map(row => <details key={row.shift.id} className="work-data-card">
        <summary>{report.data.shifts.find(s => s.id === row.shift.id)?.profileName ?? row.shift.profileId} · {duration(row.payrollSeconds)} · {statuses.has(row.shift.status) ? t(`wdata.${row.shift.status}` as WorkDataKey) : row.shift.status}</summary>
        <p>{stamp(row.shift.startedAt)} → {row.shift.endedAt ? stamp(row.shift.endedAt) : t("wdata.provisional")}</p>
        <p>{t("wdata.classified")}: {duration(row.classifiedSeconds)} · {t("wdata.unknown")}: {duration(row.unknownSeconds)} · {t("wdata.conflict")}: {duration(row.conflictSeconds)}</p>
        {row.issues.length > 0 && <ul>{[...new Set(row.issues.map(issue))].map(i => <li key={i}>{i}</li>)}</ul>}
        <code>{row.shift.id}</code>
      </details>)}
      <WorkDataExplorer key={`${report.data.project.id}:${fromIso}:${untilIso}`} rows={report.units} claims={report.data.claims} coverage={report.coverage} issue={issue} />
      <details className="work-data-card"><summary>{t("wdata.raw")} ({report.data.claims.length})</summary><p>{t("wdata.rawHelp")}</p>
        {report.data.claims.map(c => <div key={c.sourceId} className="work-data-source"><strong>{c.label}</strong><p>{stamp(c.startedAt)} → {c.endedAt ? stamp(c.endedAt) : t("wdata.open")}</p><p>{c.profileId} · {c.unitId ?? t("wdata.none")}</p><code>{c.sourceId}</code></div>)}
      </details>
      <details className="work-data-card"><summary>{t("wdata.untimed")} ({report.data.untimed.length})</summary><p>{t("wdata.untimedHelp")}</p>
        <p>{t("wdata.dateBasis")}</p>
        {report.data.untimed.map(row => <div key={row.sourceId} className="work-data-source"><strong>{row.label}</strong><p>{row.workDate} · {row.profileId ?? t("wdata.unknown")}</p>{row.reportedSeconds !== null && <p>{t("wdata.reportedDuration")}: {duration(row.reportedSeconds)}</p>}<code>{row.sourceId}</code></div>)}
      </details>
    </>}
  </div>;
}
