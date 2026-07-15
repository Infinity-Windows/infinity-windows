import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { listProjects } from "../../lib/api";
import { supabase } from "../../lib/supabase";

interface OpeningCountRow {
  project_id: string;
  status: "planned" | "assigned" | "installed";
}

export function ProjectsInstall() {
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
    return {
      total: rows.length,
      installed: rows.filter((r) => r.status === "installed").length,
    };
  };

  return (
    <div className="page">
      <header className="page-header">
        <h1>Install</h1>
      </header>
      <p className="muted">
        Pick a job to upload plans, map openings, and capture installs.
      </p>
      <ul className="unit-list">
        {(projects.data ?? []).map((p) => {
          const c = countFor(p.id);
          return (
            <li key={p.id}>
              <Link to={`/install/${p.id}`} className="job-row">
                <strong>{p.job_code}</strong> — {p.name}
                <span className="muted">
                  {" "}
                  {c.total > 0
                    ? `${c.installed}/${c.total} installed`
                    : "no openings mapped yet"}
                </span>
              </Link>
            </li>
          );
        })}
        {projects.data?.length === 0 && <p className="muted">No active jobs.</p>}
      </ul>
    </div>
  );
}
