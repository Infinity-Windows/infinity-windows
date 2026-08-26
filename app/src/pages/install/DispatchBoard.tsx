import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Ban, RotateCcw } from "lucide-react";
import {
  assignOpeningToInstaller,
  buildPerfIndex,
  listCapabilityBadges,
  listClearances,
  listInstallerTypeStats,
  listJobNotes,
  listOpenings,
  listProfiles,
  unassignOpening,
} from "../../lib/install/api";
import { formatApiError } from "../../lib/install/errors";
import { openingReadiness } from "../../lib/install/fit";
import { isInstallInProgress } from "../../lib/install/installTimer";
import {
  CAPABILITY_LABELS,
  type Capability,
  autoDistribute,
  type DispatchContext,
  type DispatchCrew,
} from "../../lib/dispatch";
import {
  applySessionBlocks,
  areaKey,
  toDispatchOpening,
} from "../../lib/install/nextOpening";
import { OpeningDetailCard } from "../../components/install/OpeningDetailCard";
import { OpeningRowButton } from "../../components/install/OpeningRowButton";
import { InstallChip } from "../../components/install/InstallChip";
import { installerColorMap } from "../../lib/install/mapDispatch";
import { toggleExpandedOpening } from "../../lib/install/openingRowAction";
import { readyStatusLabel, type ProjectOpening } from "../../lib/install/types";
import {
  compareIssues,
  KIND_LABELS,
  listProjectIssues,
  resolveIssue,
  URGENCY_MARK,
} from "../../lib/issues";
import {
  assignFlashRunner,
  listFlashRunners,
  listOpeningPhases,
  unassignFlashRunner,
} from "../../lib/install/phases";
import { listLiveSummons } from "../../lib/install/summons";
import {
  blockedUnits,
  listOpenRedos,
  listProjectSessions,
} from "../../lib/install/sessions";
import { showUndoToast } from "../../lib/undoToast";

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
  const badges = useQuery({
    queryKey: ["capabilityBadges"],
    queryFn: listCapabilityBadges,
  });
  const badgeSet = useMemo(
    () =>
      new Set(
        (badges.data ?? []).map((b) => `${b.installer_id}:${b.capability}`),
      ),
    [badges.data],
  );
  const jobNotes = useQuery({
    queryKey: ["jobNotes", projectId],
    queryFn: () => listJobNotes(projectId),
  });
  const issues = useQuery({
    queryKey: ["projectIssues", projectId],
    queryFn: () => listProjectIssues(projectId),
  });
  // Same query SessionStrips uses below (identical key, so React Query shares
  // the one fetch) — needed here too so auto-distribute can see which units
  // are session-blocked before it hands them out.
  const sessions = useQuery({
    queryKey: ["unitSessions", projectId],
    queryFn: () => listProjectSessions(projectId),
    refetchInterval: 30_000,
  });
  // A unit whose newest session ended in a Block is never recommended (CONTEXT.md,
  // 2026-08-17) — sending someone to a window that's waiting on hardware or a
  // decision burns trust on day one. MyWork enforces this the same way.
  const blockedIds = useMemo(
    () => new Set(blockedUnits(sessions.data ?? []).map((b) => b.openingId)),
    [sessions.data],
  );

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

  // Pick 12: a real inverse already exists for both directions of this one
  // (assign_opening_to_installer / unassign_opening), so the prior assignee
  // — captured here, before the write, from the still-unrefreshed row — is
  // what undo replays. An opening that was unassigned before goes back to
  // unassigned; one that was on someone else's list goes back to THEM, at
  // their old sequence number, not just "off the new person's list".
  const assign = useMutation({
    mutationFn: (args: {
      openingId: string;
      profileId: string;
      openingCode: string;
      priorProfileId: string | null;
      priorSequence: number | null;
    }) => assignOpeningToInstaller(args.openingId, args.profileId),
    onSuccess: (_data, args) => {
      refresh();
      showUndoToast({
        message: `#${args.openingCode} assigned to ${nameOf(args.profileId)}.`,
        undo: async () => {
          if (args.priorProfileId) {
            await assignOpeningToInstaller(
              args.openingId,
              args.priorProfileId,
              args.priorSequence,
            );
          } else {
            await unassignOpening(args.openingId);
          }
          refresh();
        },
      });
    },
    onError: (e) => setMessage(formatApiError(e)),
  });

  const unassign = useMutation({
    mutationFn: (args: {
      openingId: string;
      openingCode: string;
      priorProfileId: string | null;
      priorSequence: number | null;
    }) => unassignOpening(args.openingId),
    onSuccess: (_data, args) => {
      refresh();
      if (!args.priorProfileId) return;
      const priorProfileId = args.priorProfileId;
      const priorSequence = args.priorSequence;
      showUndoToast({
        message: `#${args.openingCode} unassigned.`,
        undo: async () => {
          await assignOpeningToInstaller(args.openingId, priorProfileId, priorSequence);
          refresh();
        },
      });
    },
    onError: (e) => setMessage(formatApiError(e)),
  });

  const distribute = useMutation({
    mutationFn: async () => {
      const dispatchOpenings = applySessionBlocks(
        (openings.data ?? []).map(toDispatchOpening),
        blockedIds,
      );
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
        badges: badgeSet,
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

  const assignPicker = (o: ProjectOpening) => {
    const need = o.window_types?.required_capability ?? null;
    const needLabel = need
      ? (CAPABILITY_LABELS[need as Capability] ?? need)
      : null;
    return (
      <select
        value={o.assigned_to ?? ""}
        onChange={(e) => {
          const v = e.target.value;
          const prior = {
            openingCode: o.opening_code,
            priorProfileId: o.assigned_to,
            priorSequence: o.sequence,
          };
          if (!v) unassign.mutate({ openingId: o.id, ...prior });
          else assign.mutate({ openingId: o.id, profileId: v, ...prior });
        }}
      >
        <option value="">— unassigned —</option>
        {activeCrew.map((c) => {
          const missing =
            need !== null &&
            c.role === "installer" &&
            !badgeSet.has(`${c.id}:${need}`);
          return (
            <option key={c.id} value={c.id} disabled={missing}>
              {c.display_name} (skill {c.skill_level}
              {c.role !== "installer" ? `, ${c.role}` : ""})
              {missing ? ` — needs the ${needLabel} badge` : ""}
            </option>
          );
        })}
      </select>
    );
  };

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
              {o.window_types?.required_capability
                ? ` · ${CAPABILITY_LABELS[o.window_types.required_capability as Capability] ?? o.window_types.required_capability}`
                : ""}
            </span>
            <div className="muted" style={{ fontSize: 12 }}>
              {areaKey(o)} ·{" "}
              <InstallChip state={r.status}>
                {isInstallInProgress(o) ? "in progress" : readyStatusLabel(r.status)}
              </InstallChip>
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

      <FlashRunCard projectId={projectId} crew={activeCrew} />
      <SummonStrip projectId={projectId} openingCodeById={openingCodeById} />
      <SessionStrips projectId={projectId} openingCodeById={openingCodeById} />

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
        Tap a unit to see its details. The dropdown assigns it.
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
              {list.length === 0 && <p className="muted">No units assigned.</p>}
            </ul>
          </div>
        );
      })}
      <p className="muted" style={{ fontSize: 12 }}>
        {activeCrew.length === 0 ? "Add crew on the Crew screen to assign work." : ""}
      </p>
    </div>
  );
}

