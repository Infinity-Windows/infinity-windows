import { JobSearchSelect } from "../../components/JobSearchSelect";
import { ChevronDown, Plus, Tractor } from "lucide-react";
import { Fragment, useEffect, useState, type CSSProperties } from "react";
import { useQuery } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import { listProjectsAnyStatus } from "../../lib/api";
import { listProfilesIncludingRemoved } from "../../lib/install/api";
import { useEffectiveRole } from "../../lib/useEffectiveRole";
import { isForemanPlus } from "../../lib/install/types";
import { addDays, previousPayPeriod, timecardRange } from "../../lib/timeclock";
import { formatApiError } from "../../lib/errors";
import { clockText, workerSeconds, type WorkSession, type WorkHistory } from "../../lib/customWork/model";
import { listWorkHistory } from "../../lib/customWork/api";
import { useWork } from "../../lib/customWork/useWork";
import { SessionCorrection } from "./SessionCorrection";
import { QueueNotice } from "./QueueNotice";
import { ActivityIcon } from "../installerPilot/workdayActivities";
import { pilotActivityColor } from "../../lib/installerWorkflow/pilotActivities";
import { AddActivity } from "./AddActivity";
import "./customWork.css";

const titleOf = (row: WorkSession) => row.kind === "idle"
  ? row.description.split(" — ", 1)[0]?.trim() || "Prep time"
  : row.stage;
const TIME = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const DAY = new Intl.DateTimeFormat(undefined, { weekday: "short", month: "short", day: "numeric" });
const dayKey = (iso: string) => new Date(iso).toDateString();
const timeOf = (iso: string) => TIME.format(new Date(iso));

export function RecentActivities() {
  const { realRole, effectiveRole, isPreviewing } = useEffectiveRole();
  if (isPreviewing || !isForemanPlus(realRole) || !isForemanPlus(effectiveRole))
    return <div className="page"><p>Activity review is available to foremen and above.</p></div>;
  return <ActivityReview />;
}

