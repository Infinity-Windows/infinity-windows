import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { listProjects } from "../lib/api";

export function Projects() {
  const projects = useQuery({ queryKey: ["projects"], queryFn: listProjects });

  return (
    <div className="page">
      <header className="page-header">
        <h1>Jobs</h1>
      </header>
      <ul className="unit-list">
        {(projects.data ?? []).map((p) => (
          <li key={p.id}>
            <Link to={`/projects/${p.id}`} className="job-row">
              <strong>{p.job_code}</strong> — {p.name}
              {p.address && <span className="muted"> {p.address}</span>}
            </Link>
          </li>
        ))}
        {projects.data?.length === 0 && (
          <p className="muted">No active jobs.</p>
        )}
      </ul>
    </div>
  );
}
