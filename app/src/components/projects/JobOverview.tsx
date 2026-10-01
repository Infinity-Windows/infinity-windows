import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { RefreshCw } from "lucide-react";
import {
  getJobsOverview,
  type JobOverviewConcern,
  type JobOverviewRow,
  type JobsOverviewChange,
  type JobsOverviewSourceAvailability,
} from "../../lib/jobsOverview";
import type { Project } from "../../lib/types";
import { formatApiError } from "../../lib/errors";
import { useLanguage, useT, type TFn, type TKey } from "../../lib/i18n";
import { localWorkDate } from "../../lib/customWork/model";
import { SkeletonList, EmptyState } from "../ui/States";
import "../../lib/i18n/jobsOverviewCatalog";
import "./jobOverview.css";

const ISSUE_KEYS = {
  blocker: "jobsOverview.issue.blocker", framing: "jobsOverview.issue.framing",
  failed_install: "jobsOverview.issue.failed_install", flag: "jobsOverview.issue.flag",
  damage: "jobsOverview.issue.damage", complication: "jobsOverview.issue.complication",
  missing: "jobsOverview.issue.missing", spec_gap: "jobsOverview.issue.spec_gap",
  missing_job: "jobsOverview.issue.missing_job",
} as const;

function stamp(iso: string, lang: string): string {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return "";
  return date.toLocaleString(lang === "es" ? "es-US" : "en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}
function dayLabel(day: string, lang: string): string {
  return new Date(`${day}T12:00:00`).toLocaleDateString(lang === "es" ? "es-US" : "en-US", { weekday: "short", month: "short", day: "numeric" });
}
function concernLabel(c: JobOverviewConcern, t: TFn): string {
  if (c.kind === "readiness") return t("jobsOverview.concern.readiness");
  if (c.kind === "statusUnknown") return t("jobsOverview.concern.unknown");
  return c.issueKind ? t(ISSUE_KEYS[c.issueKind]) : t("jobsOverview.concern.issue");
}
function assignee(c: JobOverviewConcern, t: TFn): string {
  if (c.kind !== "issue") return t("jobsOverview.concern.ownerUnknown");
  if (!c.assignedToId && (!c.assignedToName || c.assignedToName === "Unassigned")) return t("jobsOverview.concern.unassigned");
  if (!c.assignedToName || c.assignedToName === "Assigned (name unavailable)") return t("jobsOverview.concern.assignedUnknown");
  return t("jobsOverview.concern.assignedTo", { name: c.assignedToName });
}
function Concern({ concern, t, lang }: { concern: JobOverviewConcern; t: TFn; lang: string }) {
  const label = concernLabel(concern, t);
  return (
    <div className={`jo-concern jo-severity-${concern.severity}`}>
      {concern.href ? <Link className="jo-concern-link" to={concern.href}>{label}</Link> : <span>{label}</span>}
      {concern.note && <span className="jo-concern-note"> — {concern.note}</span>}
      <p className="muted jo-detail-meta">
        {assignee(concern, t)}
        {concern.createdAt ? ` · ${stamp(concern.createdAt, lang)}` : ""}
      </p>
    </div>
  );
}
function Progress({ row, t }: { row: JobOverviewRow; t: TFn }) {
  const lines: string[] = [];
  if (row.scope && (!row.scope.available || row.scope.openings > 0)) lines.push(row.scope.available ? t("jobsOverview.scope.line", { installed: row.scope.installed, total: row.scope.openings }) : t("jobsOverview.scope.unavailable"));
  if (row.customWork) lines.push(row.customWork.available ? t("jobsOverview.customWork.line", { completed: row.customWork.completed, total: row.customWork.total }) : t("jobsOverview.customWork.unavailable"));
  return <p className="muted jo-line">{lines.length ? lines.join(" · ") : t("jobsOverview.scope.none")}</p>;
}
function JobRow({ row, sources, t, lang }: { row: JobOverviewRow; sources: JobsOverviewSourceAvailability; t: TFn; lang: string }) {
  const scheduleKnown = row.scheduleAvailable ?? sources.schedule;
  const issuesKnown = row.issuesAvailable ?? sources.issues;
  const activityKnown = row.activityAvailable ?? (sources.sessions && sources.dailyLogs);
  const readinessKnown = row.readinessAvailable ?? sources.readiness;
  const concerns = row.concerns ?? (row.concern ? [row.concern] : []);
  return (
    <article className="jo-row" data-job-id={row.id}>
      <div className="jo-row-head">
        <Link className="jo-row-name" to={row.href}>{row.name}</Link>
        <span className="muted jo-row-code">{row.jobCode}</span>
      </div>
      <p className="jo-line">
        {!scheduleKnown ? t("jobsOverview.today.unavailable") : row.today ? t("jobsOverview.today.plan", { crew: row.today.crewNames.join(", ") || t("jobsOverview.today.unnamed") }) : t("jobsOverview.today.none")}
      </p>
      <Progress row={row} t={t} />
      <p className="jo-line">
        {row.concern ? (row.concern.href ? <Link className="jo-concern-link" to={row.concern.href}>{concernLabel(row.concern, t)}</Link> : concernLabel(row.concern, t)) : !issuesKnown || !readinessKnown ? t("jobsOverview.concern.unavailable") : t("jobsOverview.concern.none")}
      </p>
      <p className="muted jo-line">
        {!scheduleKnown ? t("jobsOverview.nextStep.unavailable") : row.nextStep ? t("jobsOverview.nextStep.plan", { day: dayLabel(row.nextStep.dateISO, lang) }) : t("jobsOverview.nextStep.none")}
      </p>
      <details className="jo-details">
        <summary>{row.lastActivity ? `${t("jobsOverview.activity.label", { time: stamp(row.lastActivity.atISO, lang) })} · ` : ""}{t("jobsOverview.details", { n: concerns.length })}</summary>
        <p className="muted jo-line">{!activityKnown ? t("jobsOverview.activity.unavailable") : row.lastActivity ? t("jobsOverview.activity.label", { time: stamp(row.lastActivity.atISO, lang) }) : t("jobsOverview.activity.none")}</p>
        {!readinessKnown && <p className="muted jo-line">{t("jobsOverview.sources.readiness")}</p>}
        {row.today?.note && <p className="jo-line">{row.today.note}</p>}
        {concerns.map((c, index) => <Concern key={`${c.href}-${index}`} concern={c} t={t} lang={lang} />)}
        {row.lastActivity && <p className="muted jo-line">{t("jobsOverview.activity.window")}</p>}
      </details>
    </article>
  );
}
function changeLabel(change: JobsOverviewChange, t: TFn, lang: string): string {
  const issue = change.issueKind ? t(ISSUE_KEYS[change.issueKind]) : t("jobsOverview.concern.issue");
  switch (change.kind) {
    case "issueNew": return t("jobsOverview.change.issueNew", { issue });
    case "issueResolved": return t("jobsOverview.change.issueResolved", { issue });
    case "schedulePublished": return t("jobsOverview.change.schedulePublished", { day: dayLabel(change.dateISO ?? localWorkDate(), lang) });
    case "scheduleChanged": return t("jobsOverview.change.scheduleChanged", { day: dayLabel(change.dateISO ?? localWorkDate(), lang) });
    case "dailyLog": return t("jobsOverview.change.dailyLog", { day: dayLabel(change.dateISO ?? localWorkDate(), lang) });
    default: return t("jobsOverview.change.record");
  }
}

export function JobOverview({ projects }: { projects: Project[] }) {
  const t = useT();
  const { lang } = useLanguage();
  const qc = useQueryClient();
  const [showAllAttention, setShowAllAttention] = useState(false);
  const [showAllChanges, setShowAllChanges] = useState(false);
  const [day, setDay] = useState(() => localWorkDate());
  useEffect(() => {
    const timer = window.setInterval(() => setDay(localWorkDate()), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  const projectIds = useMemo(() => projects.map((p) => p.id).sort(), [projects]);
  const overview = useQuery({
    queryKey: ["jobsOverview", projectIds.join(","), day],
    queryFn: () => getJobsOverview(projects),
    staleTime: 60_000,
  });
  const refresh = async () => {
    setDay(localWorkDate());
    await qc.invalidateQueries({ queryKey: ["projects"] });
    await qc.invalidateQueries({ queryKey: ["jobsOverview"] });
  };
  const data = overview.data;
  const attention = data?.rows.filter((row) => row.needsAttention) ?? [];
  const unknownConcerns = data ? !data.sources.issues || !data.sources.readiness : false;
  const missing = data ? Object.entries(data.sources).filter(([, available]) => !available).map(([source]) => source) : [];
  return (
    <div className="jobs-overview">
      <div className="jo-header">
        <p className="muted jo-line">{data ? t("jobsOverview.fetchedAt", { time: stamp(data.generatedAt, lang) }) : ""}</p>
        <button type="button" className="link jo-refresh" onClick={() => void refresh()} disabled={overview.isFetching}>
          <RefreshCw size={14} aria-hidden /> {t(overview.isFetching ? "jobsOverview.refreshing" : "jobsOverview.refresh")}
        </button>
      </div>
      {overview.isLoading && <SkeletonList rows={4} />}
      {overview.isError && <p className="error">{formatApiError(overview.error)}</p>}
      {data && missing.length > 0 && <div className="jo-source-warnings" role="status">{missing.map((source) => <p key={source} className="muted jo-line">{t(`jobsOverview.sources.${source}` as TKey) || t("jobsOverview.sources.other")}</p>)}</div>}
      {data && <>
        <section className="jo-section" aria-label={t("jobsOverview.attention.heading")}>
          <h2 className="jo-section-head">{t("jobsOverview.attention.heading")}{attention.length ? ` (${attention.length})` : ""}</h2>
          {!attention.length ? <p className="muted jo-line">{t(unknownConcerns ? "jobsOverview.attention.unknown" : "jobsOverview.attention.empty")}</p> : <ul className="jo-attention">
            {(showAllAttention ? attention : attention.slice(0, 3)).map((row) => <li key={row.id}>
              <Link className="jo-attention-job" to={row.href}>{row.name}</Link>
              {row.concern && <Concern concern={row.concern} t={t} lang={lang} />}
            </li>)}
          </ul>}
          {attention.length > 3 && <button type="button" className="link" onClick={() => setShowAllAttention(!showAllAttention)}>{showAllAttention ? t("jobsOverview.attention.showLess") : t("jobsOverview.attention.viewAll", { n: attention.length })}</button>}
        </section>
        <section className="jo-section" aria-label={t("jobsOverview.jobs.heading")}>
          <h2 className="jo-section-head">{t("jobsOverview.jobs.heading")}</h2>
          <p className="muted jo-scope-note">{t("jobsOverview.qcScope")}</p>
          {!data.rows.length ? <EmptyState title={t("jobsOverview.jobs.empty")} /> : <div className="jo-row-list">{data.rows.map((row) => <JobRow key={row.id} row={row} sources={data.sources} t={t} lang={lang} />)}</div>}
        </section>
        <section className="jo-section" aria-label={t("jobsOverview.changes.heading")}>
          <h2 className="jo-section-head">{t("jobsOverview.changes.heading")}</h2>
          {!data.changes.length ? <p className="muted jo-line">{t(missing.length ? "jobsOverview.changes.unknown" : "jobsOverview.changes.empty")}</p> : <ul className="jo-changes">{(showAllChanges ? data.changes : data.changes.slice(0, 5)).map((change) => <li key={change.id}>
            <Link className="jo-change-link" to={change.href}><strong>{change.jobLabel}</strong>: {changeLabel(change, t, lang)}</Link>
            <span className="muted jo-change-time"> · {stamp(change.atISO, lang)}</span>
          </li>)}</ul>}
          {data.changes.length > 5 && <button type="button" className="link" onClick={() => setShowAllChanges(!showAllChanges)}>{t(showAllChanges ? "jobsOverview.attention.showLess" : "jobsOverview.changes.viewAll", { n: data.changes.length })}</button>}
        </section>
      </>}
    </div>
  );
}
