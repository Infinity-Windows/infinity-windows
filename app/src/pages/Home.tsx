import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Bell, MessagesSquare } from "lucide-react";
import { QueryError, SkeletonList } from "../components/ui/States";
import { listProjects } from "../lib/api";
import { orderMyWork, type DispatchOpening } from "../lib/dispatch";
import { openingReadiness } from "../lib/install/fit";
import { getMyProfile, listMyOpeningsAllJobs, listMemosToConfirm } from "../lib/install/api";
import { isOwner, ROLE_LABELS, type CrewRole, type ProjectOpening } from "../lib/install/types";
import { roleRank } from "../lib/nav";
import { effectiveRole, useViewAsRole } from "../lib/viewAsRoleContext";
import { TERMS } from "../lib/glossary";
import { listMyProgress } from "../lib/learn";
import { listLedger } from "../lib/points";
import { supabase } from "../lib/supabase";
import { getOpenShift, isOnTheClock, listShiftsToApprove } from "../lib/timeclock";
import { listInstalledForQc } from "../lib/ops";
import { getHeartbeat } from "../lib/heartbeat";
import { listAssignments } from "../lib/schedule/api";
import { ToolboxTalkNagBanner } from "../components/time/ToolboxTalkNagBanner";
import { useUnreadCounts } from "../lib/chat/useUnreadCounts";
import { totalUnread } from "../lib/chat/unread";

interface OpeningCountRow {
  project_id: string;
  status: "planned" | "assigned" | "installed";
}

