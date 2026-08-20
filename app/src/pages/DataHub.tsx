// The DATA TAB (grilled 2026-08-17, supervisor+ only): the company's
// ledger of where time goes. Four panels in the settled order — lost
// time first (actionable tomorrow), true cost second, estimating health
// third, data quality underneath everything. Every number is derived
// from stored atoms and keeps its provenance; the crew view is
// aggregate-first with per-person behind a deliberate tap. Visual kit
// (stat tiles, bars, ring gauge) lives in index.css on the Horizon
// tokens — semantic color only: amber = lost, green = done/on-tool.

import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { listProjects } from "../lib/api";
import { Explain } from "../components/ui/Explain";
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
  blockedNow,
  estimateVsActual,
  legacyLabor,
  listProjectInstallMinutes,
  onTool,
  reworkTotals,
  stallsByReason,
  topUnitsByLabor,
  weeklyTrend,
} from "../lib/data/insights";
import { estimateJobUnits } from "../lib/estimate/cohorts";
import { useCohortEvidence } from "../lib/estimate/liveEstimate";
import type { ProjectOpening } from "../lib/install/types";
import type { ProjectMarkSpec } from "../lib/install/specs";
import type { SignatureV1 } from "../lib/estimate/signature";
import type { LadderRung } from "../lib/estimate/cohorts";

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
  /** Old-era hand-recorded install minutes (windows sessions don't cover). */
  legacyEvents: { opening_id: string; minutes: number }[];
  legacyMin: number;
  legacyUnits: number;
}

function Bar({
  pct,
  tone,
}: {
  pct: number;
  tone?: "warn" | "ok" | "info";
}) {
  return (
    <div className={`databar${tone ? ` bar-${tone}` : ""}`}>
      <span style={{ width: `${Math.max(0, Math.min(100, pct))}%` }} />
    </div>
  );
}

/** Ladder rungs in plain words — how close the look-alikes are. Keyed on
 * LadderRung (not string) so a new rung fails the TS build instead of
 * rendering as a raw chip like "none 8". */
