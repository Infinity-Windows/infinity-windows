import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { listProjects } from "../lib/api";
import { supabase } from "../lib/supabase";

interface OpeningCountRow {
  project_id: string;
  status: "planned" | "assigned" | "installed";
}

export function Projects() {
  const projects = useQuery({ queryKey: ["projects"], queryFn: listProjects });
  const counts = useQuery({
    queryKey: ["openingCounts"],
    queryFn: async (): Promise<OpeningCountRow[]> => {
      const { data, error } = await supabase
        .from("project_openings")
        .select("project_id, status");
      if (error) throw error;
      return data;
    },
  });

  const countFor = (projectId: string) => {
    const rows = (counts.data ?? []).filter((r) => r.project_id === projectId);
    const total = rows.length;
    const installed = rows.filter((r) => r.status === "installed").length;
    const pct = total > 0 ? Math.round((installed / total) * 100) : 0;
    return { total, installed, pct };
  };

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <p className="home-greeting">Jobs</p>
          <h1>Active projects</h1>
        </div>
        <Link to="/" className="back-chip" aria-label="Home">
          ‹
        </Link>
      </header>
      <p className="muted">
        One hub per job — warehouse pick list, opening map, and type brain.
      </p>
      <div className="home-projects">
        {(projects.data ?? []).map((p) => {
          const c = countFor(p.id);
          const pctColor =
            c.pct >= 80 ? "var(--ok)" : c.pct >= 40 ? "var(--accent)" : "var(--warn)";
          return (
            <Link key={p.id} to={`/projects/${p.id}`} className="project-card home-project">
              <div className="home-project-head">
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: 600, fontSize: 16 }}>
                    {p.name || p.job_code}
                  </div>
                  <div className="muted" style={{ fontSize: 12 }}>
                    {p.job_code}
                    {p.address ? ` · ${p.address}` : ""}
                  </div>
                </div>
                <span
                  style={{
                    fontFamily: "var(--font-display)",
                    fontWeight: 700,
                    fontSize: 15,
                    color: c.total > 0 ? pctColor : "var(--muted)",
                    flex: "none",
                  }}
                >
                  {c.total > 0 ? `${c.pct}%` : "—"}
                </span>
              </div>
              {c.total > 0 && (
                <div className="points-tier-bar" aria-hidden>
                  <div
                    className="points-tier-fill"
                    style={{ width: `${c.pct}%`, background: pctColor }}
                  />
                </div>
              )}
              <div className="home-project-meta">
                <span>
                  <i className="dot-info" /> {c.total} openings
                </span>
                <span>
                  <i className="dot-ok" /> {c.installed} done
                </span>
              </div>
            </Link>
          );
        })}
        {projects.data?.length === 0 && (
          <p className="muted">No active jobs.</p>
        )}
      </div>
    </div>
  );
}
