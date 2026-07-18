import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { createProject, listProjects } from "../lib/api";
import { getMyProfile } from "../lib/install/api";
import { isForemanPlus } from "../lib/install/types";
import { supabase } from "../lib/supabase";

interface OpeningCountRow {
  project_id: string;
  status: "planned" | "assigned" | "installed";
}

export function Projects() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [jobCode, setJobCode] = useState("");
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  const projects = useQuery({ queryKey: ["projects"], queryFn: listProjects });
  const profile = useQuery({ queryKey: ["myProfile"], queryFn: getMyProfile });
  const canAdd = isForemanPlus(profile.data?.role);
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
  const addProject = useMutation({
    mutationFn: () => createProject({ jobCode, name, address }),
    onSuccess: async (project) => {
      await queryClient.invalidateQueries({ queryKey: ["projects"] });
      setAdding(false);
      setJobCode("");
      setName("");
      setAddress("");
      navigate(`/projects/${project.id}/upload`);
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
      {canAdd && (
        <div className="project-create">
          {!adding ? (
            <button type="button" className="action-btn primary" onClick={() => setAdding(true)}>
              + New project
            </button>
          ) : (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                addProject.mutate();
              }}
            >
              <div className="row-between">
                <h2>New project</h2>
                <button type="button" className="link" onClick={() => setAdding(false)}>
                  Cancel
                </button>
              </div>
              <div className="project-create-grid">
                <label>
                  <span className="field-label">Job code</span>
                  <input
                    value={jobCode}
                    onChange={(e) => setJobCode(e.target.value)}
                    placeholder="PECAN14"
                    autoCapitalize="characters"
                    required
                  />
                </label>
                <label>
                  <span className="field-label">Project name</span>
                  <input
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="Pecan Valley Town Homes — Building 14"
                    required
                  />
                </label>
                <label className="project-create-address">
                  <span className="field-label">Address</span>
                  <input
                    value={address}
                    onChange={(e) => setAddress(e.target.value)}
                    placeholder="Lots 173–183, Hurricane, UT 84737"
                  />
                </label>
              </div>
              {addProject.isError && <p className="error">{String(addProject.error)}</p>}
              <button
                type="submit"
                className="action-btn primary"
                disabled={addProject.isPending || !jobCode.trim() || !name.trim()}
              >
                {addProject.isPending ? "Creating…" : "Create project and add PDFs"}
              </button>
            </form>
          )}
        </div>
      )}
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
