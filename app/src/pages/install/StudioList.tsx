// The Studio's front door: every model in the company — blank/linked
// standalone projects and job-attached models — in one list, newest work
// first. Start from nothing ("New project") or open a job's model.

import { useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { listProjects } from "../../lib/api";
import { formatApiError } from "../../lib/errors";
import { pushToast } from "../../lib/toast";
import { BackChip } from "../../components/BackChip";
import {
  buildWorkspaces,
  listJobModelRows,
  listStudioProjectRows,
  saveStudioProject,
} from "../../lib/modelstudio/projects";
import { ModelStudio } from "./ModelStudio";

export function StudioList() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const standalone = useQuery({
    queryKey: ["studioProjects"],
    queryFn: listStudioProjectRows,
  });
  const jobModels = useQuery({ queryKey: ["studioJobModels"], queryFn: listJobModelRows });
  const projects = useQuery({ queryKey: ["projects"], queryFn: listProjects });
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");

  const workspaces = useMemo(() => {
    const byId = new Map(
      (projects.data ?? []).map((p) => [p.id, { job_code: p.job_code, name: p.name }]),
    );
    return buildWorkspaces(standalone.data ?? [], jobModels.data ?? [], byId);
  }, [standalone.data, jobModels.data, projects.data]);

  const create = useMutation({
    mutationFn: () => saveStudioProject({ name: name.trim() || "Untitled model" }),
    onSuccess: (row) => {
      void qc.invalidateQueries({ queryKey: ["studioProjects"] });
      navigate(`/studio/p/${row.id}`);
    },
    onError: (e) => pushToast(formatApiError(e), "error"),
  });

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <BackChip />
          <p className="home-greeting">Design</p>
          <h1>Studio</h1>
        </div>
      </header>

      <div className="row-gap">
        <button className="button-like active-pill" onClick={() => setNaming(true)}>
          New project
        </button>
      </div>

      <h2>Models</h2>
      {standalone.isError && <p className="error">{formatApiError(standalone.error)}</p>}
      <div className="home-projects">
        {workspaces.map((w) => (
          <Link
            key={w.key}
            to={w.kind === "standalone" ? `/studio/p/${w.key}` : `/studio/j/${w.projectId}`}
            className="project-card home-project"
          >
            <div className="home-project-head">
              <div style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 600 }}>{w.name}</div>
                <div className="muted" style={{ fontSize: 12 }}>
                  {w.kind === "job" ? "Job model" : w.jobCode ? `Linked to ${w.jobCode}` : "Not linked"}
                  {w.savedAt
                    ? ` · saved ${new Date(w.savedAt).toLocaleDateString()}`
                    : ""}
                </div>
              </div>
              <span className="muted">›</span>
            </div>
          </Link>
        ))}
        {workspaces.length === 0 && !standalone.isLoading && (
          <p className="muted">
            Nothing yet — start a blank project, or open a job's Maps
            Interactive tab and trace a building.
          </p>
        )}
      </div>

      {naming && (
        <div className="modal-backdrop" role="dialog" aria-modal="true" onClick={() => setNaming(false)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <p style={{ margin: 0, fontWeight: 700 }}>New Studio project</p>
            <label className="field-label">Name</label>
            <input
              autoFocus
              placeholder="Spec house · 4-plex concept · …"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !create.isPending) create.mutate();
              }}
            />
            <div className="row-gap" style={{ marginTop: 10 }}>
              <button
                className="button-like active-pill"
                disabled={create.isPending}
                onClick={() => create.mutate()}
              >
                {create.isPending ? "Creating…" : "Create & open"}
              </button>
              <button className="button-like" onClick={() => setNaming(false)}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** Route element: /studio/j/:projectId — a job-attached model. */
export function StudioJobRoute() {
  const { projectId = "" } = useParams();
  return <ModelStudio source={{ kind: "job", projectId }} />;
}

/** Route element: /studio/p/:id — a standalone Studio project. */
export function StudioProjectRoute() {
  const { id = "" } = useParams();
  return <ModelStudio source={{ kind: "standalone", id }} />;
}
