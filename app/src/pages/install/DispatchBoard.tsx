import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import {
  assignOpeningToInstaller,
  buildPerfIndex,
  listClearances,
  listInstallerTypeStats,
  listOpenings,
  listProfiles,
  unassignOpening,
} from "../../lib/install/api";
import { openingReadiness } from "../../lib/install/fit";
import {
  autoDistribute,
  type DispatchContext,
  type DispatchCrew,
  type DispatchOpening,
} from "../../lib/dispatch";
import type { ProjectOpening } from "../../lib/install/types";

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

  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: ["openings", projectId] });

  const assign = useMutation({
    mutationFn: (args: { openingId: string; profileId: string }) =>
      assignOpeningToInstaller(args.openingId, args.profileId),
    onSuccess: refresh,
    onError: (e) => setMessage(String(e)),
  });

  const unassign = useMutation({
    mutationFn: (openingId: string) => unassignOpening(openingId),
    onSuccess: refresh,
    onError: (e) => setMessage(String(e)),
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
    onError: (e) => setMessage(String(e)),
  });

  const all = openings.data ?? [];
  const activeCrew = (crew.data ?? []).filter((c) => c.active);

  const { byInstaller, unassigned, blocked, installedCount } = useMemo(() => {
    const byInstaller = new Map<string, ProjectOpening[]>();
    const unassigned: ProjectOpening[] = [];
    const blocked: ProjectOpening[] = [];
    let installedCount = 0;
    for (const o of openings.data ?? []) {
      if (o.status === "installed") {
        installedCount += 1;
        continue;
      }
      const r = openingReadiness(o);
      if (r.status === "blocked") {
        blocked.push(o);
        continue;
      }
      if (o.assigned_to) {
        const list = byInstaller.get(o.assigned_to) ?? [];
        list.push(o);
        byInstaller.set(o.assigned_to, list);
      } else {
        unassigned.push(o);
      }
    }
    return { byInstaller, unassigned, blocked, installedCount };
  }, [openings.data]);

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
          {c.role === "lead" ? ", lead" : ""})
        </option>
      ))}
    </select>
  );

  const openingRow = (o: ProjectOpening) => {
    const r = openingReadiness(o);
    return (
      <li key={o.id} className="dispatch-row">
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
        <div style={{ marginLeft: "auto" }}>{assignPicker(o)}</div>
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

      {blocked.length > 0 && (
        <>
          <h2 className="blocker-head">Blockers ({blocked.length}) — resolve to unblock</h2>
          <ul className="unit-list">
            {blocked.map((o) => {
              const r = openingReadiness(o);
              return (
                <li key={o.id} className="dispatch-row blocker">
                  <div>
                    <strong>{o.opening_code}</strong>{" "}
                    <span className="muted">{o.window_types?.type_code}</span>
                    <div className="error" style={{ fontSize: 12 }}>
                      {r.reasons.join(" ")}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        </>
      )}

      <h2>Unassigned ({unassigned.length})</h2>
      <ul className="unit-list">
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
                {c.role === "lead" ? " · lead" : ""} · {list.length} assigned
              </span>
            </h2>
            <ul className="unit-list">
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
