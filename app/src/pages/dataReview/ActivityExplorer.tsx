import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { listProjectsAnyStatus } from "../../lib/api";
import { listWorkSessions, listWorkUnits } from "../../lib/customWork/api";
import { listProfiles } from "../../lib/install/api";
import { signInMark } from "../../lib/signedIn";
import { activityRows, groupActivities } from "./activityRows";

const hours = (seconds: number) => seconds > 0 && seconds < 36 ? "<0.01" : (seconds / 3600).toFixed(2);
export function ActivityExplorer() {
  const owner = signInMark().userId;
  const [choice, setChoice] = useState("");
  const [scope, setScope] = useState("All");
  const [group, setGroup] = useState<"activity" | "floor" | "unit" | "person">("activity");
  const [table, setTable] = useState("summary");
  const [from, setFrom] = useState(""); const [until, setUntil] = useState("");
  const [search, setSearch] = useState("");
  // Owner-only discovery: the existing paginated reader checks completeness.
  const sessions = useQuery({ queryKey: ["dataReview", owner, "workSessions"], queryFn: () => listWorkSessions() });
  const projects = useQuery({ queryKey: ["dataReview", owner, "projects"], queryFn: listProjectsAnyStatus });
  const people = useQuery({ queryKey: ["dataReview", owner, "people"], queryFn: listProfiles });
  const candidates = useMemo(() => {
    const counts = new Map<string, number>();
    for (const s of sessions.data ?? []) if (s.project_id && s.ended_at) counts.set(s.project_id, (counts.get(s.project_id) ?? 0) + 1);
    return [...counts].sort((a, b) => b[1] - a[1]);
  }, [sessions.data]);
  const project = choice || candidates[0]?.[0] || "";
  const units = useQuery({ queryKey: ["dataReview", owner, "units", project], queryFn: () => listWorkUnits(project), enabled: !!project });
  const personNames = useMemo(() => new Map((people.data ?? []).map(p => [p.id, p.display_name])), [people.data]);
  const datesValid = !(from && until && from > until);
  const source = useMemo(() => activityRows((sessions.data ?? []).filter(s => s.project_id === project), units.data ?? [], personNames,
    from ? new Date(`${from}T00:00:00`).getTime() : -Infinity,
    until ? new Date(`${until}T00:00:00`).setDate(new Date(`${until}T00:00:00`).getDate() + 1) : Infinity), [sessions.data, project, units.data, personNames, from, until]);
  const rows = source.rows.filter(r => (scope === "All" || r.scope === scope) && [r.activity, r.unit, r.person, r.floor].join(" ").toLowerCase().includes(search.toLowerCase()));
  const groups = groupActivities(rows, group);
  const total = rows.reduce((n, r) => n + r.seconds, 0);
  const error = sessions.error || projects.error || people.error || units.error;
  if (error) return <p role="alert">Activity records could not be loaded. No totals are shown. {String(error)}</p>;
  if (sessions.isPending || projects.isPending || people.isPending || (!!project && units.isPending)) return <p role="status">Tracing recorded activities…</p>;
  return <div className="activity-explorer">
    <h2>Recorded activity labor</h2>
    <p>Closed custom_work_sessions only—not payroll, all installation history, or dollar cost. Each record represents one person. Open, invalid and voided records are excluded ({source.excluded}). Overlapping source timers are not reconciled; these are reported durations, not an approved labor total.</p>
    <div className="activity-controls">
      <label>Job<select value={project} onChange={e => setChoice(e.target.value)}>{candidates.map(([id, count]) => <option key={id} value={id}>{projects.data?.find(p => p.id === id)?.job_code ?? id} · {count} closed records</option>)}</select></label>
      <label>From<input type="date" value={from} onChange={e => setFrom(e.target.value)} /></label>
      <label>Through<input type="date" value={until} onChange={e => setUntil(e.target.value)} /></label>
      <label>Scope<select value={scope} onChange={e => setScope(e.target.value)}>{["All", "Specific", "General"].map(v => <option key={v}>{v}</option>)}</select></label>
      <label>Group by<select value={group} onChange={e => setGroup(e.target.value as typeof group)}>{["activity", "floor", "unit", "person"].map(v => <option key={v}>{v}</option>)}</select></label>
      <label>Search<input type="search" value={search} onChange={e => setSearch(e.target.value)} placeholder="Activity, unit, person or floor" /></label>
    </div>
    {!datesValid ? <p role="alert">Start date must not be after the end date.</p> : <>
      <p><strong>{hours(total)} person-hours</strong> · {rows.length} source records · {from || "First record"} – {until || "Latest closed record"}. Dates clip intervals at local midnight.</p>
      {!candidates.length && <p>No closed custom-work activities are available. Other historical sources remain in Existing report and Evidence.</p>}
      <p>{rows.filter(r => r.seconds < 60).length} records are shorter than a minute; {rows.filter(r => r.scope === "Specific" && r.floor === "Unknown").length} specific records have no recorded floor. These are source observations, not proof of complete installation time.</p>
      <div className="activity-bars" role="img" aria-label={`Reported person-hours grouped by ${group}; exact values in the table below`}>
        {groups.map(g => <div className="activity-bar" key={g.key}><span>{g.label}</span><div><i style={{ width: `${g.seconds / Math.max(...groups.map(x => x.seconds), 1) * 100}%` }} /></div><strong>{hours(g.seconds)} h</strong></div>)}
      </div>
      <label>Table view<select value={table} onChange={e => setTable(e.target.value)}><option value="summary">Grouped totals</option><option value="records">Source records</option></select></label>
      <div className="activity-table"><table><caption>{table === "summary" ? `Same selection grouped by ${group}` : "Source: custom_work_sessions; original timestamps and revision retained"}</caption>
        {table === "summary" ? <><thead><tr><th>Group</th><th>Person-hours</th><th>Records</th></tr></thead><tbody>{groups.map(g => <tr key={g.key}><th scope="row">{g.label}</th><td>{hours(g.seconds)}</td><td>{g.records}</td></tr>)}</tbody></> : <><thead><tr>{["Activity / scope", "Unit / floor", "Person", "Hours", "Original interval", "Source / revision"].map(v => <th key={v}>{v}</th>)}</tr></thead><tbody>{rows.map(r => <tr key={r.id}><td>{r.activity}<br />{r.scope} · {r.outcome}</td><td>{r.unit}<br />{r.floor}</td><td>{r.person}</td><td>{hours(r.seconds)}</td><td>{r.started}<br />{r.ended}</td><td><code>{r.id}</code><br />rev {r.revision}</td></tr>)}</tbody></>}
      </table></div>
    </>}
  </div>;
}


