import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { supabase } from "../lib/supabase";
import {
  assignIssue,
  compareIssues,
  issuePhotoUrls,
  KIND_LABELS,
  KIND_ORDER,
  listIssues,
  resolveIssue,
  FAULT_TRADES,
  setIssueFaultTrade,
  URGENCY_MARK,
  type Issue,
  type IssueStatus,
} from "../lib/issues";
import { listServiceCases } from "../lib/service";
import { listQcStatusForOpenings } from "../lib/ops";
import { formatApiError } from "../lib/errors";
import {
  openingUnitKind,
  openingUnitKindResolver,
} from "../lib/install/unitKind";

interface ProjectLite {
  id: string;
  job_code: string;
  name: string;
  status: string;
}
interface OpeningLite {
  id: string;
  opening_code: string;
  window_types: {
    category: string | null;
    type_code: string | null;
    name: string | null;
  } | null;
}
interface MarkSpecLite {
  project_id: string;
  mark_code: string;
  style: string | null;
}
interface ProfileLite {
  id: string;
  display_name: string;
}

async function fetchIssueRefs(): Promise<{
  projects: ProjectLite[];
  openings: OpeningLite[];
  markSpecs: MarkSpecLite[];
  profiles: ProfileLite[];
}> {
  const [projRes, openRes, specRes, profRes] = await Promise.all([
    supabase.from("projects").select("id, job_code, name, status"),
    supabase
      .from("project_openings")
      .select("id, opening_code, window_types(category, type_code, name)"),
    // The descriptions decide window vs door. A mark code only means anything
    // inside its own job, so the project id comes with it.
    supabase.from("project_mark_specs").select("project_id, mark_code, style"),
    supabase.from("profiles").select("id, display_name"),
  ]);
  if (projRes.error) throw projRes.error;
  if (openRes.error) throw openRes.error;
  if (specRes.error) throw specRes.error;
  if (profRes.error) throw profRes.error;
  return {
    projects: (projRes.data ?? []) as ProjectLite[],
    openings: (openRes.data ?? []) as unknown as OpeningLite[],
    markSpecs: (specRes.data ?? []) as MarkSpecLite[],
    profiles: (profRes.data ?? []) as ProfileLite[],
  };
}

function fmtWhen(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleString();
}