/**
 * The flash run as a DISPATCHED task (owner, 2026-08-14): foremen put
 * 1..N runners on it here; runners see it in My Work; the run screen does
 * the clocking. Flashing time still lands per window on opening_phases.
 */
function FlashRunCard({
  projectId,
  crew,
}: {
  projectId: string;
  crew: { id: string; display_name: string | null }[];
}) {
  const queryClient = useQueryClient();
  const [err, setErr] = useState<string | null>(null);
  const openings = useQuery({
    queryKey: ["openings", projectId],
    queryFn: () => listOpenings(projectId),
  });
  const phases = useQuery({
    queryKey: ["openingPhases", projectId],
    queryFn: () => listOpeningPhases(projectId),
  });
  const runners = useQuery({
    queryKey: ["flashRunners", projectId],
    queryFn: () => listFlashRunners(projectId),
  });
  const refresh = () =>
    void queryClient.invalidateQueries({ queryKey: ["flashRunners", projectId] });
  // Pick 12: a real inverse pair already exists (assign_flash_runner /
  // unassign_flash_runner) — set membership, so there's no prior state to
  // capture beyond who it was.
  const add = useMutation({
    mutationFn: (profileId: string) => assignFlashRunner(projectId, profileId),
    onSuccess: (_data, profileId) => {
      refresh();
      const name = addable.find((c) => c.id === profileId)?.display_name ?? "Runner";
      showUndoToast({
        message: `${name} added to the flash run.`,
        undo: async () => {
          await unassignFlashRunner(projectId, profileId);
          refresh();
        },
      });
    },
    onError: (e) => setErr(formatApiError(e)),
  });
  const remove = useMutation({
    mutationFn: (profileId: string) => unassignFlashRunner(projectId, profileId),
    onSuccess: (_data, profileId) => {
      refresh();
      const name =
        (runners.data ?? []).find((r) => r.profile_id === profileId)?.profile
          ?.display_name ?? "Runner";
      showUndoToast({
        message: `${name} taken off the flash run.`,
        undo: async () => {
          await assignFlashRunner(projectId, profileId);
          refresh();
        },
      });
    },
    onError: (e) => setErr(formatApiError(e)),
  });

  const total = (openings.data ?? []).filter((o) => o.needs_flashing === true).length;
  const flashed = new Set(
    (phases.data ?? [])
      .filter((p) => p.kind === "flashing" && p.status === "submitted")
      .map((p) => p.opening_id),
  );
  const done = (openings.data ?? []).filter(
    (o) => o.needs_flashing === true && flashed.has(o.id),
  ).length;
  const onRun = new Set((runners.data ?? []).map((r) => r.profile_id));
  const addable = crew.filter((c) => !onRun.has(c.id));
  if (total === 0) return null;

  return (
    <div className="detail-card" style={{ marginTop: 8 }}>
      <div className="row-between">
        <span className="field-label" style={{ margin: 0 }}>
          Flash run — flash ahead of the crew
        </span>
        <Link to={`/projects/${projectId}/flash-run`} className="button-like">
          Open the run
        </Link>
      </div>
      <p className="muted" style={{ margin: "4px 0 8px" }}>
        {done}/{total} flashed · {total - done} to go
      </p>
      <div className="row-gap" style={{ flexWrap: "wrap", alignItems: "center" }}>
        {(runners.data ?? []).map((r) => (
          <span key={r.id} className="button-like studio-mini" style={{ cursor: "default" }}>
            {r.profile?.display_name ?? "runner"}{" "}
            <button
              className="link"
              aria-label={`Take ${r.profile?.display_name ?? "runner"} off the flash run`}
              disabled={remove.isPending}
              onClick={() => remove.mutate(r.profile_id)}
            >
              ×
            </button>
          </span>
        ))}
        {(runners.data ?? []).length === 0 && (
          <span className="muted" style={{ fontSize: 12.5 }}>No runners yet.</span>
        )}
        {addable.length > 0 && (
          <select
            aria-label="Add a flash runner"
            value=""
            disabled={add.isPending}
            onChange={(e) => {
              if (e.target.value) add.mutate(e.target.value);
            }}
          >
            <option value="">+ Add runner…</option>
            {addable.map((c) => (
              <option key={c.id} value={c.id}>
                {c.display_name ?? c.id.slice(0, 8)}
              </option>
            ))}
          </select>
        )}
      </div>
      {err && <p className="error" style={{ marginTop: 6 }}>{err}</p>}
    </div>
  );
}

