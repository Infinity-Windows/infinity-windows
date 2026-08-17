// The DATA TAB (grilled 2026-08-17, supervisor+ only): the company's
// ledger of where time goes. Four panels in the settled order — lost
// time first (actionable tomorrow), true cost second, estimating health
// third, data quality underneath everything. Every number is derived
// from stored atoms and keeps its provenance; the crew view is
// aggregate-first with per-person behind a deliberate tap.

import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { listProjects } from "../lib/api";
import { listOpenings, listProfiles } from "../lib/install/api";
import { listOpeningPhases, flashingOutstanding } from "../lib/install/phases";
import {
  listOpenRedos,
  listProjectSessions,
  type UnitSession,
  type UnitRedo,
} from "../lib/install/sessions";
import { listMarkSpecs } from "../lib/install/api";
import { listTeamShifts } from "../lib/timeclock";
import {
  autoClosedCount,
  onTool,
  reworkTotals,
  stallsByReason,
} from "../lib/data/insights";
import {
  combineEvidence,
  estimateJobUnits,
  installEventsEvidence,
  sessionsEvidence,
} from "../lib/estimate/cohorts";
import type { ProjectOpening } from "../lib/install/types";
import type { ProjectMarkSpec } from "../lib/install/specs";
import type { SignatureV1 } from "../lib/estimate/signature";

const fmtH = (min: number) => `${Math.floor(min / 60)}h ${Math.round(min) % 60}m`;

interface JobBundle {
  projectId: string;
  jobCode: string;
  openings: ProjectOpening[];
  sessions: UnitSession[];
  redos: UnitRedo[];
  flashingOwed: number;
  specsConfirmedPct: number | null;
  laborMin: number;
}