function initialsFrom(name: string | null | undefined): string {
  if (!name?.trim()) return "∞";
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function hhmm(totalSec: number): string {
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = Math.floor(totalSec % 60);
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function termOfDay(): (typeof TERMS)[number] {
  if (TERMS.length === 0) {
    return { id: "x", term: "Flange", cat: "flashing", desc: "Learn a term today." };
  }
  const start = new Date(new Date().getFullYear(), 0, 0);
  const day = Math.floor((Date.now() - start.getTime()) / 86400000);
  return TERMS[day % TERMS.length];
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
    area: o.label?.trim() || `page ${o.page_number}`,
    ready: r.status === "ready",
    blocked: r.status === "blocked",
    assigned_to: o.assigned_to,
    sequence: o.sequence,
  };
}

export function Home() {
  const me = useQuery({ queryKey: ["myProfile"], queryFn: getMyProfile });
  const view = useViewAsRole();
  const role = effectiveRole(me.data?.role, view);
  const boss = isOwner(role);
  const manager = roleRank(role) >= 1;
  // Exactly foreman (not supervisor/owner): lead their Home with what's awaiting
  // them + today's crews instead of the installer-first content.
  const foreman = roleRank(role) === 1;
  const profileId = me.data?.id;

  const openShift = useQuery({
    queryKey: ["openShift", profileId],
    queryFn: () => getOpenShift(profileId!),
    enabled: Boolean(profileId),
  });
  const openings = useQuery({
    queryKey: ["myOpenings", profileId],
    queryFn: () => listMyOpeningsAllJobs(profileId!),
    enabled: Boolean(profileId),
  });
  const ledger = useQuery({
    queryKey: ["ledger", profileId],
    queryFn: () => listLedger(profileId!),
    enabled: Boolean(profileId),
  });
  const progress = useQuery({
    queryKey: ["learnProgress", profileId],
    queryFn: () => listMyProgress(profileId!),
    enabled: Boolean(profileId),
  });
  const memos = useQuery({
    queryKey: ["memosToConfirm", profileId],
    queryFn: () => listMemosToConfirm(profileId!),
    enabled: Boolean(profileId),
  });
  const projects = useQuery({ queryKey: ["projects"], queryFn: listProjects });
  const unread = useUnreadCounts();

  // Foreman-only "Awaiting you" + "Today's crews" sources. These reuse the exact
  // computations from Notifications (QC / timecards) and Heartbeat (open issues),
  // and share their query keys so the cache is warm across pages.
  const todayISO = useMemo(() => {
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }, []);
  const qcPending = useQuery({
    queryKey: ["qcInstalled"],
    queryFn: listInstalledForQc,
    enabled: foreman,
  });
  const shiftsToApprove = useQuery({
    queryKey: ["shiftsToApprove"],
    queryFn: listShiftsToApprove,
    enabled: foreman,
  });
  const heartbeat = useQuery({
    queryKey: ["heartbeat"],
    queryFn: getHeartbeat,
    enabled: foreman,
  });
  const todayCrews = useQuery({
    queryKey: ["homeTodayCrews", todayISO],
    queryFn: () => listAssignments(todayISO, todayISO),
    enabled: foreman,
  });
  const openingCounts = useQuery({
    queryKey: ["openingCounts"],
    queryFn: async (): Promise<OpeningCountRow[]> => {
      const { data, error } = await supabase
        .from("project_openings")
        .select("project_id, status");
      if (error) throw error;
      return data as OpeningCountRow[];
    },
  });

  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const today = new Date().toLocaleDateString(undefined, {
    weekday: "long",
    month: "short",
    day: "numeric",
  });
  const firstName = me.data?.display_name?.split(/\s+/)[0] ?? "crew";
  const tod = useMemo(() => termOfDay(), []);
  const mastered = (progress.data ?? []).filter((p) => p.box >= 3).length;
  const unreadCounts = unread.data ?? {};
  const notifCount = (memos.data ?? []).length + totalUnread(unreadCounts);

  const rows = ledger.data ?? [];
  const points = rows
    .filter((r) => r.status === "confirmed")
    .reduce((s, r) => s + r.points, 0);
  const pending = rows
    .filter((r) => r.status === "pending")
    .reduce((s, r) => s + r.points, 0);
  const installsYtd = rows.filter(
    (r) => r.status === "confirmed" && r.kind === "install",
  ).length;

  const active = (openings.data ?? []).filter((o) => o.status !== "installed");
  const activeOpening = active.find((o) => o.work_started_at);
  const activeElapsed = activeOpening?.work_started_at
    ? Math.max(
        0,
        Math.floor((now - new Date(activeOpening.work_started_at).getTime()) / 1000),
      )
    : 0;

  // Next ready window (excludes the one already in progress).
  const byId = new Map(active.map((o) => [o.id, o]));
  const ordered = orderMyWork(active.map(toDispatch))
    .map((d) => byId.get(d.id)!)
    .filter(Boolean);
  const nextWindow = ordered.find(
    (o) => o.id !== activeOpening?.id && openingReadiness(o).status === "ready",
  );

  const pendingQc = (qcPending.data ?? []).filter(
    (r) => !r.qc || r.qc.status !== "passed",
  );
  const timecards = shiftsToApprove.data ?? [];
  const openIssues = (heartbeat.data?.projects ?? []).reduce(
    (s, p) => s + p.openIssues,
    0,
  );
  const crews = (todayCrews.data ?? []).filter((a) => a.status === "published");

  const projectCards = (projects.data ?? []).slice(0, 6).map((p) => {
    const oc = (openingCounts.data ?? []).filter((r) => r.project_id === p.id);
    const total = oc.length;
    const installed = oc.filter((r) => r.status === "installed").length;
    const pct = total > 0 ? Math.round((installed / total) * 100) : 0;
    const pctColor =
      pct >= 80 ? "var(--ok)" : pct >= 40 ? "var(--accent)" : "var(--warn)";
    return {
      id: p.id,
      name: p.name || p.job_code,
      sub: `${p.job_code}${p.address ? ` · ${p.address}` : ""}`,
      pct,
      pctLabel: total > 0 ? `${pct}%` : "—",
      pctColor,
      winLabel: `${total} openings`,
      doneLabel: `${installed} done`,
      chatUnread: unreadCounts[p.id] ?? 0,
    };
  });

  return (
    <div className="page home-day">
      <header className="page-header">
        <div>
          <p className="home-greeting">{today}</p>
          <h1 style={{ fontSize: 30, lineHeight: 1.1 }}>Hey, {firstName}</h1>
          <p className="muted" style={{ margin: 0, fontSize: 13 }}>
            {me.data?.display_name ?? "Windows & Doors"}
            {role && role !== "installer" ? ` · ${ROLE_LABELS[role as CrewRole] ?? role}` : ""}
          </p>
        </div>
        <div className="home-header-actions">
          <Link to="/notifications" className="bell-chip" aria-label="Notifications">
            <Bell size={18} aria-hidden />
            {notifCount > 0 && <span className="bell-badge">{notifCount}</span>}
          </Link>
          <button
            type="button"
            className="avatar-chip"
            title="Sign out"
            onClick={() => supabase.auth.signOut()}
          >
            {initialsFrom(me.data?.display_name)}
          </button>
        </div>
      </header>

      <ToolboxTalkNagBanner profileId={profileId} clockedIn={isOnTheClock(openShift.data)} />

      {foreman ? (
        <>
          <div className="home-section-head">
            <h2 style={{ margin: 0 }}>Awaiting you</h2>
            <Link to="/notifications" className="muted home-seeall">
              All ›
            </Link>
          </div>
          {pendingQc.length === 0 && timecards.length === 0 && openIssues === 0 ? (
            <p className="muted">You're all caught up.</p>
          ) : (
            <div className="notif-list">
              {pendingQc.length > 0 && (
                <Link to="/qc" className="notif-row">
                  <i className="dot-warn" />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 600 }}>
                      {pendingQc.length} install{pendingQc.length > 1 ? "s" : ""} awaiting QC
                    </div>
                    <div className="muted" style={{ fontSize: 12.5 }}>
                      Sign off passes and callbacks
                    </div>
                  </div>
                  <span className="muted">›</span>
                </Link>
              )}
              {timecards.length > 0 && (
                <Link to="/timecard" className="notif-row">
                  <i className="dot-warn" />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 600 }}>
                      {timecards.length} timecard{timecards.length > 1 ? "s" : ""} to approve
                    </div>
                    <div className="muted" style={{ fontSize: 12.5 }}>
                      Review submitted shifts
                    </div>
                  </div>
                  <span className="muted">›</span>
                </Link>
              )}
              {openIssues > 0 && (
                <Link to="/issues" className="notif-row">
                  <i className="dot-warn" />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 600 }}>
                      {openIssues} open blocker{openIssues > 1 ? "s" : ""}
                    </div>
                    <div className="muted" style={{ fontSize: 12.5 }}>
                      Open issues on active jobs
                    </div>
                  </div>
                  <span className="muted">›</span>
                </Link>
              )}
            </div>
          )}

          <div className="home-section-head">
            <h2 style={{ margin: 0 }}>Today's crews</h2>
            <Link to="/scheduling" className="muted home-seeall">
              Schedule ›
            </Link>
          </div>
          {crews.length === 0 ? (
            <p className="muted">No crews scheduled today.</p>
          ) : (
            <div className="notif-list">
              {crews.map((a) => (
                <Link
                  key={a.id}
                  to={`/projects/${a.project_id}?tab=chat`}
                  className="notif-row"
                >
                  <i className="dot-info" />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 600 }}>
                      {a.project?.name ?? a.project?.job_code ?? "Job"}
                    </div>
                    <div className="muted" style={{ fontSize: 12.5 }}>
                      {a.members.length > 0
                        ? a.members.map((m) => m.display_name ?? "crew").join(", ")
                        : "No crew assigned"}
                    </div>
                  </div>
                  <span className="muted">›</span>
                </Link>
              ))}
            </div>
          )}

          <div className="home-section-head">
            <h2 style={{ margin: 0 }}>Active projects</h2>
            <Link to="/projects" className="muted home-seeall">
              All jobs ›
            </Link>
          </div>
          <HomeProjectsGrid
            cards={projectCards}
            isLoading={projects.isLoading}
            isError={projects.isError}
            error={projects.error}
            onRetry={() => void projects.refetch()}
          />
        </>
      ) : (
        <>
      {manager && (
        <>
          <div className="home-section-head">
            <h2 style={{ margin: 0 }}>Active projects</h2>
            <Link to="/projects" className="muted home-seeall">
              All jobs ›
            </Link>
          </div>
          <HomeProjectsGrid
            cards={projectCards}
            isLoading={projects.isLoading}
            isError={projects.isError}
            error={projects.error}
            onRetry={() => void projects.refetch()}
          />

          <div className="warehouse-grid">
            <Link to="/team" className="warehouse-tile">
              <strong>Team</strong>
              <span className="muted">Crew, timecards, quality</span>
            </Link>
            <Link to="/warehouse" className="warehouse-tile">
              <strong>Warehouse</strong>
              <span className="muted">Inventory & receiving</span>
            </Link>
            <Link to="/analytics" className="warehouse-tile">
              <strong>Analytics</strong>
              <span className="muted">Bids & estimate variance</span>
            </Link>
            {boss && (
              <Link to="/costing" className="warehouse-tile">
                <strong>Job costing</strong>
                <span className="muted">Margin, costs, change orders</span>
              </Link>
            )}
          </div>
        </>
      )}

      {!openShift.data && (
        <Link to="/clock" className="home-card">
          <div className="home-card-top">
            <span className="next-label">Today — where to go</span>
            <span className="muted" style={{ fontSize: 11 }}>Clock</span>
          </div>
          <strong style={{ fontSize: 15 }}>Clock in for your job</strong>
          <p className="muted" style={{ margin: 0, fontSize: 12.5, lineHeight: 1.5 }}>
            Pick a job and cost code — time flows into payroll and costing.
          </p>
          <span className="home-card-cta">Tap to clock in ›</span>
        </Link>
      )}

      {activeOpening && (
        <Link
          to={`/projects/${activeOpening.project_id}/opening/${activeOpening.id}`}
          className="home-active"
        >
          <div className="install-pulse" aria-hidden>
            {activeOpening.opening_code.replace(/\D/g, "").slice(-2) || "•"}
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <span className="next-label">Install in progress</span>
            <div style={{ fontWeight: 600, fontSize: 15 }}>
              {activeOpening.opening_code}
              {activeOpening.window_types?.type_code
                ? ` · ${activeOpening.window_types.type_code}`
                : ""}
            </div>
          </div>
          <span className="home-active-clock">{hhmm(activeElapsed)}</span>
        </Link>
      )}

      {!activeOpening && nextWindow && (
        <Link
          to={`/projects/${nextWindow.project_id}/opening/${nextWindow.id}`}
          className="home-card home-next"
        >
          <div className="home-card-top">
            <span className="next-label">Your next window</span>
            <span className="ok" style={{ fontSize: 11 }}>ready</span>
          </div>
          <strong style={{ fontSize: 16 }}>
            {nextWindow.opening_code}
            {nextWindow.window_types?.type_code ? ` · ${nextWindow.window_types.type_code}` : ""}
          </strong>
          <p className="muted" style={{ margin: 0, fontSize: 12.5 }}>
            {nextWindow.projects?.job_code ?? "Job"}
            {nextWindow.label ? ` · ${nextWindow.label}` : ""}
          </p>
          <span className="home-card-cta">Start install ›</span>
        </Link>
      )}

      <Link to="/learn" className="home-card">
        <div className="home-card-top">
          <span className="next-label">Term of the day</span>
          <span className="streak-pill" style={{ padding: "4px 8px" }}>
            {mastered}
          </span>
        </div>
        <strong className="home-term">{tod.term}</strong>
        <p className="muted" style={{ margin: 0, fontSize: 12.5, lineHeight: 1.5 }}>
          {tod.desc.length > 120 ? `${tod.desc.slice(0, 117)}…` : tod.desc}
        </p>
        <span className="home-card-cta">Do today's 5 ›</span>
      </Link>

      <div className="stat-grid">
        <Link to="/points" className="stat-card accent">
          <span className="stat-num">{points}</span>
          <span>My points · YTD</span>
          <span className="muted" style={{ fontSize: 12 }}>
            {pending > 0 ? `${pending} pending QC` : "all confirmed"}
          </span>
        </Link>
        <div className="stat-card">
          <span className="stat-num">{installsYtd}</span>
          <span>Installs · YTD</span>
          <span className="muted" style={{ fontSize: 12 }}>from points ledger</span>
        </div>
      </div>

      {!manager && (
        <>
          <div className="home-section-head">
            <h2 style={{ margin: 0 }}>Active projects</h2>
          </div>
          <HomeProjectsGrid
            cards={projectCards}
            isLoading={projects.isLoading}
            isError={projects.isError}
            error={projects.error}
            onRetry={() => void projects.refetch()}
          />
        </>
      )}
        </>
      )}
    </div>
  );
}