/** Live summons at a glance: a foreman sees a heavy lift forming the
 * moment it's called (owner, 2026-08-14). */
function SummonStrip({
  projectId,
  openingCodeById,
}: {
  projectId: string;
  openingCodeById: Map<string, string>;
}) {
  const live = useQuery({
    queryKey: ["summons", projectId],
    queryFn: () => listLiveSummons(projectId),
    refetchInterval: 20_000,
  });
  if ((live.data ?? []).length === 0) return null;
  return (
    <div className="detail-card" style={{ marginTop: 8 }}>
      {(live.data ?? []).map((s) => (
        <p key={s.id} style={{ margin: "2px 0" }}>
          🔔 <strong>{openingCodeById.get(s.opening_id) ?? "unit"}</strong>{" "}
          <span className="muted">
            — {s.requester?.display_name ?? "installer"} needs {s.needed}
            {s.status === "covered" ? " · covered" : " · ringing"}
          </span>
        </p>
      ))}
    </div>
  );
}


/** Blocked units (derived from sessions — nothing stored) and open redos:
 * the foreman sees stuck work and comebacks the moment they happen. */
function SessionStrips({
  projectId,
  openingCodeById,
}: {
  projectId: string;
  openingCodeById: Map<string, string>;
}) {
  const sessions = useQuery({
    queryKey: ["unitSessions", projectId],
    queryFn: () => listProjectSessions(projectId),
    refetchInterval: 30_000,
  });
  const redos = useQuery({
    queryKey: ["openRedos", projectId],
    queryFn: () => listOpenRedos(projectId),
    refetchInterval: 30_000,
  });
  const blocked = blockedUnits(sessions.data ?? []);
  if (blocked.length === 0 && (redos.data ?? []).length === 0) return null;
  return (
    <div className="detail-card" style={{ marginTop: 8 }}>
      {blocked.map((b) => (
        <p key={b.openingId} style={{ margin: "2px 0" }}>
          <Ban
            size={15}
            aria-hidden
            style={{ verticalAlign: "middle", marginRight: 4 }}
          />
          <strong>{openingCodeById.get(b.openingId) ?? "unit"}</strong>{" "}
          <InstallChip state="blocked">blocked</InstallChip>{" "}
          <span className="muted">— {b.reason ?? "no reason recorded"}</span>
        </p>
      ))}
      {(redos.data ?? []).map((r) => (
        <p key={r.id} style={{ margin: "2px 0" }}>
          <RotateCcw
            size={15}
            aria-hidden
            style={{ verticalAlign: "middle", marginRight: 4 }}
          />
          <strong>{openingCodeById.get(r.opening_id) ?? "unit"}</strong>{" "}
          <InstallChip state="redo">redo</InstallChip>{" "}
          <span className="muted">
            — {r.presser?.display_name ?? "installer"}: {r.reason}
          </span>
        </p>
      ))}
    </div>
  );
}
