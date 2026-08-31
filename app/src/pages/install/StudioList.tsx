// The Studio's front door: blank/linked standalone projects, plus EVERY
// active job (B1, wave V-B) — not just ones someone already seeded — each
// with a state chip (not started / seeded / published). Newest work first.
// Start from nothing ("New project") or open a job's model; a "not started"
// job lazy-seeds from its traced building the moment its editor mounts
// (ModelStudio.tsx), so listing it here creates nothing by itself.

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
  listJobModelStates,
  listStudioProjectRows,
  saveStudioProject,
  type JobModelState,
  type StudioWorkspace,
} from "../../lib/modelstudio/projects";
import { ModelStudio } from "./ModelStudio";

/** B1: plain words + a color for each derived model state. */
const STATE_LABEL: Record<JobModelState, string> = {
  not_started: "Not started",
  seeded: "Seeded",
  published: "Published",
};
const STATE_DOT: Record<JobModelState, string> = {
  not_started: "dot-warn",
  seeded: "dot-info",
  published: "dot-ok",
};

/** The non-state half of a workspace card's subtitle line. */
function workspaceMeta(w: StudioWorkspace): string {
  const parts: string[] = [];
  if (w.kind === "standalone") {
    parts.push(w.jobCode ? `Linked to ${w.jobCode}` : "Not linked");
  }
  if (w.savedAt) parts.push(`saved ${new Date(w.savedAt).toLocaleDateString()}`);
  return parts.join(" · ");
}

export function StudioList() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const standalone = useQuery({
    queryKey: ["studioProjects"],
    queryFn: listStudioProjectRows,
  });
  const jobModels = useQuery({ queryKey: ["studioJobModels"], queryFn: listJobModelRows });
  const jobModelStates = useQuery({
    queryKey: ["studioJobModelStates"],
    queryFn: listJobModelStates,
  });
  const projects = useQuery({ queryKey: ["projects"], queryFn: listProjects });
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");

  const workspaces = useMemo(
    () =>
      buildWorkspaces(
        standalone.data ?? [],
        jobModels.data ?? [],
        projects.data ?? [],
        jobModelStates.data ?? new Map(),
      ),
    [standalone.data, jobModels.data, projects.data, jobModelStates.data],
  );

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
                <div
                  className="muted"
                  style={{ fontSize: 12, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}
                >
                  {w.state && (
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                      <span className={STATE_DOT[w.state]} />
                      {STATE_LABEL[w.state]}
                    </span>
                  )}
                  {workspaceMeta(w)}
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
