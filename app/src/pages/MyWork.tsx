import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router-dom";
import { getMyProfile, listMyOpeningsAllJobs } from "../lib/install/api";
import { orderMyWork, type DispatchOpening } from "../lib/dispatch";
import { openingReadiness } from "../lib/install/fit";
import type { ProjectOpening } from "../lib/install/types";

function areaKey(o: ProjectOpening): string {
  return o.label?.trim() || `page ${o.page_number}`;
}

export function MyWork() {
  const navigate = useNavigate();
  const me = useQuery({ queryKey: ["myProfile"], queryFn: getMyProfile });
  const openings = useQuery({
    queryKey: ["myOpenings", me.data?.id],
    queryFn: () => listMyOpeningsAllJobs(me.data!.id),
    enabled: Boolean(me.data?.id),
  });

  const rows = openings.data ?? [];
  const active = rows.filter((o) => o.status !== "installed");
  const done = rows.filter((o) => o.status === "installed");

  const ordered = orderMyWork(
    active.map((o): DispatchOpening => {
      const r = openingReadiness(o);
      return {
        id: o.id,
        opening_code: o.opening_code,
        window_type_id: o.window_type_id,
        difficulty:
          o.window_types?.learned_difficulty ??
          o.window_types?.outcome_difficulty ??
          o.window_types?.difficulty_rating ??
          null,
        area: areaKey(o),
        ready: r.status === "ready",
        blocked: r.status === "blocked",
        assigned_to: o.assigned_to,
        sequence: o.sequence,
      };
    }),
  );
  const byId = new Map(active.map((o) => [o.id, o]));
  const orderedFull = ordered.map((d) => byId.get(d.id)!).filter(Boolean);
  const next = orderedFull[0];
  const rest = orderedFull.slice(1);

  const go = (o: ProjectOpening) =>
    navigate(`/projects/${o.project_id}/opening/${o.id}`);

  const readinessTag = (o: ProjectOpening) => {
    const r = openingReadiness(o);
    const inProgress = o.work_started_at && o.status !== "installed";
    const cls = inProgress
      ? "warn-text"
      : r.status === "ready"
        ? "ok"
        : r.status === "blocked"
          ? "error"
          : "warn-text";
    return <span className={cls}>{inProgress ? "in progress" : r.status}</span>;
  };

  if (me.isLoading) return <div className="page"><p className="muted">Loading…</p></div>;

  return (
    <div className="page">
      <header className="page-header">
        <h1>My work</h1>
        <Link to="/" className="button-like">
          Home
        </Link>
      </header>
      <p className="muted">
        {me.data?.display_name} · your foreman assigns these. Do the top one next.
      </p>

      {!next && (
        <p className="muted">
          Nothing assigned right now. Check with your lead, or help stage the
          next windows.
        </p>
      )}

      {next && (
        <button className="next-card" onClick={() => go(next)}>
          <span className="next-label">NEXT WINDOW</span>
          <span className="next-code">{next.opening_code}</span>
          <span className="next-meta">
            {next.window_types?.type_code ?? "type?"} ·{" "}
            {next.projects?.job_code ?? ""} · {areaKey(next)}
          </span>
          <span className="next-ready">{readinessTag(next)}</span>
        </button>
      )}

      {rest.length > 0 && (
        <>
          <h2>Then ({rest.length})</h2>
          <ul className="unit-list">
            {rest.map((o) => (
              <li key={o.id} className="find-row" onClick={() => go(o)} style={{ cursor: "pointer" }}>
                <div>
                  <strong>{o.opening_code}</strong>{" "}
                  <span className="muted">{o.window_types?.type_code}</span>
                  <div className="muted" style={{ fontSize: 12 }}>
                    {o.projects?.job_code} · {areaKey(o)}
                  </div>
                </div>
                <span style={{ marginLeft: "auto" }}>{readinessTag(o)}</span>
              </li>
            ))}
          </ul>
        </>
      )}

      {done.length > 0 && (
        <>
          <h2>Done today ({done.length})</h2>
          <ul className="unit-list">
            {done.map((o) => (
              <li key={o.id}>
                <strong>{o.opening_code}</strong>{" "}
                <span className="muted">{o.window_types?.type_code}</span>{" "}
                <span className="ok">installed</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
