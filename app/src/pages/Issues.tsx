import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { supabase } from "../lib/supabase";
import {
  assignIssue,
  compareIssues,
  KIND_LABELS,
  listIssues,
  resolveIssue,
  setIssueFault,
  URGENCY_MARK,
  type Issue,
  type IssueKind,
  type IssueStatus,
} from "../lib/issues";
import { listServiceCases } from "../lib/service";
import { listInstalledForQc } from "../lib/ops";
import { formatApiError } from "../lib/errors";

interface ProjectLite {
  id: string;
  job_code: string;
  name: string;
  status: string;
}
interface OpeningLite {
  id: string;
  opening_code: string;
  window_types: { category: string | null } | null;
}
interface ProfileLite {
  id: string;
  display_name: string;
}

/** Blue = window, green = door — same category convention as ProjectMap. */
function openingIsDoor(o: OpeningLite | null | undefined): boolean {
  return (o?.window_types?.category ?? "").toLowerCase().includes("door");
}

async function fetchIssueRefs(): Promise<{
  projects: ProjectLite[];
  openings: OpeningLite[];
  profiles: ProfileLite[];
}> {
  const [projRes, openRes, profRes] = await Promise.all([
    supabase.from("projects").select("id, job_code, name, status"),
    supabase
      .from("project_openings")
      .select("id, opening_code, window_types(category)"),
    supabase.from("profiles").select("id, display_name"),
  ]);
  if (projRes.error) throw projRes.error;
  if (openRes.error) throw openRes.error;
  if (profRes.error) throw profRes.error;
  return {
    projects: (projRes.data ?? []) as ProjectLite[],
    openings: (openRes.data ?? []) as unknown as OpeningLite[],
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
  // Cross-links into the quality surfaces: an open warranty case on the same
  // unit, or the QC result on the same opening.
  const servicesQ = useQuery({ queryKey: ["serviceCasesAll"], queryFn: listServiceCases });
  const qcQ = useQuery({ queryKey: ["qcInstalled"], queryFn: listInstalledForQc });

  const resolve = useMutation({
    mutationFn: (id: string) => resolveIssue(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["issues"] }),
  });
  const assign = useMutation({
    mutationFn: ({ id, assignee }: { id: string; assignee: string | null }) =>
      assignIssue(id, assignee),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["issues"] }),
  });
  const fault = useMutation({
    mutationFn: ({ id, faultBy }: { id: string; faultBy: string | null }) =>
      setIssueFault(id, faultBy),
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
  // People available to assign / attribute fault to, alphabetical.
  const people = useMemo(
    () =>
      [...(refsQ.data?.profiles ?? [])].sort((a, b) =>
        a.display_name.localeCompare(b.display_name),
      ),
    [refsQ.data],
  );

  const all = useMemo(() => issuesQ.data ?? [], [issuesQ.data]);

  // Units with an open (not-yet-resolved) warranty/service case.
  const openCaseWindows = useMemo(() => {
    const s = new Set<string>();
    for (const c of servicesQ.data ?? []) {
      if (c.status !== "resolved") s.add(c.window_id);
    }
    return s;
  }, [servicesQ.data]);
  // QC result keyed by opening id.
  const qcByOpening = useMemo(() => {
    const m = new Map<string, string>();
    for (const o of qcQ.data ?? []) {
      if (o.qc?.status) m.set(o.id, o.qc.status);
    }
    return m;
  }, [qcQ.data]);

  // Every active job, so a user can filter to a job and see its issues — both
  // open AND resolved — even if that job has none right now. Any job that has
  // issues but is no longer active is folded back in so its history stays
  // reachable.
  const projectOptions = useMemo(() => {
    const byId = new Map<string, ProjectLite>();
    for (const p of refsQ.data?.projects ?? []) {
      if (p.status === "active") byId.set(p.id, p);
    }
    for (const i of all) {
      if (!byId.has(i.project_id)) {
        const p = projectById.get(i.project_id);
        if (p) byId.set(p.id, p);
      }
    }
    return [...byId.values()].sort((a, b) =>
      a.job_code.localeCompare(b.job_code),
    );
  }, [refsQ.data, all, projectById]);

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
    const hasOpenCase = Boolean(i.window_id && openCaseWindows.has(i.window_id));
    const qcStatus = i.opening_id ? qcByOpening.get(i.opening_id) : undefined;
    // Which opening the problem is about, coloured blue (window) / green (door).
    const isDoor = openingIsDoor(opening);
    const unitColor = isDoor ? "var(--ok)" : "var(--info)";
    const assignedTo = i.assigned_to ?? null;
    const faultBy = i.fault_by ?? null;
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
              <Link
                to={`/projects/${i.project_id}/opening/${i.opening_id}`}
                style={{
                  color: unitColor,
                  fontWeight: 600,
                }}
                title={isDoor ? "Door" : "Window"}
              >
                {isDoor ? "▮" : "▯"} {opening.opening_code}
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
          <div
            className="muted"
            style={{ fontSize: 12, marginTop: 2 }}
          >
            {assignedTo
              ? `Assigned to ${nameById.get(assignedTo) ?? "someone"}`
              : "Unassigned"}
            {" · "}
            {faultBy
              ? `Fault: ${nameById.get(faultBy) ?? "someone"}`
              : "Fault: not attributed"}
          </div>
          <div
            style={{
              display: "flex",
              gap: 8,
              flexWrap: "wrap",
              marginTop: 6,
              fontSize: 12,
            }}
          >
            <label style={{ display: "flex", alignItems: "center", gap: 4 }}>
              <span className="muted">Assign</span>
              <select
                value={assignedTo ?? ""}
                disabled={assign.isPending}
                onChange={(e) =>
                  assign.mutate({ id: i.id, assignee: e.target.value || null })
                }
              >
                <option value="">— nobody —</option>
                {people.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.display_name}
                  </option>
                ))}
              </select>
            </label>
            <label style={{ display: "flex", alignItems: "center", gap: 4 }}>
              <span className="muted">Fault</span>
              <select
                value={faultBy ?? ""}
                disabled={fault.isPending}
                onChange={(e) =>
                  fault.mutate({ id: i.id, faultBy: e.target.value || null })
                }
              >
                <option value="">— not attributed —</option>
                {people.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.display_name}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {(hasOpenCase || qcStatus) && (
            <div style={{ fontSize: 12, marginTop: 2, display: "flex", gap: 10, flexWrap: "wrap" }}>
              {qcStatus && (
                <Link to="/qc" className={qcStatus === "callback" ? "error" : "muted"}>
                  QC: {qcStatus}
                </Link>
              )}
              {hasOpenCase && (
                <Link to="/service" className="warn-text">
                  Open service case →
                </Link>
              )}
            </div>
          )}
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
        <Link to="/service" className="button-like">
          Warranty / service →
        </Link>
      </header>

      <p className="muted">
        Every problem across all jobs — failed installs, damage, flags, blockers,
        and complications — in one tiered list. <strong>!!!</strong> emergency,{" "}
        <strong>!</strong> urgent, then oldest first. {openCount} open.
      </p>

      {resolve.isError && <p className="error">{String(resolve.error)}</p>}
      {(assign.isError || fault.isError) && (
        <p className="error">
          {formatApiError(
            assign.error ?? fault.error,
            "Couldn't save that. If the assignee / fault update hasn't been enabled yet, try again shortly.",
          )}
        </p>
      )}

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