const RUNG_LABELS: Record<LadderRung, string> = {
  formula: "panel formula",
  exact: "exact look-alikes",
  "kind+panels": "same type & panel count",
  kind: "same type",
  global: "all units",
  none: "no estimate yet",
  manual: "manual estimate",
};

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
          const [openings, sessions, redos, phases, specs, oldMinutes] =
            await Promise.all([
              listOpenings(p.id),
              listProjectSessions(p.id),
              listOpenRedos(p.id),
              listOpeningPhases(p.id),
              listMarkSpecs(p.id),
              listProjectInstallMinutes(p.id),
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
          // Windows installed before automatic timing keep their old
          // hand-recorded minutes — counted once, automatic timing wins
          // per window, and the panel says how many came in this way.
          const legacy = legacyLabor(oldMinutes, sessions);
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
            laborMin: sessMin + flashMin + legacy.minutes,
            legacyEvents: oldMinutes,
            legacyMin: legacy.minutes,
            legacyUnits: legacy.units,
          };
        }),
      ),
  });

  const { evidence, sessions: sessionsEv, legacy: legacyEv } = useCohortEvidence();

  const all = bundles.data ?? [];
  const allSessions = useMemo(() => all.flatMap((b) => b.sessions), [all]);
  const stalls = useMemo(() => stallsByReason(allSessions), [allSessions]);
  const stalledTotal = stalls.reduce((t, s) => t + s.stalledMin, 0);
  const maxStall = stalls[0]?.stalledMin ?? 0;
  const rework = useMemo(() => reworkTotals(allSessions), [allSessions]);
  const deadSessions = autoClosedCount(allSessions);
  const openRedos = all.reduce((t, b) => t + b.redos.length, 0);
  const flashingOwed = all.reduce((t, b) => t + b.flashingOwed, 0);
  const laborTotal = all.reduce((t, b) => t + b.laborMin, 0);
  const installedTotal = all.reduce(
    (t, b) => t + b.openings.filter((o) => o.status === "installed").length,
    0,
  );
  const unitsTotal = all.reduce((t, b) => t + b.openings.length, 0);

  // The five costliest windows across scope — each links to its sheet,
  // where the Record answers "why so much?" with photos and a timeline.
  const openingIndex = useMemo(() => {
    const m = new Map<string, { code: string; projectId: string }>();
    for (const b of all)
      for (const o of b.openings)
        m.set(o.id, { code: o.opening_code, projectId: b.projectId });
    return m;
  }, [all]);
  const allLegacyEvents = useMemo(() => all.flatMap((b) => b.legacyEvents), [all]);
  const legacyUnitsTotal = all.reduce((t, b) => t + b.legacyUnits, 0);
  const costliest = useMemo(
    () => topUnitsByLabor(allSessions, 5, Date.now(), allLegacyEvents),
    [allSessions, allLegacyEvents],
  );
  const maxUnitCost = costliest[0]?.minutes ?? 0;
  const stuck = useMemo(() => blockedNow(allSessions), [allSessions]);
  const trend = useMemo(() => weeklyTrend(allSessions, 6), [allSessions]);
  const trendMax = Math.max(1, ...trend.map((w) => Math.max(w.laborMin, w.lostMin)));
  const trendHasData = trend.some((w) => w.laborMin > 0 || w.lostMin > 0);

  const estimating = useMemo(() => {
    let signed = 0;
    let unsigned = 0;
    // Typed on LadderRung (not string) so it lines up with RUNG_LABELS below.
    const rungs = new Map<LadderRung, number>();
    // Actual recorded minutes per unit (automatic timing only).
    const actualBy = new Map<string, number>();
    for (const ev of sessionsEv) {
      if (ev.unitId) actualBy.set(ev.unitId, ev.minutes);
    }
    const pairs: { estimateMin: number; actualMin: number }[] = [];
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
        const actual = actualBy.get(r.openingId);
        if (r.installed && r.estimate?.minutes != null && actual) {
          pairs.push({ estimateMin: r.estimate.minutes, actualMin: actual });
        }
      }
    }
    return {
      signed,
      unsigned,
      rungs: [...rungs.entries()],
      accuracy: estimateVsActual(pairs),
      finishedPairs: pairs.length,
    };
  }, [all, evidence, sessionsEv]);
  const signedPct =
    estimating.signed + estimating.unsigned > 0
      ? (estimating.signed / (estimating.signed + estimating.unsigned)) * 100
      : 0;

  const crew = useMemo(
    () => onTool(allSessions, shifts.data ?? []),
    [allSessions, shifts.data],
  );
  const crewPct = crew.total.pct != null ? Math.round(crew.total.pct * 100) : null;
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

      {/* ---- The morning glance: four numbers before any reading ---- */}
      <div className="data-stats">
        <div className={`stat-tile${stalledTotal > 0 ? " stat-warn" : ""}`}>
          <span className="stat-value">{fmtH(stalledTotal)}</span>
          <span className="stat-label">Time lost waiting</span>
        </div>
        <div className="stat-tile stat-accent">
          <span className="stat-value">{fmtH(laborTotal)}</span>
          <span className="stat-label">Work time recorded</span>
        </div>
        <div className="stat-tile stat-ok">
          <span className="stat-value">
            {installedTotal}
            <span style={{ fontSize: 15, fontWeight: 600, color: "var(--faint)" }}>
              /{unitsTotal}
            </span>
          </span>
          <span className="stat-label">Units installed</span>
        </div>
        <div className="stat-tile">
          <span className="stat-value">{crewPct != null ? `${crewPct}%` : "—"}</span>
          <span className="stat-label">Time on units · 30d</span>
        </div>
      </div>

      {/* ---- TREND · six Monday weeks, same calendar as payroll ---- */}
      {trendHasData && (
        <div className="detail-card">
          <p className="data-section-kicker">Trend</p>
          <h2 style={{ margin: "0 0 6px" }}>The last six weeks</h2>
          <Explain>
            Each week (Monday to Sunday, same as payroll) shows two bars: work
            time recorded on units, and time lost to blocks that week. You
            want the top bar growing and the amber bar shrinking — direction
            matters more than any single week's number.
          </Explain>
          {trend.map((w) => (
            <div key={w.weekStart} style={{ padding: "3px 0" }}>
              <div className="databar-row" style={{ padding: "1px 0" }}>
                <span className="bar-name muted" style={{ fontSize: 12, width: 64 }}>
                  {new Date(`${w.weekStart}T00:00:00Z`).toLocaleDateString(undefined, {
                    month: "short",
                    day: "numeric",
                    timeZone: "UTC",
                  })}
                </span>
                <Bar pct={(w.laborMin / trendMax) * 100} />
                <span className="bar-num">{fmtH(w.laborMin)}</span>
              </div>
              <div className="databar-row" style={{ padding: "1px 0" }}>
                <span className="bar-name" style={{ width: 64 }} />
                <Bar pct={(w.lostMin / trendMax) * 100} tone="warn" />
                <span className="bar-num">
                  {w.lostMin > 0 ? `${fmtH(w.lostMin)} lost` : "—"}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ---- 1 · WHERE DID WE LOSE TIME? ---- */}
      <div className="detail-card">
        <p className="data-section-kicker">Lost time</p>
        <h2 style={{ margin: "0 0 6px" }}>Where did we lose time?</h2>
        <Explain>
          When something outside the installer's control stops a unit — wrong
          glass, missing hardware, opening not ready — they tap Block and pick
          the reason. This panel adds up all the hours units sat waiting
          after a Block, grouped by what caused the wait. The biggest bar is
          the biggest problem to go fix. This time never counts against the
          installer — it points at what stopped them.
        </Explain>
        {stuck.length > 0 && (
          <div style={{ marginBottom: 10 }}>
            <span className="field-label" style={{ color: "var(--warn)" }}>
              Blocked right now — go unstick these
            </span>
            {stuck.map((u) => {
              const info = openingIndex.get(u.openingId);
              return (
                <div className="databar-row" key={u.openingId} style={{ padding: "3px 0" }}>
                  <span className="bar-name">
                    {info ? (
                      <Link to={`/projects/${info.projectId}/opening/${u.openingId}`}>
                        {info.code}
                      </Link>
                    ) : (
                      u.openingId.slice(0, 8)
                    )}
                  </span>
                  <span className="bar-num" style={{ marginLeft: "auto" }}>
                    sitting {fmtH(u.sittingMin)} · {u.reason ?? "no reason recorded"}
                  </span>
                </div>
              );
            })}
          </div>
        )}
        {stalls.length > 0 ? (
          <div>
            {stalls.map((s) => (
              <div className="databar-row" key={s.reason}>
                <span className="bar-name">{s.reason}</span>
                <Bar pct={maxStall > 0 ? (s.stalledMin / maxStall) * 100 : 0} tone="warn" />
                <span className="bar-num">
                  {fmtH(s.stalledMin)} · {s.count} block{s.count === 1 ? "" : "s"}
                </span>
              </div>
            ))}
            <p className="muted" style={{ margin: "6px 0 0", fontSize: 12 }}>
              Every hour traces to a reason and an issue.
            </p>
          </div>
        ) : (
          <p className="muted" style={{ margin: 0, fontSize: 13 }}>
            No blocked time yet. When a unit gets blocked — missing hardware,
            wrong glass — the lost hours land here, by reason.
          </p>
        )}
        <div className="data-chips">
          <span className={`data-chip${rework.units > 0 ? " chip-hot" : ""}`}>
            Units redone <strong>{rework.units}</strong>
            {rework.units > 0 && <span>· {fmtH(rework.minutes)} spent fixing</span>}
          </span>
          <span className={`data-chip${openRedos > 0 ? " chip-hot" : ""}`}>
            Waiting on a redo <strong>{openRedos}</strong>
          </span>
          <span className={`data-chip${flashingOwed > 0 ? " chip-hot" : ""}`}>
            Still need flashing <strong>{flashingOwed}</strong>
          </span>
          <span className="data-chip">
            Timers left running (auto-stopped) <strong>{deadSessions}</strong>
          </span>
        </div>
      </div>

      {/* ---- 2 · WHAT DOES THE WORK TRULY COST? ---- */}
      <div className="detail-card">
        <p className="data-section-kicker">True cost</p>
        <h2 style={{ margin: "0 0 6px" }}>What does the work truly cost?</h2>
        <Explain>
          The app records every minute someone spends on a unit automatically
          — no one types time in. Each job's line shows: how many of its
          units are in (the green bar), total work time so far, and the
          average minutes per finished unit. "Work time" = install time +
          helper time + flashing time. The costliest-units list below shows
          which individual windows ate the most time — tap one to see its full
          story, minute by minute, with photos.
        </Explain>
        {all.map((b) => {
          const installedCount = b.openings.filter((o) => o.status === "installed").length;
          return (
            <div className="databar-row" key={b.projectId}>
              <span className="bar-name">
                <Link to={`/projects/${b.projectId}?tab=brain`}>
                  <strong>{b.jobCode}</strong>
                </Link>
              </span>
              <Bar
                pct={b.openings.length > 0 ? (installedCount / b.openings.length) * 100 : 0}
                tone="ok"
              />
              <span className="bar-num">
                {installedCount}/{b.openings.length} · {fmtH(b.laborMin)}
                {installedCount > 0
                  ? ` · ~${Math.round(b.laborMin / installedCount)}m/unit`
                  : ""}
              </span>
            </div>
          );
        })}
        {costliest.length > 0 && (
          <div style={{ marginTop: 10 }}>
            <span className="field-label">Costliest windows</span>
            {costliest.map((u) => {
              const info = openingIndex.get(u.openingId);
              return (
                <div className="databar-row" key={u.openingId}>
                  <span className="bar-name">
                    {info ? (
                      <Link to={`/projects/${info.projectId}/opening/${u.openingId}`}>
                        {info.code}
                      </Link>
                    ) : (
                      u.openingId.slice(0, 8)
                    )}
                  </span>
                  <Bar pct={maxUnitCost > 0 ? (u.minutes / maxUnitCost) * 100 : 0} />
                  <span className="bar-num">{fmtH(u.minutes)}</span>
                </div>
              );
            })}
            <p className="muted" style={{ margin: "4px 0 0", fontSize: 12 }}>
              Tap one — its Record shows the why, minute by minute.
            </p>
          </div>
        )}
        <p className="muted" style={{ margin: "8px 0 0", fontSize: 12 }}>
          Time spent redoing windows is counted in its own chip up top — never
          hidden inside these averages.
          {legacyUnitsTotal > 0 &&
            ` Includes ${legacyUnitsTotal} window${legacyUnitsTotal === 1 ? "" : "s"} timed the old hand-recorded way, before automatic timing shipped.`}
        </p>
      </div>

      {/* ---- 3 · CAN WE TRUST OUR ESTIMATES YET? ---- */}
      <div className="detail-card">
        <p className="data-section-kicker">Estimating health</p>
        <h2 style={{ margin: "0 0 6px" }}>Can we trust our estimates yet?</h2>
        <Explain>
          The app is learning how long each kind of window takes, so future
          bids come from real numbers instead of gut feel. A window is
          "signed" when the app knows its shape — how many panels, what slides,
          how many stories, corner or flat. Signed windows get grouped with
          look-alikes, and the recorded times of those look-alikes become the
          estimate. When there aren't enough exact look-alikes yet, the app
          widens the circle (same type, then all windows) and always says how
          wide it had to go. More signed windows + more recorded installs =
          estimates you can bid with.
        </Explain>
        <div className="databar-row">
          <span className="bar-name muted" style={{ fontSize: 12.5 }}>
            Shapes known
          </span>
          <Bar pct={signedPct} tone="info" />
          <span className="bar-num">
            {estimating.signed} known · {estimating.unsigned} not yet
          </span>
        </div>
        {estimating.unsigned > 0 && (
          <p className="muted" style={{ margin: "2px 0 0", fontSize: 12 }}>
            The app can't group a window it can't describe — confirm the specs
            on each job, then hit Re-read, and these sign themselves.
          </p>
        )}
        {estimating.rungs.length > 0 && (
          <div className="data-chips">
            {estimating.rungs.map(([rung, n]) => (
              <span className="data-chip" key={rung}>
                {RUNG_LABELS[rung] ?? rung} <strong>{n}</strong>
              </span>
            ))}
          </div>
        )}
        <p style={{ margin: "8px 0 0", fontSize: 13 }}>
          {estimating.accuracy ? (
            (() => {
              const pctOff = Math.round(
                Math.abs(estimating.accuracy.medianRatio - 1) * 100,
              );
              return (
                <>
                  Estimates are{" "}
                  <strong style={{ color: pctOff <= 10 ? "var(--ok)" : "var(--warn)" }}>
                    {pctOff === 0
                      ? "right on the money"
                      : `running ${pctOff}% ${
                          estimating.accuracy.medianRatio > 1 ? "low" : "high"
                        }`}
                  </strong>{" "}
                  <span className="muted">
                    {pctOff === 0
                      ? ""
                      : `(real installs took ${
                          estimating.accuracy.medianRatio > 1 ? "longer" : "less"
                        } than the guess) `}
                    — measured on {estimating.accuracy.n} finished windows.
                  </span>
                </>
              );
            })()
          ) : (
            <span className="muted">
              Estimate accuracy shows after 5 finished windows have both a
              number and a recorded time — {estimating.finishedPairs} so far.
            </span>
          )}
        </p>
        <p className="muted" style={{ margin: "8px 0 0", fontSize: 12 }}>
          Timing data: {sessionsEv.length} window(s) timed the new
          automatic way, {legacyEv.length} from the old hand-typed
          era. The old share fades out on its own as new installs happen.
        </p>
      </div>

      {/* ---- CREW · aggregate first, people behind a deliberate tap ---- */}
      <div className="detail-card">
        <p className="data-section-kicker">Crew</p>
        <h2 style={{ margin: "0 0 8px" }}>Time on windows — last 30 days</h2>
        <Explain>
          Of all the hours the crew was clocked in this month, how many were
          spent actually working on a window? (We call this "on-tool" time.)
          The rest is driving, loading, waiting, and meetings — real work, but
          not window work. If this number is low for everyone at once, the
          problem is the schedule or the warehouse, not the people. Breaks are
          already subtracted before the math.
        </Explain>
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <div
            className="ring-gauge"
            style={{ ["--pct" as string]: crewPct ?? 0 }}
            data-label={crewPct != null ? `${crewPct}%` : "—"}
          />
          <p className="muted" style={{ margin: 0, fontSize: 13 }}>
            {fmtH(crew.total.sessionMin)} of {fmtH(crew.total.shiftMin)} clocked
            time was spent on windows.
          </p>
        </div>
        <button
          className="link"
          style={{ fontSize: 12, marginTop: 8 }}
          onClick={() => setShowPeople((v) => !v)}
        >
          {showPeople ? "Hide people" : "Per person (supervisors only — never installers)"}
        </button>
        {showPeople && (
          <div style={{ marginTop: 4 }}>
            {crew.perPerson.map((p) => (
              <div className="databar-row" key={p.profileId}>
                <span className="bar-name" style={{ fontSize: 12.5 }}>
                  {nameOf(p.profileId)}
                </span>
                <Bar pct={p.pct != null ? p.pct * 100 : 0} tone="ok" />
                <span className="bar-num">
                  {p.pct != null
                    ? `${Math.round(p.pct * 100)}% · ${fmtH(p.sessionMin)} / ${fmtH(p.shiftMin)}`
                    : "no shifts"}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ---- 4 · DATA QUALITY — everything above is only this good ---- */}
      <div className="detail-card">
        <p className="data-section-kicker">Data quality</p>
        <h2 style={{ margin: "0 0 6px" }}>How much can we trust the numbers?</h2>
        <Explain>
          Every panel above is only as good as what got recorded. "Specs
          confirmed" = a person double-checked the window details the AI read
          off the plans. "Shapes known" = the app can describe that window
          well enough to group it with look-alikes. When these bars are low,
          the numbers above are working with incomplete information — filling
          these in is how the whole page gets sharper.
        </Explain>
        {all.map((b) => {
          const signedCount = b.openings.filter((o) => o.sig_key).length;
          return (
            <div key={b.projectId} style={{ padding: "4px 0" }}>
              <strong style={{ fontSize: 13 }}>{b.jobCode}</strong>
              <div className="databar-row" style={{ padding: "3px 0" }}>
                <span className="bar-name muted" style={{ fontSize: 12 }}>
                  Specs confirmed
                </span>
                <Bar pct={b.specsConfirmedPct ?? 0} tone="info" />
                <span className="bar-num">
                  {b.specsConfirmedPct != null ? `${b.specsConfirmedPct}%` : "no specs"}
                </span>
              </div>
              <div className="databar-row" style={{ padding: "3px 0" }}>
                <span className="bar-name muted" style={{ fontSize: 12 }}>
                  Shapes known
                </span>
                <Bar
                  pct={b.openings.length > 0 ? (signedCount / b.openings.length) * 100 : 0}
                  tone="info"
                />
                <span className="bar-num">
                  {signedCount}/{b.openings.length}
                </span>
              </div>
            </div>
          );
        })}
        {crew.overShiftCount > 0 && (
          <div style={{ padding: "4px 0" }}>
            <strong style={{ fontSize: 13 }}>Session time exceeds clocked time</strong>
            <p className="muted" style={{ margin: "2px 0 0", fontSize: 12 }}>
              {crew.overShiftCount} {crew.overShiftCount === 1 ? "person" : "people"} logged
              more on-tool minutes than their clocked shift covers this month —{" "}
              {fmtH(crew.overShiftMin)} more than their shifts can explain. That usually
              means overlapping sessions, a shift edited after the fact, or clock drift.
              Worth a check before trusting the on-tool numbers above.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
