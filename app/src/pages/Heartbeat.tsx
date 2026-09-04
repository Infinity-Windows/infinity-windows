import { BackChip } from "../components/BackChip";
import { RoleMaps } from "../components/RoleMaps";
import { ClockInBlock } from "../components/clock/ClockInBlock";
import { LogTodayChip } from "../components/dailyLogs/LogTodayChip";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { SkeletonList } from "../components/ui/States";
import { isOwner, isSupervisorPlus } from "../lib/install/types";
import { useEffectiveRole } from "../lib/useEffectiveRole";
import {
  getHeartbeat,
  isAnomaly,
  liveCrewHref,
  setProjectGreenLight,
  type HeartbeatTask,
} from "../lib/heartbeat";
import { weeklyLogCoverage } from "../lib/dailyLogs";
import { coverageLine } from "../lib/dailyLogCoverage";
import { formatApiError } from "../lib/errors";
import { describeDuration } from "../lib/shiftGuard";
import { useRealtimeAllOpenings } from "../lib/useRealtimeOpenings";
import { useT } from "../lib/i18n";
import {
  expiringSoon,
  listCertifications,
  todayLocalDay,
} from "../lib/credentials";
import { isForemanPlus } from "../lib/install/types";

/** "32 min" / "45s" for a duration in seconds. */
function fmtDur(sec: number): string {
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${h}h ${String(m).padStart(2, "0")}m`;
}

/** Minutes-only label for expected duration ("expected 10"). */
function fmtMin(sec: number): string {
  return `${Math.round(sec / 60)}`;
}

/**
 * How many people are genuinely on a window. A stamp nobody ever finished is
 * not somebody on task, so counting it here would put crew on a job card who
 * went home days ago.
 */
function onTaskCount(project: { activeTasks: HeartbeatTask[] }): number {
  return project.activeTasks.filter((t) => !t.stale).length;
}

interface LiveTask extends HeartbeatTask {
  liveElapsedSec: number;
  liveAnomaly: boolean;
  projectName: string;
  jobCode: string;
}

export function Heartbeat() {
  const queryClient = useQueryClient();
  const t = useT();
  const { effectiveRole: role } = useEffectiveRole();
  const canWrite = isSupervisorPlus(role);
  // Wave O (O4): the same thirty-day window the 7 AM push uses, so the tile and
  // the notification are never counting different cards. Foreman+ because that
  // is who certifications' policy lets read everybody's rows; degrades to empty
  // — and therefore to no tile at all — ahead of the migration.
  const canSeeCredentials = isForemanPlus(role);
  const certs = useQuery({
    queryKey: ["certifications"],
    queryFn: () => listCertifications(),
    enabled: canSeeCredentials,
  });
  const expiring = expiringSoon(certs.data ?? [], todayLocalDay());

  const hb = useQuery({ queryKey: ["heartbeat"], queryFn: getHeartbeat });
  useRealtimeAllOpenings(true);

  // Owners only (L5 spec) — the trust number wave S's later reviewer gate
  // will read at a 70% bar; foremen and supervisors don't see it here.
  const canSeeCoverage = isOwner(role);
  const weeklyCoverage = useQuery({
    queryKey: ["weeklyLogCoverage"],
    queryFn: weeklyLogCoverage,
    enabled: canSeeCoverage,
  });

  // Tick once a second so elapsed timers count up live.
  const [tick, setTick] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setTick(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const greenLight = useMutation({
    mutationFn: ({ projectId, on }: { projectId: string; on: boolean }) =>
      setProjectGreenLight(projectId, on),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["heartbeat"] }),
  });

  const baseMs = hb.data ? Date.parse(hb.data.generatedAt) : tick;
  const drift = Math.max(0, Math.floor((tick - baseMs) / 1000));

  // Flatten every in-progress task across jobs, recompute elapsed/anomaly live,
  // and sort anomalies (then longest-running) to the top.
  const liveTasks = useMemo<LiveTask[]>(() => {
    const out: LiveTask[] = [];
    for (const p of hb.data?.projects ?? []) {
      for (const t of p.activeTasks) {
        const liveElapsedSec = t.elapsedSec + drift;
        out.push({
          ...t,
          liveElapsedSec,
          liveAnomaly: !t.stale && isAnomaly(liveElapsedSec, t.medianSec),
          projectName: p.name,
          jobCode: p.jobCode,
        });
      }
    }
    return out.sort((a, b) => {
      if (a.stale !== b.stale) return a.stale ? -1 : 1;
      if (a.liveAnomaly !== b.liveAnomaly) return a.liveAnomaly ? -1 : 1;
      return b.liveElapsedSec - a.liveElapsedSec;
    });
  }, [hb.data, drift]);

  const anomalyCount = liveTasks.filter((t) => t.liveAnomaly).length;
  const staleCount = liveTasks.filter((t) => t.stale).length;
  const runningCount = liveTasks.length - staleCount;

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <p className="home-greeting">Live pulse</p>
          <h1>Heartbeat</h1>
        </div>
        <BackChip fallback="/projects" label="Back" />
      </header>

      <ClockInBlock />

      <LogTodayChip />

      <p className="muted">
        Every active job at a glance — who's on what right now, how long, jobs
        running long vs their median, % complete, open issues, and the green
        light. {runningCount} in progress
        {anomalyCount > 0 ? ` · ${anomalyCount} running long` : ""}
        {staleCount > 0 ? ` · ${staleCount} never finished` : ""}.
      </p>

      {canSeeCredentials && expiring.length > 0 && (
        <p className="muted cred-expiring-tile" style={{ fontWeight: 650 }}>
          {expiring.length === 1
            ? t("cred.expiring.one")
            : t("cred.expiring.many", { n: expiring.length })}
        </p>
      )}

      {canSeeCoverage && weeklyCoverage.data && (
        <p className="muted" style={{ fontWeight: 650 }}>
          {coverageLine(weeklyCoverage.data)}
        </p>
      )}

      {greenLight.isError && <p className="error">{formatApiError(greenLight.error)}</p>}
      {hb.isLoading && <SkeletonList rows={4} />}
      {hb.isError && <p className="error">{formatApiError(hb.error)}</p>}

      {/* Quick project pulse cards */}
      {!hb.isLoading && !hb.isError && (
        <div className="home-projects" style={{ marginTop: 8 }}>
          {(hb.data?.projects ?? []).map((p) => {
            const pctColor =
              p.pct >= 80 ? "var(--ok)" : p.pct >= 40 ? "var(--accent)" : "var(--warn)";
            return (
              <div key={p.id} className="project-card home-project">
                <div className="home-project-head">
                  <Link
                    to={`/projects/${p.id}?tab=dispatch`}
                    style={{ minWidth: 0, color: "inherit", textDecoration: "none" }}
                  >
                    <div style={{ fontWeight: 600, fontSize: 16 }}>
                      <span
                        aria-hidden
                        title={p.greenLight ? "Green light — cleared to run" : "No green light"}
                        style={{
                          display: "inline-block",
                          width: 10,
                          height: 10,
                          borderRadius: "50%",
                          marginRight: 8,
                          background: p.greenLight ? "var(--ok, #34d399)" : "var(--muted, #94a3b8)",
                          verticalAlign: "middle",
                        }}
                      />
                      {p.name}
                    </div>
                    <div className="muted" style={{ fontSize: 12 }}>
                      {p.jobCode}
                      {onTaskCount(p) > 0 ? ` · ${onTaskCount(p)} on task` : ""}
                    </div>
                  </Link>
                  <span
                    style={{
                      fontFamily: "var(--font-display)",
                      fontWeight: 700,
                      fontSize: 15,
                      color: p.total > 0 ? pctColor : "var(--muted)",
                      flex: "none",
                    }}
                  >
                    {p.total > 0 ? `${p.pct}%` : "—"}
                  </span>
                </div>

                {p.total > 0 && (
                  <div className="points-tier-bar" aria-hidden>
                    <div
                      className="points-tier-fill"
                      style={{ width: `${p.pct}%`, background: pctColor }}
                    />
                  </div>
                )}

                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 12,
                    marginTop: 8,
                    flexWrap: "wrap",
                  }}
                >
                  <Link
                    to="/issues"
                    className={p.openIssues > 0 ? "error" : "muted"}
                    style={{ fontSize: 13, textDecoration: "none" }}
                  >
                    {p.openIssues > 0
                      ? `${p.openIssues} open issue${p.openIssues === 1 ? "" : "s"}`
                      : "No open issues"}
                  </Link>

                  {canWrite && (
                    <button
                      className="link"
                      style={{ marginLeft: "auto" }}
                      disabled={greenLight.isPending}
                      onClick={() =>
                        greenLight.mutate({ projectId: p.id, on: !p.greenLight })
                      }
                    >
                      {p.greenLight ? "Turn off green light" : "Give green light"}
                    </button>
                  )}
                </div>

                {p.greenLight && p.greenLightNote && (
                  <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                    {p.greenLightNote}
                  </div>
                )}
              </div>
            );
          })}
          {(hb.data?.projects ?? []).length === 0 && (
            <p className="muted">No active projects right now.</p>
          )}
        </div>
      )}

      {/* Live crew — every in-progress task across jobs */}
      {!hb.isLoading && !hb.isError && (
        <section style={{ marginTop: 20 }}>
          <h2 style={{ fontSize: 16, marginBottom: 8 }}>Live crew</h2>
          <ul className="unit-list work-list">
            {liveTasks.map((t) => (
              // The li itself carries no card styling — .unit-list li's bare
              // background/border/padding are switched off inline so the
              // Link underneath (which owns find-row/dispatch-row) is the
              // only box, not a card nested inside a card.
              <li key={t.openingId} style={{ background: "none", border: "none", padding: 0 }}>
                <Link
                  to={liveCrewHref(t)}
                  className="find-row dispatch-row"
                  style={{ textDecoration: "none", color: "inherit" }}
                >
                  <div style={{ minWidth: 0 }}>
                    <div>
                      {t.stale && (
                        <strong
                          className="error"
                          style={{ marginRight: 6 }}
                          title="Started but never finished — needs a person"
                        >
                          ⚠ NEVER FINISHED
                        </strong>
                      )}
                      {t.liveAnomaly && (
                        <strong
                          className="error"
                          style={{ marginRight: 6 }}
                          title="Running long vs median"
                        >
                          ⚠ LONG
                        </strong>
                      )}
                      <strong>{t.installerName}</strong>{" "}
                      <span className="muted">
                        {t.jobCode} · {t.openingLabel}
                      </span>
                    </div>
                    <div
                      className={t.liveAnomaly || t.stale ? "error" : "muted"}
                      style={{ fontSize: 13 }}
                    >
                      {t.stale ? (
                        // Never a stopwatch on one of these. How long ago it was
                        // started is a fact; how long it took is not ours to say.
                        <>
                          Started {describeDuration(t.liveElapsedSec)} ago and never
                          finished — ask whoever was on it
                        </>
                      ) : (
                        <>
                          {fmtDur(t.liveElapsedSec)}
                          {t.medianSec != null
                            ? ` · expected ${fmtMin(t.medianSec)} min`
                            : ""}
                        </>
                      )}
                    </div>
                  </div>
                  <span className="muted" aria-hidden style={{ marginLeft: "auto", flex: "none" }}>
                    Open →
                  </span>
                </Link>
              </li>
            ))}
            {liveTasks.length === 0 && (
              <p className="muted">Nobody's mid-install right now.</p>
            )}
          </ul>
        </section>
      )}

      <RoleMaps />
    </div>
  );
}