interface HomeProjectCard {
  id: string;
  name: string;
  sub: string;
  pct: number;
  pctLabel: string;
  pctColor: string;
  winLabel: string;
  doneLabel: string;
  chatUnread: number;
}

function HomeProjectsGrid({
  cards,
  isLoading,
  isError,
  error,
  onRetry,
}: {
  cards: HomeProjectCard[];
  isLoading: boolean;
  isError: boolean;
  error: unknown;
  onRetry: () => void;
}) {
  return (
    <div className="home-projects">
      {cards.map((p) => (
        <Link key={p.id} to={`/projects/${p.id}`} className="project-card home-project">
          <div className="home-project-head">
            <div style={{ minWidth: 0 }}>
              <div style={{ fontWeight: 600, fontSize: 16, display: "flex", alignItems: "center", gap: 6 }}>
                <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>
                  {p.name}
                </span>
                {p.chatUnread > 0 && (
                  <span className="chat-badge" title={`${p.chatUnread} unread message${p.chatUnread > 1 ? "s" : ""}`}>
                    <MessagesSquare size={11} aria-hidden />
                    {p.chatUnread}
                  </span>
                )}
              </div>
              <div className="muted" style={{ fontSize: 12 }}>{p.sub}</div>
            </div>
            <span
              style={{
                fontFamily: "var(--font-display)",
                fontWeight: 700,
                fontSize: 15,
                color: p.pctColor,
                flex: "none",
              }}
            >
              {p.pctLabel}
            </span>
          </div>
          <div className="points-tier-bar" aria-hidden>
            <div
              className="points-tier-fill"
              style={{ width: `${p.pct}%`, background: p.pctColor }}
            />
          </div>
          <div className="home-project-meta">
            <span>
              <i className="dot-info" /> {p.winLabel}
            </span>
            <span>
              <i className="dot-ok" /> {p.doneLabel}
            </span>
          </div>
        </Link>
      ))}
      {isLoading && <SkeletonList rows={3} />}
      {isError && (
        <QueryError error={error} onRetry={onRetry} label="Couldn't load jobs" />
      )}
      {!isLoading && !isError && cards.length === 0 && (
        <p className="muted">No active jobs yet.</p>
      )}
    </div>
  );
}
