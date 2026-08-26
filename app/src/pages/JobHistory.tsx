// The job history list (owner ask, 2026-08-26): "completing takes them off
// my screen — we can create a job history list." Finished and cancelled
// jobs land here with WHEN, keep every scrap of their information (the job
// page stays fully readable), and can be reopened by a supervisor if the
// site calls back. Owner-only Delete exists for empty shells; the server
// refuses anything carrying material, plans, or hours.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router-dom";
import { BackChip } from "../components/BackChip";
import { EmptyState } from "../components/ui/States";
import { deleteProject, listProjectsAnyStatus, setProjectStatus } from "../lib/api";
import { formatApiError } from "../lib/errors";
import { isOwner, isSupervisorPlus } from "../lib/install/types";
import { useEffectiveRole } from "../lib/useEffectiveRole";

const STATUS_WORDS: Record<string, string> = {
  completed: "Finished",
  cancelled: "Cancelled",
};

export function JobHistory() {
  const qc = useQueryClient();
  const { effectiveRole } = useEffectiveRole();
  const boss = isSupervisorPlus(effectiveRole);
  const owner = isOwner(effectiveRole);
  const [message, setMessage] = useState<string | null>(null);

  const projects = useQuery({
    queryKey: ["projectsAll"],
    queryFn: listProjectsAnyStatus,
  });
  const done = (projects.data ?? []).filter((p) => p.status !== "active");

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["projectsAll"] });
    void qc.invalidateQueries({ queryKey: ["projects"] });
  };

  const reopen = useMutation({
    mutationFn: (id: string) => setProjectStatus(id, "active"),
    onSuccess: () => {
      setMessage("Reopened — it is back on every active list.");
      refresh();
    },
    onError: (e) => setMessage(formatApiError(e)),
  });

  const remove = useMutation({
    mutationFn: (id: string) => deleteProject(id),
    onSuccess: () => {
      setMessage("Deleted.");
      refresh();
    },
    onError: (e) => setMessage(formatApiError(e)),
  });

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <p className="home-greeting">Jobs</p>
          <h1>Job history</h1>
        </div>
        <BackChip fallback="/projects" label="Jobs" />
      </header>
      <p className="muted">
        Finished and cancelled jobs. Everything they ever tracked is still
        here — open one to read it, or reopen it if the site calls back.
      </p>
      {message && <p className="scanner-hint">{message}</p>}
      <ul className="unit-list">
        {done.map((p) => (
          <li key={p.id} className="opening-review-row">
            <div className="wh-row">
              <div className="wh-row-main">
                <Link to={`/projects/${p.id}`} className="link wh-row-title">
                  {p.job_code}
                </Link>
                <div className="wh-row-sub">
                  {p.name}
                  {" · "}
                  {STATUS_WORDS[p.status] ?? p.status}
                  {p.status_changed_at
                    ? ` ${new Date(p.status_changed_at).toLocaleDateString([], {
                        month: "short",
                        day: "numeric",
                        year: "numeric",
                      })}`
                    : ""}
                </div>
              </div>
              {boss && (
                <button
                  className="button-like"
                  disabled={reopen.isPending}
                  onClick={() => reopen.mutate(p.id)}
                >
                  Reopen
                </button>
              )}
              {owner && (
                <button
                  className="link"
                  style={{ color: "var(--danger)" }}
                  disabled={remove.isPending}
                  onClick={() => {
                    if (
                      window.confirm(
                        `Delete ${p.job_code} for good? Only an empty job can go — anything with material, plans, or hours will refuse. This can't be undone.`,
                      )
                    ) {
                      remove.mutate(p.id);
                    }
                  }}
                >
                  delete
                </button>
              )}
            </div>
          </li>
        ))}
      </ul>
      {done.length === 0 && (
        <EmptyState
          title="No finished jobs yet."
          message="When a supervisor completes a job from its page, it moves here with everything it ever tracked."
        />
      )}
    </div>
  );
}
