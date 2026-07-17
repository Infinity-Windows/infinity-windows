import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { getDashboardCounts, listProjects } from "../lib/api";
import {
  getMyProfile,
  listMyOpeningsAllJobs,
} from "../lib/install/api";
import { isAdmin, isBigBoss, isLeadLike, ROLE_LABELS, type CrewRole } from "../lib/install/types";
import { TERMS } from "../lib/glossary";
import { listMyProgress } from "../lib/learn";
import { listLedger } from "../lib/points";
import { supabase } from "../lib/supabase";
import { getOpenShift } from "../lib/timeclock";

interface Tile {
  to: string;
  label: string;
  show: boolean;
}

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

export function Home() {
  const counts = useQuery({ queryKey: ["dashboard"], queryFn: getDashboardCounts });
  const me = useQuery({ queryKey: ["myProfile"], queryFn: getMyProfile });
  const role = me.data?.role;
  const lead = isLeadLike(role);
  const admin = isAdmin(role);
  const boss = isBigBoss(role);
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
  const projects = useQuery({ queryKey: ["projects"], queryFn: listProjects });
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

  const activeOpening = (openings.data ?? []).find(
    (o) => o.work_started_at && o.status !== "installed",
  );
  const activeElapsed = activeOpening?.work_started_at
    ? Math.max(
        0,
        Math.floor((now - new Date(activeOpening.work_started_at).getTime()) / 1000),
      )
    : 0;

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
    };
  });

  const moreTiles: Tile[] = [
    { to: "/my-work", label: "My work", show: true },
    { to: "/scan", label: "Scan", show: true },
    { to: "/receive", label: "Receive", show: true },
    { to: "/search", label: "Locate", show: true },
    { to: "/training", label: "Training", show: true },
    { to: "/safety", label: "Safety", show: true },
    { to: "/count", label: "Cycle count", show: lead },
    { to: "/labels", label: "Print labels", show: lead },
    { to: "/tools", label: "Tools", show: lead },
    { to: "/supplies", label: "Supplies", show: lead },
    { to: "/qc", label: "Quality", show: lead },
    { to: "/analytics", label: "Analytics", show: lead },
    { to: "/catalog", label: "Catalog", show: lead },
    { to: "/crew", label: "Crew", show: lead },
    { to: "/admin", label: "Admin", show: admin },
    { to: "/costing", label: "Costing", show: boss },
  ].filter((t) => t.show);

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
        <button
          type="button"
          className="avatar-chip"
          title="Sign out"
          onClick={() => supabase.auth.signOut()}
        >
          {initialsFrom(me.data?.display_name)}
        </button>
      </header>

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

      {lead && (
        <div className="stat-grid">
          <Link to="/search" className="stat-card">
            <span className="stat-num">{counts.data?.total ?? "-"}</span>
            <span>on hand</span>
          </Link>
          <Link to="/scan" className="stat-card warn">
            <span className="stat-num">{counts.data?.inbound ?? "-"}</span>
            <span>need putaway</span>
          </Link>
          <Link to="/projects" className="stat-card">
            <span className="stat-num">{counts.data?.staged ?? "-"}</span>
            <span>staged</span>
          </Link>
          <Link to="/search?status=damaged" className="stat-card danger">
            <span className="stat-num">{counts.data?.damaged ?? "-"}</span>
            <span>damaged</span>
          </Link>
        </div>
      )}

      <h2>Active projects</h2>
      <div className="home-projects">
        {projectCards.map((p) => (
          <Link key={p.id} to={`/projects/${p.id}`} className="project-card home-project">
            <div className="home-project-head">
              <div style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 600, fontSize: 16 }}>{p.name}</div>
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
        {projectCards.length === 0 && (
          <p className="muted">No active jobs yet.</p>
        )}
      </div>

      <details className="more-actions home-more">
        <summary className="muted">More tools</summary>
        <div className="tile-grid" style={{ marginTop: 10 }}>
          {moreTiles.map((t) => (
            <Link key={t.label} to={t.to} className="tile">
              {t.label}
            </Link>
          ))}
        </div>
      </details>
    </div>
  );
}