function ActivityReview() {
  const [search, setSearch] = useSearchParams();
  const job = search.get("job") || undefined;
  const [people, setPeople] = useState<string[]>([]);
  const [selectedActivities, setSelectedActivities] = useState<string[]>([]);
  const [historyId, setHistoryId] = useState("");
  const [expandedId, setExpandedId] = useState("");
  const [adding, setAdding] = useState(false);
  const [unitsFor, setUnitsFor] = useState("");
  const [initialFrom] = useState(() => {
    const date = new Date();
    date.setDate(date.getDate() - 13);
    date.setHours(0, 0, 0, 0);
    return date.getTime();
  });
  const [from, setFrom] = useState(initialFrom);
  const [periodFilter, setPeriodFilter] = useState("recent");
  // "Load earlier" moves the select to the pay period it fetches. Until those
  // rows arrive the table keeps what it was showing rather than going empty.
  const [heldFilter, setHeldFilter] = useState<string | null>(null);
  const work = useWork(job, from);
  const currentPeriod = timecardRange("pay", new Date(from));
  const nextPeriod = currentPeriod.start.getTime() < from ? currentPeriod : previousPayPeriod(currentPeriod.start);
  const periodOptions: ReturnType<typeof timecardRange>[] = [];
  for (let period = timecardRange("pay", addDays(new Date(initialFrom), 13));
    period.start >= nextPeriod.start; period = previousPayPeriod(period.start)) {
    periodOptions.push(period);
  }
  // An opened row goes to the top of the screen with its editor under it.
  // Opening one row closes another, which can move everything by a form's
  // height, so this waits for that layout before scrolling.
  useEffect(() => {
    if (!expandedId) return;
    const row = document.getElementById("activity-row-" + expandedId);
    if (!row) return;
    const calm = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const frame = requestAnimationFrame(() => row.scrollIntoView({ block: "start", behavior: calm ? "auto" : "smooth" }));
    return () => cancelAnimationFrame(frame);
  }, [expandedId]);
  const jobs = useQuery({ queryKey: ["projectsAll"], queryFn: listProjectsAnyStatus });
  const profiles = useQuery({ queryKey: ["customWorkRosterAll"], queryFn: listProfilesIncludingRemoved });
  const selectedHistoryRow = work.sessions.find(row => row.id === historyId);
  const history = useQuery({
    queryKey: ["customWorkHistory", work.user, selectedHistoryRow?.project_id, historyId],
    queryFn: () => listWorkHistory(selectedHistoryRow?.project_id, historyId),
    enabled: !!selectedHistoryRow && historyId === expandedId,
  });
  const names = new Map(profiles.data?.map(profile => [profile.id, profile.display_name]));
  const jobNames = new Map(jobs.data?.map(project => [project.id, project.job_code]));
  const units = new Map(work.units.map(unit => [unit.id, unit]));
  const activities = [...new Set(work.sessions.map(titleOf))].sort();
  const workers = [...new Set(work.sessions.map(row => row.profile_id))].sort((a, b) =>
    (names.get(a) ?? a).localeCompare(names.get(b) ?? b));
  const rows = work.sessions.filter(row => (!people.length || people.includes(row.profile_id))
    && (!selectedActivities.length || selectedActivities.includes(titleOf(row)))).sort((a, b) =>
    Date.parse(b.started_at) - Date.parse(a.started_at) || b.id.localeCompare(a.id));
  const tableFilter = work.loadingOlderSessions && heldFilter ? heldFilter : periodFilter;
  const periods = new Map<string, { label: string; rows: WorkSession[] }>();
  for (const row of rows) {
    const period = timecardRange("pay", new Date(row.started_at));
    if (tableFilter === "recent" && row.ended_at && Date.parse(row.ended_at) <= initialFrom) continue;
    if (tableFilter !== "recent" && tableFilter !== period.startIso) continue;
    const existing = periods.get(period.startIso);
    if (existing) existing.rows.push(row);
    else periods.set(period.startIso, { label: period.label, rows: [row] });
  }
  const shown = [...periods.values()].flatMap(period => period.rows);
  const shownTotal = clockText(workerSeconds(shown.filter(row => row.ended_at)));
  const olderButton = <button type="button" className="cw-activity-older" disabled={work.loading || work.loadingOlderSessions}
    title={nextPeriod.label} onClick={() => {
      setHeldFilter(periodFilter);
      setPeriodFilter(nextPeriod.startIso);
      setFrom(nextPeriod.start.getTime());
    }}>
    {work.loadingOlderSessions ? "Loading earlier activities…" : "Load earlier activities"}
  </button>;
  return <div className="page cw-activities">
    <header className="cw-activity-header">
      <h1>Recent activities</h1>
      {shown.length > 0 && <p className="cw-activity-summary">
        {shown.length} {shown.length === 1 ? "activity" : "activities"} · <strong>{shownTotal}</strong>
      </p>}
    </header>
    <div className="cw-activity-toolbar">
      <label className="cw-activity-period-picker">
        <span className="field-label">Period</span>
        <select value={periodFilter} onChange={event => {
          const value = event.target.value;
          setPeriodFilter(value);
          setHeldFilter(null);
          const selected = periodOptions.find(period => period.startIso === value);
          if (selected && selected.start.getTime() < from) setFrom(selected.start.getTime());
        }}>
          <option value="recent">Last 14 days</option>
          {periodOptions.map(period => <option key={period.startIso} value={period.startIso}>{period.label}</option>)}
        </select>
      </label>
      <JobSearchSelect jobs={jobs.data ?? []} value={job ?? ""} label="Project"
        allLabel="All jobs and company work" loading={jobs.isFetching} onChange={id => {
          if (id === (job ?? "")) return;
          setSearch(current => {
            const next = new URLSearchParams(current);
            if (id) next.set("job", id);
            else next.delete("job");
            return next;
          });
          setSelectedActivities([]);
          setPeople([]);
          setExpandedId("");
          setHistoryId("");
        }} />
    </div>
    {/* Work nobody timed is added here; everything below it can only
        correct an activity that already exists. */}
    {adding ? <AddActivity work={work} jobs={jobs.data ?? []} job={job} onClose={() => setAdding(false)}
        people={(profiles.data ?? []).filter(profile => !profile.retired_at && (profile.role === "installer" || profile.role === "foreman"))} />
      : <button type="button" className="cw-add-activity-open" onClick={() => setAdding(true)}><Plus size={16} aria-hidden="true" />Add activity</button>}
    {workers.length > 0 && <div className="cw-activity-filters">
      <FilterTags label="Activity" choices={activities.map(name => ({ id: name, label: name }))}
        selected={selectedActivities} onChange={setSelectedActivities} />
      <FilterTags label="Person" choices={workers.map(id => ({ id, label: names.get(id) ?? id }))}
        selected={people} onChange={setPeople} />
    </div>}
    <QueueNotice work={work} />
    {work.loading && <p role="status">Loading activities…</p>}
    {work.error && <p role="alert">{formatApiError(work.error)}</p>}
    <div className="cw-activity-table-scroll">
      <table className="cw-activity-table" aria-label="Recent activities">
        <colgroup><col className="cw-activity-time-col" /><col /><col className="cw-activity-duration-col" /></colgroup>
        <thead><tr><th scope="col">Started</th><th scope="col">Activity</th><th scope="col">Duration</th></tr></thead>
        {!periods.size && !work.loading && !work.loadingOlderSessions && !work.error &&
          <tbody><tr><td colSpan={3} className="cw-activity-empty">No recorded activities match these filters.</td></tr></tbody>}
        {[...periods].map(([key, period]) => <tbody key={key}>
          <tr className="cw-activity-period"><th colSpan={3} scope="rowgroup">{period.label}</th></tr>
          {period.rows.map((row, index) => {
            const expanded = expandedId === row.id;
            const personName = names.get(row.profile_id) ?? "Installer";
            const title = titleOf(row);
            const detailsId = `activity-details-${row.id}`;
            const collapse = () => { setExpandedId(""); setHistoryId(""); };
            const toggle = () => { setHistoryId(""); setExpandedId(expanded ? "" : row.id); };
            const unit = row.unit_id ? units.get(row.unit_id)?.label ?? "Unit" : "";
            const jobLabel = row.project_id ? jobNames.get(row.project_id) ?? "Job" : "Company work";
            const machinery = Boolean(row.workday_machinery_ms || row.workday_machinery_started_at);
            const day = dayKey(row.started_at);
            const firstOfDay = index === 0 || dayKey(period.rows[index - 1].started_at) !== day;
            const dayRows = firstOfDay ? period.rows.filter(other => dayKey(other.started_at) === day) : [];
            return <Fragment key={row.id}>
              {firstOfDay && <tr className="cw-activity-day"><td colSpan={3}>
                <span>{DAY.format(new Date(row.started_at))}</span>
                <span>{clockText(workerSeconds(dayRows.filter(other => other.ended_at)))}</span>
              </td></tr>}
              <tr className="cw-activity-row" id={`activity-row-${row.id}`} data-expanded={expanded || undefined} onClick={toggle}
                style={{ "--activity-color": pilotActivityColor(`${row.kind === "idle" ? "general" : "unit"}:${title}`) } as CSSProperties}>
                {/* A timeline: when it started, a mark in the activity's colour,
                    and the duration at the far end. The end time is one tap away
                    in the details, and on hover where there is a pointer (Matt,
                    2026-11-20: "duration holds enough information"). */}
                <td className="cw-activity-time" title={row.ended_at
                  ? `${timeOf(row.started_at)} – ${timeOf(row.ended_at)}` : `${timeOf(row.started_at)} – running`}>{timeOf(row.started_at)}</td>
                <td>
                  <span className="cw-activity-main">
                    <span className="cw-activity-icon"><ActivityIcon activity={title} /></span>
                    <button type="button" className="cw-activity-toggle" aria-expanded={expanded}
                      aria-controls={expanded ? detailsId : undefined} aria-label={`${title} for ${personName}, ${new Date(row.started_at).toLocaleString()}`}
                      onClick={event => { event.stopPropagation(); toggle(); }}>{title}</button>
                    {unit && <span className="cw-activity-unit">{unit}</span>}
                    {machinery && <span className="cw-activity-flag" title="Machinery time recorded"><Tractor size={14} aria-hidden="true" /><span className="sr-only">Machinery</span></span>}
                    {row.review_required && <span className="cw-activity-flag" data-tone="warn">Needs review</span>}
                  </span>
                  <span className="cw-activity-sub">{personName}{!job && <> · {jobLabel}</>}</span>
                </td>
                <td>{row.ended_at ? clockText(workerSeconds([row])) : <span className="cw-activity-running">Running</span>}
                  <ChevronDown className="cw-activity-chevron" size={14} aria-hidden="true" /></td>
              </tr>
              {expanded && <tr><td colSpan={3} id={detailsId} className="cw-activity-details">
                <dl className="cw-activity-facts">
                  <div><dt>Job</dt><dd>{jobLabel}</dd></div>
                  {unit && <div><dt>Unit</dt><dd>{unit}</dd></div>}
                  <div><dt>Started</dt><dd>{new Date(row.started_at).toLocaleString()}</dd></div>
                  <div><dt>Ended</dt><dd>{row.ended_at ? new Date(row.ended_at).toLocaleString() : "Still running"}</dd></div>
                  {row.outcome && <div><dt>Outcome</dt><dd>{row.outcome}</dd></div>}
                  {machinery && <div><dt>Machinery</dt><dd>{clockText(Math.round((row.workday_machinery_ms ?? 0) / 1000))}
                    {row.workday_machinery_started_at && " · Running"}</dd></div>}
                </dl>
                {row.review_required && <p className="cw-activity-warning">Time or job attribution needs review.</p>}
                {/* Units go on a finished job activity; the form shares its time between them. */}
                {unitsFor === row.id
                  ? <AddActivity work={work} jobs={[]} people={[]} existing={row} onClose={() => setUnitsFor("")} />
                  : <>
                    {row.ended_at && row.project_id && <button type="button" className="cw-add-activity-open"
                      onClick={() => setUnitsFor(row.id)}>{row.unit_id ? "Change or add units" : "Add units"}</button>}
                    <SessionCorrection row={row} lead onSave={data => work.command("session", data)}
                      onSaveMachinery={data => work.command("machinery_correction", data)} onCancel={collapse} />
                  </>}
                <details open={historyId === row.id} onToggle={event => {
                  if (event.currentTarget.open) setHistoryId(row.id);
                  else setHistoryId(current => current === row.id ? "" : current);
                }}>
                  <summary>Correction history</summary>
                  {historyId === row.id && (history.isError ? <p role="alert">{formatApiError(history.error)}</p>
                    : history.isLoading ? <p role="status">Loading history…</p>
                    : <CorrectionHistory rows={history.data ?? []} names={names} />)}
                </details>
              </td></tr>}
            </Fragment>;
          })}</tbody>)}
      </table>
    </div>
    {!work.error && <div className="cw-activity-footer">{olderButton}</div>}
    {work.error && <button type="button" className="cw-activity-older"
      onClick={() => void work.refresh()}>Retry loading activities</button>}
  </div>;
}

