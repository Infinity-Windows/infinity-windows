import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  getMyProfile,
  listMemosToConfirm,
  listMyOpeningsAllJobs,
} from "../lib/install/api";
import { useRealtimeMyOpenings } from "../lib/useRealtimeOpenings";
import { orderMyWork, type DispatchOpening } from "../lib/dispatch";
import { openingReadiness } from "../lib/install/fit";
import { isForemanPlus, type ProjectOpening } from "../lib/install/types";
import { useEffectiveRole } from "../lib/useEffectiveRole";

function areaKey(o: ProjectOpening): string {
  return o.label?.trim() || `page ${o.page_number}`;
}

function toDispatch(o: ProjectOpening): DispatchOpening {
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
}

export function MyWork() {
  const navigate = useNavigate();
  const me = useQuery({ queryKey: ["myProfile"], queryFn: getMyProfile });
  const { effectiveRole } = useEffectiveRole();
  const openings = useQuery({
    queryKey: ["myOpenings", me.data?.id],
    queryFn: () => listMyOpeningsAllJobs(me.data!.id),
    enabled: Boolean(me.data?.id),
  });
  const toConfirm = useQuery({
    queryKey: ["memosToConfirm", me.data?.id],
    queryFn: () => listMemosToConfirm(me.data!.id),
    enabled: Boolean(me.data?.id),
  });
  useRealtimeMyOpenings(me.data?.id);

  const rows = openings.data ?? [];
  const active = rows.filter((o) => o.status !== "installed");
  const done = rows.filter((o) => o.status === "installed");

  // Toast when a new window is assigned to me while I'm looking at the list.
  const [newlyAssigned, setNewlyAssigned] = useState(0);
  const prevActiveRef = useRef<number | null>(null);
  useEffect(() => {
    const prev = prevActiveRef.current;
    if (prev !== null && active.length > prev) {
      setNewlyAssigned(active.length - prev);
    }
    prevActiveRef.current = active.length;
  }, [active.length]);

  const byId = new Map(active.map((o) => [o.id, o]));
  const ordered = orderMyWork(active.map(toDispatch))
    .map((d) => byId.get(d.id)!)
    .filter(Boolean);
  const next = ordered[0];
  const readyCount = active.filter((o) => openingReadiness(o).status === "ready").length;

  // Group the rest by job so a multi-job installer sees where work lives.
  const rest = ordered.slice(1);
  const jobs = new Map<string, { code: string; name: string; items: ProjectOpening[] }>();
  for (const o of rest) {
    const key = o.project_id;
    const g = jobs.get(key) ?? {
      code: o.projects?.job_code ?? "Job",
      name: o.projects?.name ?? "",
      items: [],
    };
    g.items.push(o);
    jobs.set(key, g);
  }

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

  const captureHint = (o: ProjectOpening) => {
    const r = openingReadiness(o);
    if (r.status === "ready") return "Tap to install — photos, voice memo, grade";
    if (r.status === "blocked") return r.reasons.join(" ");
    return r.reasons[0] ?? "Finish checks before installing";
  };

  if (me.isLoading)
    return <div className="page"><p className="muted">Loading…</p></div>;

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <p className="home-greeting">Your day</p>
          <h1>My work</h1>
        </div>
        {isForemanPlus(effectiveRole) && (
          <Link to="/training" className="button-like">
            Training
          </Link>
        )}
      </header>
      <p className="muted">
        {me.data?.display_name ? `${me.data.display_name} — ` : ""}do the top
        window next; capture as you go.
      </p>

      {newlyAssigned > 0 && (
        <div className="assign-toast" onClick={() => setNewlyAssigned(0)}>
          {newlyAssigned} new window{newlyAssigned > 1 ? "s" : ""} assigned to you — tap to dismiss
        </div>
      )}

      <div className="stat-grid">
        <div className="stat-card">
          <span className="stat-num">{active.length}</span>
          <span>assigned</span>
        </div>
        <div className="stat-card accent">
          <span className="stat-num">{readyCount}</span>
          <span>ready now</span>
        </div>
        <div className="stat-card">
          <span className="stat-num">{done.length}</span>
          <span>done today</span>
        </div>
      </div>

      {(toConfirm.data?.length ?? 0) > 0 && (
        <Link to="/review" className="action-btn">
          Review {toConfirm.data!.length} AI-filled memo(s) →
        </Link>
      )}

      {!next && (
        <p className="muted">
          Nothing assigned right now. Check with your lead, or help stage the
          next windows.
        </p>
      )}

      {next && (
        <button className="next-card" onClick={() => go(next)}>
          <span className="next-label">Next window</span>
          <span className="next-code">{next.opening_code}</span>
          <span className="next-meta">
            {next.window_types?.type_code ?? "type?"} ·{" "}
            {next.projects?.job_code ?? ""} · {areaKey(next)}
          </span>
          <span className="next-ready">{readinessTag(next)}</span>
          <span className="next-capture">{captureHint(next)}</span>
        </button>
      )}

      {[...jobs.values()].map((job) => (
        <div key={job.code}>
          <h2>
            {job.code} <span className="muted">· {job.items.length} to go</span>
          </h2>
          <ul className="unit-list work-list">
            {job.items.map((o) => (
              <li
                key={o.id}
                className="find-row"
                onClick={() => go(o)}
                style={{ cursor: "pointer" }}
              >
                <div>
                  <strong>{o.opening_code}</strong>{" "}
                  <span className="muted">{o.window_types?.type_code}</span>
                  <div className="muted" style={{ fontSize: 12 }}>
                    {areaKey(o)} · {captureHint(o)}
                  </div>
                </div>
                <span style={{ marginLeft: "auto" }}>{readinessTag(o)}</span>
              </li>
            ))}
          </ul>
        </div>
      ))}

      {done.length > 0 && (
        <>
          <h2>Done today ({done.length})</h2>
          <ul className="unit-list work-list">
            {done.map((o) => (
              <li key={o.id} className="find-row">
                <strong>{o.opening_code}</strong>{" "}
                <span className="muted">{o.window_types?.type_code}</span>{" "}
                <span className="ok" style={{ marginLeft: "auto" }}>installed</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