export function Issues() {
  const queryClient = useQueryClient();
  const [projectFilter, setProjectFilter] = useState<string>("all");
  const [kindFilter, setKindFilter] = useState<string>("all");
  const [statusFilter, setStatusFilter] = useState<IssueStatus>("open");
  // Which issue's damage photo is open full-screen (ticket 11), or none.
  const [viewerIssue, setViewerIssue] = useState<Issue | null>(null);

  const issuesQ = useQuery({ queryKey: ["issues"], queryFn: listIssues });
  const refsQ = useQuery({ queryKey: ["issueRefs"], queryFn: fetchIssueRefs });
  // Cross-links into the quality surfaces: an open warranty case on the same
  // unit, or the QC result on the same opening.
  const servicesQ = useQuery({ queryKey: ["serviceCasesAll"], queryFn: listServiceCases });
  // Only the openings the VISIBLE issues actually reference — this used to
  // pull the whole installed-openings pool, which is capped and starves past
  // 100 installs company-wide, so the cross-link quietly stopped appearing for
  // anything past the cut (P2).
  const qcOpeningIds = useMemo(
    () =>
      [...new Set((issuesQ.data ?? []).map((i) => i.opening_id).filter((v): v is string => Boolean(v)))],
    [issuesQ.data],
  );
  const qcQ = useQuery({
    queryKey: ["qcStatusForOpenings", qcOpeningIds],
    queryFn: () => listQcStatusForOpenings(qcOpeningIds),
    enabled: qcOpeningIds.length > 0,
  });

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
    // Fault is a TRADE (owner call): Carpentry, Plumbing, HVAC… — people
    // stay on Assign.
    mutationFn: ({ id, trade }: { id: string; trade: string | null }) =>
      setIssueFaultTrade(id, trade),
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
  // One window/door resolver per job, so this list agrees with that job's map.
  const unitKindByProject = useMemo(() => {
    const specsByProject = new Map<string, MarkSpecLite[]>();
    for (const s of refsQ.data?.markSpecs ?? []) {
      const list = specsByProject.get(s.project_id);
      if (list) list.push(s);
      else specsByProject.set(s.project_id, [s]);
    }
    const m = new Map<string, ReturnType<typeof openingUnitKindResolver>>();
    for (const [pid, specs] of specsByProject) {
      m.set(pid, openingUnitKindResolver(specs));
    }
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
  const qcByOpening = qcQ.data ?? new Map<string, string>();

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

  // Signed URLs for the photos on whichever issues are actually on screen
  // (ticket 11) — scoped to `visible`, not `all`, for the same reason
  // qcOpeningIds is scoped above: no point signing a URL nobody can see.
  const photoTargets = useMemo(
    () =>
      visible
        .map((i) => (i.photo_path ? { id: i.id, photoPath: i.photo_path } : null))
        .filter((t): t is { id: string; photoPath: string } => t !== null),
    [visible],
  );
  const photosQ = useQuery({
    queryKey: ["issuePhotoUrls", photoTargets.map((t) => t.id)],
    queryFn: () => issuePhotoUrls(photoTargets),
    enabled: photoTargets.length > 0,
  });
  const photoUrlById = photosQ.data ?? new Map<string, string | null>();

  const row = (i: Issue) => {
    const project = projectById.get(i.project_id);
    const opening = i.opening_id ? openingById.get(i.opening_id) : null;
    const mark = URGENCY_MARK[i.urgency];
    const who = i.created_by ? (nameById.get(i.created_by) ?? "someone") : "system";
    const urgent = i.urgency !== "normal";
    const hasOpenCase = Boolean(i.window_id && openCaseWindows.has(i.window_id));
    const qcStatus = i.opening_id ? qcByOpening.get(i.opening_id) : undefined;
    // Which opening the problem is about, coloured blue (window) / green (door).
    const isDoor = Boolean(
      opening &&
        (unitKindByProject.get(i.project_id) ?? openingUnitKind)(opening) ===
          "door",
    );
    const unitColor = isDoor ? "var(--ok)" : "var(--info)";
    const assignedTo = i.assigned_to ?? null;
    const faultTrade = i.fault_trade ?? null;
    // The note may be a bulleted punch list (framing files them joined with
    // " \u2022 ") - break it into real lines so it reads like a checklist,
    // not a stack trace.
    const noteParts = (i.note ?? "")
      .split(" \u2022 ")
      .map((t) => t.trim())
      .filter(Boolean);
    return (
      <li
        key={i.id}
        className={`issue-card${urgent && i.status === "open" ? " urgent" : ""}${
          i.status === "resolved" ? " resolved" : ""
        }`}
      >
        <div style={{ minWidth: 0, flex: 1 }}>
          <div className="issue-card-head">
            <span className={`issue-kind kind-${i.kind}`}>
              {mark ? `${mark} ` : ""}
              {KIND_LABELS[i.kind]}
            </span>
            <span className="issue-job" title={project?.name ?? undefined}>
              {project?.job_code ?? "job?"}
              {project?.name ? ` · ${project.name}` : ""}
            </span>
            {opening && (
              <Link
                to={`/projects/${i.project_id}/opening/${i.opening_id}`}
                className="issue-opening"
                style={{ color: unitColor }}
                title={isDoor ? "Door" : "Window"}
              >
                {isDoor ? "▮" : "▯"} {opening.opening_code}
              </Link>
            )}
          </div>
          {noteParts.length > 1 ? (
            <ul className="issue-note-list">
              {noteParts.map((t, idx) => (
                <li key={idx}>{t}</li>
              ))}
            </ul>
          ) : (
            noteParts[0] && <p className="issue-note">{noteParts[0]}</p>
          )}
          {i.photo_path && (
            <button
              type="button"
              className="issue-photo-thumb"
              onClick={() => setViewerIssue(i)}
              aria-label="View the damage photo"
            >
              {photoUrlById.get(i.id) ? (
                <img src={photoUrlById.get(i.id)!} alt="" />
              ) : (
                <span className="muted" style={{ fontSize: 10 }}>Photo</span>
              )}
            </button>
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
            {faultTrade ? `Fault: ${faultTrade}` : "Fault: not attributed"}
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
                // Compare to THIS row's id, not just isPending — the mutation
                // flag is shared across every row, so without the id check,
                // assigning one issue would grey out every other issue's
                // Assign dropdown until the request finished.
                disabled={assign.isPending && assign.variables?.id === i.id}
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
                value={faultTrade ?? ""}
                // Same fix as Assign above: match the in-flight row's id so
                // attributing fault on one issue doesn't lock the Fault
                // dropdown on every other issue in the list.
                disabled={fault.isPending && fault.variables?.id === i.id}
                onChange={(e) =>
                  fault.mutate({ id: i.id, trade: e.target.value || null })
                }
              >
                <option value="">— not attributed —</option>
                {FAULT_TRADES.map((t) => (
                  <option key={t} value={t}>
                    {t}
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
            // Same fix as Assign/Fault: resolve.mutate() takes the issue id
            // directly, so compare it to this row's id instead of the bare
            // isPending flag, or resolving one issue would disable every
            // other issue's Resolve button too.
            disabled={resolve.isPending && resolve.variables === i.id}
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

      {resolve.isError && <p className="error">{formatApiError(resolve.error)}</p>}
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
      {issuesQ.isError && <p className="error">{formatApiError(issuesQ.error)}</p>}

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

      {viewerIssue && (
        <div
          className="photo-viewer-backdrop overlay-enter"
          role="dialog"
          aria-modal="true"
          onClick={() => setViewerIssue(null)}
        >
          <div className="photo-viewer" onClick={(e) => e.stopPropagation()}>
            {photoUrlById.get(viewerIssue.id) ? (
              <img src={photoUrlById.get(viewerIssue.id)!} alt="Damage photo" />
            ) : (
              <p className="muted">Photo unavailable right now.</p>
            )}
            <div className="photo-viewer-info">
              <p className="photo-viewer-caption">
                {KIND_LABELS[viewerIssue.kind]}
                {projectById.get(viewerIssue.project_id)?.job_code
                  ? ` · ${projectById.get(viewerIssue.project_id)!.job_code}`
                  : ""}
              </p>
            </div>
            <button
              type="button"
              className="action-btn photo-viewer-close"
              onClick={() => setViewerIssue(null)}
            >
              Close
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