function FilterTags({ label, choices, selected, onChange }: {
  label: string;
  choices: { id: string; label: string }[];
  selected: string[];
  onChange: (ids: string[]) => void;
}) {
  if (!choices.length) return null;
  return <fieldset className="cw-activity-tags">
    <legend>{label}</legend>
    <button type="button" aria-label={`All ${label === "Person" ? "people" : "activities"}`}
      aria-pressed={!selected.length} onClick={() => onChange([])}>All</button>
    {choices.map(choice => {
      const included = selected.includes(choice.id);
      return <button type="button" key={choice.id} aria-pressed={included} onClick={() => {
        onChange(included ? selected.filter(id => id !== choice.id) : [...selected, choice.id]);
      }}>{choice.label}</button>;
    })}
  </fieldset>;
}

const correctedFields = [
  ["started_at", "Start"], ["ended_at", "End"], ["outcome", "Outcome"],
  ["description", "Notes"], ["delay_reason", "Delay"],
] as const;

function CorrectionHistory({ rows, names }: { rows: WorkHistory[]; names: Map<string, string | null> }) {
  const edits = rows.filter(row => row.action === "session").sort((a, b) => b.created_at.localeCompare(a.created_at));
  if (!edits.length) return <p>No saved corrections.</p>;
  return <ul>{edits.map(edit => {
    const before = edit.before_value as Partial<WorkSession> | null;
    const after = edit.after_value as Partial<WorkSession> | null;
    const value = (field: typeof correctedFields[number][0], content: string | null | undefined) =>
      content ? field.endsWith("_at") ? new Date(content).toLocaleString() : content : "—";
    return <li key={edit.id}>
      <strong>{names.get(edit.actor_id) ?? "Crew member"} · {new Date(edit.created_at).toLocaleString()}</strong>
      {edit.reason && <p>{edit.reason}</p>}
      {correctedFields.filter(([field]) => before?.[field] !== after?.[field]).map(([field, title]) =>
        <p key={field}>{title} · {value(field, before?.[field])} → {value(field, after?.[field])}</p>)}
    </li>;
  })}</ul>;
}
