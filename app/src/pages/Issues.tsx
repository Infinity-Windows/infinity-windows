import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { supabase } from "../lib/supabase";
import {
  compareIssues,
  KIND_LABELS,
  listIssues,
  resolveIssue,
  URGENCY_MARK,
  type Issue,
  type IssueKind,
  type IssueStatus,
} from "../lib/issues";

interface ProjectLite {
  id: string;
  job_code: string;
  name: string;
}
interface OpeningLite {
  id: string;
  opening_code: string;
}
interface ProfileLite {
  id: string;
  display_name: string;
}

async function fetchIssueRefs(): Promise<{
  projects: ProjectLite[];
  openings: OpeningLite[];
  profiles: ProfileLite[];
}> {
  const [projRes, openRes, profRes] = await Promise.all([
    supabase.from("projects").select("id, job_code, name"),
    supabase.from("project_openings").select("id, opening_code"),
    supabase.from("profiles").select("id, display_name"),
  ]);
  if (projRes.error) throw projRes.error;
  if (openRes.error) throw openRes.error;
  if (profRes.error) throw profRes.error;
  return {
    projects: (projRes.data ?? []) as ProjectLite[],
    openings: (openRes.data ?? []) as OpeningLite[],
    profiles: (profRes.data ?? []) as ProfileLite[],
  };
}

function fmtWhen(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleString();
}

const KIND_ORDER: IssueKind[] = [
  "failed_install",
  "damage",
  "flag",
  "blocker",
  "complication",
];

export function Issues() {
  const queryClient = useQueryClient();
  const [projectFilter, setProjectFilter] = useState<string>("all");
  const [kindFilter, setKindFilter] = useState<string>("all");
  const [statusFilter, setStatusFilter] = useState<IssueStatus>("open");

  const issuesQ = useQuery({ queryKey: ["issues"], queryFn: listIssues });
  const refsQ = useQuery({ queryKey: ["issueRefs"], queryFn: fetchIssueRefs });

  const resolve = useMutation({
    mutationFn: (id: string) => resolveIssue(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["issues"] }),
  });

  const projectById = useMemo(() => {
    const m = new Map<string, ProjectLite>();
    for (const p of refsQ.data?.projects ?? []) m.set(p.id, p);
    return m;
  }, [refsQ.data]);
  const openingById = useMemo(() => {
    const m = new Map<string, OpeningLite>();
    for (const o of refsQ.data?.openings ?? []) m.set(o.id, o);
    return m;
  }, [refsQ.data]);
  const nameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of refsQ.data?.profiles ?? []) m.set(p.id, p.display_name);
    return m;
  }, [refsQ.data]);

  const all = useMemo(() => issuesQ.data ?? [], [issuesQ.data]);

  // Projects that actually have issues (keeps the filter tidy).
  const projectOptions = useMemo(() => {
    const ids = new Set(all.map((i) => i.project_id));
    return [...ids]
      .map((id) => projectById.get(id))
      .filter((p): p is ProjectLite => Boolean(p))
      .sort((a, b) => a.job_code.localeCompare(b.job_code));
  }, [all, projectById]);

  const visible = useMemo(() => {
    return all
      .filter((i) => i.status === statusFilter)
      .filter((i) => projectFilter === "all" || i.project_id === projectFilter)
      .filter((i) => kindFilter === "all" || i.kind === kindFilter)
      .sort(compareIssues);
  }, [all, statusFilter, projectFilter, kindFilter]);

  const openCount = all.filter((i) => i.status === "open").length;

  const row = (i: Issue) => {
    const project = projectById.get(i.project_id);
    const opening = i.opening_id ? openingById.get(i.opening_id) : null;
    const mark = URGENCY_MARK[i.urgency];
    const who = i.created_by ? (nameById.get(i.created_by) ?? "someone") : "system";
    const urgent = i.urgency !== "normal";
    return (
      <li key={i.id} className="find-row dispatch-row">
        <div style={{ minWidth: 0 }}>
          <div>
            {mark && (
              <strong className="error" style={{ marginRight: 6 }}>
                {mark}
              </strong>
            )}
            <strong>{KIND_LABELS[i.kind]}</strong>{" "}
            <span className="muted">
              {project?.job_code ?? "job?"}
              {opening ? " · " : ""}
            </span>
            {opening && (
              <Link to={`/projects/${i.project_id}/opening/${i.opening_id}`}>
                {opening.opening_code}
              </Link>
            )}
          </div>
          {i.note && (
            <div className={urgent ? "error" : "warn-text"} style={{ fontSize: 13 }}>
              {i.note}
            </div>
          )}
          <div className="muted" style={{ fontSize: 12 }}>
            {i.status === "resolved"
              ? `resolved ${fmtWhen(i.resolved_at)}${
                  i.resolved_by ? ` by ${nameById.get(i.resolved_by) ?? "someone"}` : ""
                }`
              : `opened by ${who} · ${fmtWhen(i.created_at)}`}
          </div>
        </div>
        {i.status === "open" && (
          <button
            className="link"
            style={{ marginLeft: "auto" }}
            disabled={resolve.isPending}
            onClick={() => resolve.mutate(i.id)}
          >
            Resolve
          </button>
        )}
      </li>
    );
  };

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <p className="home-greeting">Cross-project</p>
          <h1>Issues</h1>
        </div>
      </header>

      <p className="muted">
        Every problem across all jobs — failed installs, damage, flags, blockers,
        and complications — in one tiered list. <strong>!!!</strong> emergency,{" "}
        <strong>!</strong> urgent, then oldest first. {openCount} open.
      </p>

      {resolve.isError && <p className="error">{String(resolve.error)}</p>}

      <div className="filter-row" style={{ display: "flex", gap: 8, flexWrap: "wrap", margin: "8px 0 16px" }}>
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as IssueStatus)}>
          <option value="open">Open</option>
          <option value="resolved">Resolved</option>
        </select>
        <select value={projectFilter} onChange={(e) => setProjectFilter(e.target.value)}>
          <option value="all">All jobs</option>
          {projectOptions.map((p) => (
            <option key={p.id} value={p.id}>
              {p.job_code} — {p.name}
            </option>
          ))}
        </select>
        <select value={kindFilter} onChange={(e) => setKindFilter(e.target.value)}>
          <option value="all">All kinds</option>
          {KIND_ORDER.map((k) => (
            <option key={k} value={k}>
              {KIND_LABELS[k]}
            </option>
          ))}
        </select>
      </div>

      {issuesQ.isLoading && <p className="muted">Loading issues…</p>}
      {issuesQ.isError && <p className="error">{String(issuesQ.error)}</p>}

      {!issuesQ.isLoading && !issuesQ.isError && (
        <ul className="unit-list work-list">
          {visible.map(row)}
          {visible.length === 0 && (
            <p className="muted">
              {statusFilter === "open"
                ? "No open issues — everything's clean."
                : "No resolved issues match these filters."}
            </p>
          )}
        </ul>
      )}
    </div>
  );
}
