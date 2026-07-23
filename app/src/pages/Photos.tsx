import { useMemo } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { listProjects } from "../lib/api";
import { PhotoFeed } from "../components/photos/PhotoFeed";

export function Photos() {
  const [params, setParams] = useSearchParams();
  const projectId = params.get("project");
  const kind = params.get("kind") === "receipt" ? "receipt" : "photo";
  const initialCapture = params.get("capture") === "1";

  const projects = useQuery({ queryKey: ["projects"], queryFn: listProjects });

  const jobCodeById = useMemo(() => {
    const map = new Map<string, string>();
    for (const p of projects.data ?? []) map.set(p.id, p.job_code);
    return map;
  }, [projects.data]);

  const selectedJobCode = projectId ? jobCodeById.get(projectId) ?? null : null;

  const setProject = (id: string) => {
    const next = new URLSearchParams(params);
    if (id) next.set("project", id);
    else next.delete("project");
    next.delete("capture");
    setParams(next, { replace: true });
  };

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <p className="home-greeting">Photos</p>
          <h1>{selectedJobCode ? selectedJobCode : "Recent across all jobs"}</h1>
        </div>
        <Link to="/" className="back-chip" aria-label="Home">
          ‹
        </Link>
      </header>

      <PhotoFeed
        projectId={projectId}
        selectedJobCode={selectedJobCode}
        kind={kind}
        initialCapture={initialCapture}
        toolbarExtra={
          <select
            className="photos-filter"
            value={projectId ?? ""}
            onChange={(e) => setProject(e.target.value)}
            aria-label="Filter by job"
          >
            <option value="">All jobs</option>
            {(projects.data ?? []).map((p) => (
              <option key={p.id} value={p.id}>
                {p.job_code} — {p.name}
              </option>
            ))}
          </select>
        }
      />
    </div>
  );
}
