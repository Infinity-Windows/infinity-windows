import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  assignOpeningToInstaller,
  buildPerfIndex,
  listClearances,
  listInstallerTypeStats,
  listJobNotes,
  listOpenings,
  listProfiles,
  unassignOpening,
} from "../../lib/install/api";
import { formatApiError } from "../../lib/install/errors";
import { openingReadiness } from "../../lib/install/fit";
import {
  autoDistribute,
  type DispatchContext,
  type DispatchCrew,
  type DispatchOpening,
} from "../../lib/dispatch";
import { OpeningDetailCard } from "../../components/install/OpeningDetailCard";
import { OpeningRowButton } from "../../components/install/OpeningRowButton";
import { installerColorMap } from "../../lib/install/mapDispatch";
import { toggleExpandedOpening } from "../../lib/install/openingRowAction";
import type { ProjectOpening } from "../../lib/install/types";
import {
  compareIssues,
  KIND_LABELS,
  listProjectIssues,
  resolveIssue,
  URGENCY_MARK,
} from "../../lib/issues";

function areaKey(o: ProjectOpening): string {
  return o.label?.trim() || `page ${o.page_number}`;
}

function toDispatchOpening(o: ProjectOpening): DispatchOpening {
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

export function DispatchBoard({ projectId }: { projectId: string }) {
  const queryClient = useQueryClient();
  const [message, setMessage] = useState<string | null>(null);
  // Which row has its details open. One at a time: this is a working screen and
  // a foreman assigning 42 openings should not have to close a trail of panels.
  const [expandedRowId, setExpandedRowId] = useState<string | null>(null);

  const openings = useQuery({
    queryKey: ["openings", projectId],
    queryFn: () => listOpenings(projectId),
  });
  const crew = useQuery({ queryKey: ["profiles"], queryFn: listProfiles });
  const perfStats = useQuery({
    queryKey: ["installerTypeStats"],
    queryFn: listInstallerTypeStats,
  });
  const clearances = useQuery({
    queryKey: ["clearances"],
    queryFn: listClearances,
  });
  const jobNotes = useQuery({
    queryKey: ["jobNotes", projectId],
    queryFn: () => listJobNotes(projectId),
  });
  const issues = useQuery({
    queryKey: ["projectIssues", projectId],
    queryFn: () => listProjectIssues(projectId),
  });

  const resolveIssueM = useMutation({
    mutationFn: (id: string) => resolveIssue(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["projectIssues", projectId] });
      queryClient.invalidateQueries({ queryKey: ["issues"] });
    },
    onError: (e) => setMessage(formatApiError(e)),
  });

  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: ["openings", projectId] });

  const assign = useMutation({
    mutationFn: (args: { openingId: string; profileId: string }) =>
      assignOpeningToInstaller(args.openingId, args.profileId),
    onSuccess: refresh,
    onError: (e) => setMessage(formatApiError(e)),
  });

  const unassign = useMutation({
    mutationFn: (openingId: string) => unassignOpening(openingId),
    onSuccess: refresh,
    onError: (e) => setMessage(formatApiError(e)),
  });

  const distribute = useMutation({
    mutationFn: async () => {
      const dispatchOpenings = (openings.data ?? []).map(toDispatchOpening);
      const dispatchCrew: DispatchCrew[] = (crew.data ?? []).map((c) => ({
        id: c.id,
        skill_level: c.skill_level,
        role: c.role,
        active: c.active,
        display_name: c.display_name,
      }));
      const ctx: DispatchContext = {
        perf: buildPerfIndex(perfStats.data ?? []),
        cleared: new Set(
          (clearances.data ?? []).map((c) => `${c.installer_id}:${c.window_type_id}`),
        ),
      };
      const suggestions = autoDistribute(dispatchOpenings, dispatchCrew, ctx);
      for (const s of suggestions) {
        await assignOpeningToInstaller(s.openingId, s.profileId);
      }
      return suggestions.length;
    },
    onSuccess: (n) => {
      setMessage(`Auto-distributed ${n} opening(s).`);
      refresh();
    },
    onError: (e) => setMessage(formatApiError(e)),
  });

  const all = openings.data ?? [];
  const activeCrew = (crew.data ?? []).filter((c) => c.active);
  // Same installer → same colour as the map pins and the map's detail panel.
  const crewColors = installerColorMap(activeCrew.map((c) => c.id));

  const { byInstaller, unassigned, readinessBlocked, installedCount } = useMemo(() => {
    const byInstaller = new Map<string, ProjectOpening[]>();
    const unassigned: ProjectOpening[] = [];
    const readinessBlocked: ProjectOpening[] = [];
    let installedCount = 0;
    for (const o of openings.data ?? []) {
      if (o.status === "installed") {
        installedCount += 1;
        continue;
      }
      const r = openingReadiness(o);
      // Hard readiness stops (fit/type/damage) show as blockers.
      if (r.status === "blocked") {
        readinessBlocked.push(o);
        continue;
      }
      // Flagged openings are handled through the issues list below and stay out
      // of the assignable columns until the flag is resolved.
      if (o.flag_note) continue;
      if (o.assigned_to) {
        const list = byInstaller.get(o.assigned_to) ?? [];
        list.push(o);
        byInstaller.set(o.assigned_to, list);
      } else {
        unassigned.push(o);
      }
    }
    return { byInstaller, unassigned, readinessBlocked, installedCount };
  }, [openings.data]);

  // Open issues that belong in the Blockers view (field-reported problems).
  const openIssues = (issues.data ?? [])
    .filter(
      (i) =>
        i.status === "open" &&
        (i.kind === "blocker" || i.kind === "damage" || i.kind === "flag"),
    )
    .sort(compareIssues);
  const openingCodeById = new Map(
    (openings.data ?? []).map((o) => [o.id, o.opening_code]),
  );
  const blockerCount = openIssues.length + readinessBlocked.length;

  const nameOf = (id: string) =>
    (crew.data ?? []).find((c) => c.id === id)?.display_name ?? "unknown";

  const assignPicker = (o: ProjectOpening) => (
    <select
      value={o.assigned_to ?? ""}
      onChange={(e) => {
        const v = e.target.value;
        if (!v) unassign.mutate(o.id);
        else assign.mutate({ openingId: o.id, profileId: v });
      }}
    >
      <option value="">— unassigned —</option>
      {activeCrew.map((c) => (
        <option key={c.id} value={c.id}>
          {c.display_name} (skill {c.skill_level}
          {c.role !== "installer" ? `, ${c.role}` : ""})
        </option>
      ))}
    </select>
  );

  const openingRow = (o: ProjectOpening) => {
    const r = openingReadiness(o);
    const panelId = `dispatch-row-panel-${o.id}`;
    const expanded = expandedRowId === o.id;
    return (
      <li key={o.id} className="dispatch-row find-row">
        <OpeningRowButton
          openingCode={o.opening_code}
          expanded={expanded}
          panelId={panelId}
          onToggle={() =>
            setExpandedRowId((prev) => toggleExpandedOpening(prev, o.id))
          }
        >
          <div>
            <strong>{o.opening_code}</strong>{" "}
            <span className="muted">
              {o.window_types?.type_code ?? "type?"}
              {o.window_types?.difficulty_rating
                ? ` · ${"★".repeat(o.window_types.outcome_difficulty ?? o.window_types.difficulty_rating)}`
                : ""}
            </span>
            <div className="muted" style={{ fontSize: 12 }}>
              {areaKey(o)} ·{" "}
              <span
                className={
                  r.status === "ready" ? "ok" : r.status === "blocked" ? "error" : "warn-text"
                }
              >
                {o.work_started_at && o.status !== "installed" ? "in progress" : r.status}
              </span>
            </div>
          </div>
        </OpeningRowButton>
        <div style={{ marginLeft: "auto" }}>{assignPicker(o)}</div>
        {expanded && (
          <div className="opening-row-panel">
            <OpeningDetailCard
              projectId={projectId}
              opening={o}
              installerColor={
                o.assignee ? crewColors.get(o.assignee.id) : undefined
              }
              onClose={() => setExpandedRowId(null)}
              id={panelId}
            />
          </div>
        )}
      </li>
    );
  };

  return (
    <div>
      {message && <p className="ok">{message}</p>}
      <div className="row-between">
        <h2>Dispatch</h2>
        <button
          className="primary"
          disabled={distribute.isPending || unassigned.length === 0 || activeCrew.length === 0}
          onClick={() => distribute.mutate()}
        >
          {distribute.isPending ? "Distributing…" : "Auto-distribute"}
        </button>
      </div>
      <p className="muted">
        {installedCount}/{all.length} installed · {activeCrew.length} on site
      </p>

      {blockerCount > 0 && (
        <>
          <h2 className="blocker-head">Blockers ({blockerCount}) — resolve to unblock</h2>
          <ul className="unit-list work-list">
            {openIssues.map((i) => {
              const code = i.opening_id
                ? openingCodeById.get(i.opening_id) ?? "opening"
                : "job";
              const mark = URGENCY_MARK[i.urgency];
              return (
                <li key={i.id} className="dispatch-row blocker find-row">
                  <div style={{ minWidth: 0 }}>
                    {i.opening_id ? (
                      <Link to={`/projects/${projectId}/opening/${i.opening_id}`}>
                        <strong>{code}</strong>
                      </Link>
                    ) : (
                      <strong>{code}</strong>
                    )}{" "}
                    <span className="muted">{KIND_LABELS[i.kind]}</span>
                    <div className="error" style={{ fontSize: 12 }}>
                      {mark ? `${mark} ` : ""}
                      {i.note ?? KIND_LABELS[i.kind]}
                    </div>
                  </div>
                  <button
                    className="link"
                    style={{ marginLeft: "auto" }}
                    disabled={resolveIssueM.isPending}
                    onClick={() => resolveIssueM.mutate(i.id)}
                  >
                    Resolve
                  </button>
                </li>
              );
            })}
            {readinessBlocked.map((o) => {
              const r = openingReadiness(o);
              return (
                <li key={o.id} className="dispatch-row blocker find-row">
                  <div>
                    <strong>{o.opening_code}</strong>{" "}
                    <span className="muted">{o.window_types?.type_code}</span>
                    {o.assigned_to && (
                      <span className="muted"> · {nameOf(o.assigned_to)}</span>
                    )}
                    <div className="error" style={{ fontSize: 12 }}>
                      {r.reasons.join(" · ")}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        </>
      )}

      {(jobNotes.data?.length ?? 0) > 0 && (
        <>
          <h2>Site notes from the field</h2>
          <ul className="unit-list">
            {jobNotes.data!.map((n) => (
              <li key={n.id} className="site-note-card">
                <span className="muted" style={{ fontSize: 12 }}>
                  {n.created_at.slice(0, 10)} · {n.author_name ?? "crew"}
                </span>
                <div>{n.note}</div>
              </li>
            ))}
          </ul>
        </>
      )}

      <h2>Unassigned ({unassigned.length})</h2>
      <p className="muted opening-list-hint">
        Tap a window or door to see its details. The dropdown assigns it.
      </p>
      <ul className="unit-list work-list">
        {unassigned.map(openingRow)}
        {unassigned.length === 0 && (
          <p className="muted">Everything ready is assigned.</p>
        )}
      </ul>

      {activeCrew.map((c) => {
        const list = byInstaller.get(c.id) ?? [];
        return (
          <div key={c.id}>
            <h2>
              {c.display_name}{" "}
              <span className="muted">
                skill {c.skill_level}
                {c.role !== "installer" ? ` · ${c.role}` : ""} · {list.length} assigned
              </span>
            </h2>
            <ul className="unit-list work-list">
              {list.map(openingRow)}
              {list.length === 0 && <p className="muted">No windows assigned.</p>}
            </ul>
          </div>
        );
      })}
      <p className="muted" style={{ fontSize: 12 }}>
        {nameOf(activeCrew[0]?.id ?? "")
          ? ""
          : "Add crew on the Crew screen to assign work."}
      </p>
    </div>
  );
}