export function DataHub() {
  const projects = useQuery({ queryKey: ["projects"], queryFn: listProjects });
  const profiles = useQuery({ queryKey: ["profiles"], queryFn: listProfiles });
  const [jobFilter, setJobFilter] = useState<string>("all");
  const [showPeople, setShowPeople] = useState(false);

  // 30 days of shifts for the on-tool window.
  const since = useMemo(
    () => new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString(),
    [],
  );
  const shifts = useQuery({
    queryKey: ["teamShifts30d", since],
    queryFn: () => listTeamShifts(since, new Date(Date.now() + 3600_000).toISOString()),
  });

  const scope = useMemo(
    () =>
      (projects.data ?? []).filter(
        (p) => jobFilter === "all" || p.id === jobFilter,
      ),
    [projects.data, jobFilter],
  );

  // One bundle per job in scope — a handful of jobs, fetched in parallel.
  const bundles = useQuery({
    queryKey: ["dataHubBundles", scope.map((p) => p.id).join(",")],
    enabled: scope.length > 0,
    queryFn: async (): Promise<JobBundle[]> =>
      Promise.all(
        scope.map(async (p) => {
          const [openings, sessions, redos, phases, specs] = await Promise.all([
            listOpenings(p.id),
            listProjectSessions(p.id),
            listOpenRedos(p.id),
            listOpeningPhases(p.id),
            listMarkSpecs(p.id),
          ]);
          const flashingOwed = openings.filter((o) =>
            flashingOutstanding(o, phases.filter((ph) => ph.opening_id === o.id)),
          ).length;
          const confirmed = (specs as ProjectMarkSpec[]).filter((s) => s.confirmed).length;
          const flashMin = phases
            .filter((ph) => ph.kind === "flashing" && ph.minutes != null)
            .reduce((t, ph) => t + (ph.minutes ?? 0), 0);
          const sessMin = sessions
            .filter((s) => s.ended_at)
            .reduce(
              (t, s) =>
                t +
                Math.max(
                  0,
                  Math.min(
                    480,
                    Math.floor(
                      (Date.parse(s.ended_at!) - Date.parse(s.started_at)) / 60000,
                    ),
                  ),
                ),
              0,
            );
          return {
            projectId: p.id,
            jobCode: p.job_code,
            openings,
            sessions,
            redos,
            flashingOwed,
            specsConfirmedPct: specs.length
              ? Math.round((confirmed / specs.length) * 100)
              : null,
            laborMin: sessMin + flashMin,
          };
        }),
      ),
  });

  const sessionsEv = useQuery({
    queryKey: ["cohortEvidence", "sessions"],
    queryFn: sessionsEvidence,
    staleTime: 60_000,
  });
  const legacyEv = useQuery({
    queryKey: ["cohortEvidence", "legacy"],
    queryFn: installEventsEvidence,
    staleTime: 60_000,
  });

  const all = bundles.data ?? [];
  const allSessions = useMemo(() => all.flatMap((b) => b.sessions), [all]);
  const stalls = useMemo(() => stallsByReason(allSessions), [allSessions]);
  const stalledTotal = stalls.reduce((t, s) => t + s.stalledMin, 0);
  const rework = useMemo(() => reworkTotals(allSessions), [allSessions]);
  const deadSessions = autoClosedCount(allSessions);
  const openRedos = all.reduce((t, b) => t + b.redos.length, 0);
  const flashingOwed = all.reduce((t, b) => t + b.flashingOwed, 0);

  const evidence = useMemo(
    () => combineEvidence(sessionsEv.data ?? [], legacyEv.data ?? []),
    [sessionsEv.data, legacyEv.data],
  );
  const estimating = useMemo(() => {
    let signed = 0;
    let unsigned = 0;
    const rungs = new Map<string, number>();
    for (const b of all) {
      const job = estimateJobUnits(
        b.openings.map((o) => ({
          id: o.id,
          opening_code: o.opening_code,
          status: o.status,
          sig_key: o.sig_key ?? null,
          signature: (o as { signature?: unknown }).signature as SignatureV1 | null,
        })),
        evidence,
      );
      unsigned += job.unsigned;
      for (const r of job.rows) {
        if (!r.described) continue;
        signed += 1;
        if (r.estimate) {
          rungs.set(r.estimate.rung, (rungs.get(r.estimate.rung) ?? 0) + 1);
        }
      }
    }
    return { signed, unsigned, rungs: [...rungs.entries()] };
  }, [all, evidence]);

  const crew = useMemo(
    () => onTool(allSessions, shifts.data ?? []),
    [allSessions, shifts.data],
  );
  const nameOf = (id: string) =>
    (profiles.data ?? []).find((p) => p.id === id)?.display_name ?? id.slice(0, 8);

  return (
    <div className="page">
      <header className="page-header">
        <h1>Data</h1>
        <select
          aria-label="Job filter"
          value={jobFilter}
          onChange={(e) => setJobFilter(e.target.value)}
        >
          <option value="all">All jobs</option>
          {(projects.data ?? []).map((p) => (
            <option key={p.id} value={p.id}>
              {p.job_code}
            </option>
          ))}
        </select>
      </header>

      {/* ---- 1 · WHERE DID WE LOSE TIME? ---- */}
      <div className="detail-card">
        <h2 style={{ marginTop: 0 }}>Where did we lose time?</h2>
        <p style={{ margin: 0, fontVariantNumeric: "tabular-nums" }}>
          <strong style={{ fontSize: 22 }}>{fmtH(stalledTotal)}</strong>{" "}
          <span className="muted">
            lost to blocks — every hour traces to a reason and an issue
          </span>
        </p>
        <ul className="unit-list" style={{ marginTop: 6 }}>
          {stalls.map((s) => (
            <li key={s.reason} style={{ fontVariantNumeric: "tabular-nums" }}>
              <strong>{fmtH(s.stalledMin)}</strong>{" "}
              <span className="muted">
                · {s.reason} · {s.count} block{s.count === 1 ? "" : "s"}
              </span>
            </li>
          ))}
          {stalls.length === 0 && (
            <li className="muted">No blocked time recorded yet.</li>
          )}
        </ul>
        <p className="muted" style={{ margin: "8px 0 0", fontSize: 12.5 }}>
          Rework: {rework.units} unit{rework.units === 1 ? "" : "s"} ·{" "}
          {fmtH(rework.minutes)} · Open redos: {openRedos} · Still owed flashing:{" "}
          {flashingOwed} · Dead sessions swept: {deadSessions}
        </p>
      </div>

      {/* ---- 2 · WHAT DOES A WINDOW TRULY COST? ---- */}
      <div className="detail-card" style={{ marginTop: 8 }}>
        <h2 style={{ marginTop: 0 }}>What does the work truly cost?</h2>
        <ul className="unit-list">
          {all.map((b) => {
            const installedCount = b.openings.filter((o) => o.status === "installed").length;
            return (
              <li key={b.projectId} style={{ fontVariantNumeric: "tabular-nums" }}>
                <Link to={`/projects/${b.projectId}?tab=brain`}>
                  <strong>{b.jobCode}</strong>
                </Link>{" "}
                <span className="muted">
                  · {fmtH(b.laborMin)} labor · {installedCount}/{b.openings.length} installed
                  {installedCount > 0
                    ? ` · ~${Math.round(b.laborMin / installedCount)}m per installed unit`
                    : ""}
                </span>
              </li>
            );
          })}
        </ul>
        <p className="muted" style={{ margin: "6px 0 0", fontSize: 12 }}>
          Labor = install + helper sessions + flashing; rework counted in its own
          line above, never hidden here.
        </p>
      </div>

      {/* ---- 3 · CAN WE TRUST OUR ESTIMATES YET? ---- */}
      <div className="detail-card" style={{ marginTop: 8 }}>
        <h2 style={{ marginTop: 0 }}>Can we trust our estimates yet?</h2>
        <p style={{ margin: 0, fontVariantNumeric: "tabular-nums" }}>
          {estimating.signed} unit{estimating.signed === 1 ? "" : "s"} signed ·{" "}
          {estimating.unsigned} unsigned
          {estimating.unsigned > 0 ? " (confirm specs, then Re-read)" : ""}
        </p>
        <ul className="unit-list" style={{ marginTop: 6 }}>
          {estimating.rungs.map(([rung, n]) => (
            <li key={rung} className="muted" style={{ fontSize: 13 }}>
              {n} resolving at <strong>{rung}</strong>
            </li>
          ))}
        </ul>
        <p className="muted" style={{ margin: "6px 0 0", fontSize: 12 }}>
          Evidence: {(sessionsEv.data ?? []).length} session-timed unit(s),{" "}
          {(legacyEv.data ?? []).length} legacy-timed. The legacy share decays to
          zero on its own.
        </p>
      </div>

      {/* ---- CREW · aggregate first, people behind a deliberate tap ---- */}
      <div className="detail-card" style={{ marginTop: 8 }}>
        <h2 style={{ marginTop: 0 }}>On-tool — last 30 days</h2>
        <p style={{ margin: 0, fontVariantNumeric: "tabular-nums" }}>
          <strong style={{ fontSize: 22 }}>
            {crew.total.pct != null ? `${Math.round(crew.total.pct * 100)}%` : "—"}
          </strong>{" "}
          <span className="muted">
            of worked shift time spent on units ({fmtH(crew.total.sessionMin)} of{" "}
            {fmtH(crew.total.shiftMin)}). Low across the board indicts the
            schedule or the warehouse — not the people.
          </span>
        </p>
        <button
          className="link"
          style={{ fontSize: 12, marginTop: 6 }}
          onClick={() => setShowPeople((v) => !v)}
        >
          {showPeople ? "Hide people" : "Per person (supervisors only — never installers)"}
        </button>
        {showPeople && (
          <ul className="unit-list" style={{ marginTop: 4 }}>
            {crew.perPerson.map((p) => (
              <li key={p.profileId} className="muted" style={{ fontSize: 13, fontVariantNumeric: "tabular-nums" }}>
                {nameOf(p.profileId)} — {p.pct != null ? `${Math.round(p.pct * 100)}%` : "no shifts"}{" "}
                ({fmtH(p.sessionMin)} / {fmtH(p.shiftMin)})
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* ---- 4 · DATA QUALITY — everything above is only this good ---- */}
      <div className="detail-card" style={{ marginTop: 8 }}>
        <h2 style={{ marginTop: 0 }}>Data quality</h2>
        <ul className="unit-list">
          {all.map((b) => (
            <li key={b.projectId} className="muted" style={{ fontSize: 13 }}>
              <strong>{b.jobCode}</strong> — specs confirmed:{" "}
              {b.specsConfirmedPct != null ? `${b.specsConfirmedPct}%` : "no specs"} ·
              unsigned units:{" "}
              {b.openings.filter((o) => !o.sig_key).length}/{b.openings.length}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
