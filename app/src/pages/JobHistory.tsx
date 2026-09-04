// The job history list (owner ask, 2026-08-26): "completing takes them off
// my screen — we can create a job history list." Finished and cancelled
// jobs land here with WHEN, keep every scrap of their information (the job
// page stays fully readable), and can be reopened by a supervisor if the
// site calls back.
//
// Wave Y adds the hand-over log per finished job: "who has had what" is a
// question people ask about a job AFTER it is done — who had the three that
// came back — and the dispatch board it otherwise lives on is a working
// screen for jobs still running.
//
// Wave D adds the Deleted section (supervisor+ since standard-tracking-jobs
// slice 5 — was owner-only): a job trashed from Active projects lives here for
// 30 days with an Undo, then it's gone for good
// (purge_expired_projects, nightly). Days-left is computed against the
// SERVER's clock (server_now), never the phone's own — a wrong device clock
// must never make the countdown lie about how much time is actually left.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router-dom";
import { AssignmentHistoryCard } from "../components/install/AssignmentHistoryCard";
import { BackChip } from "../components/BackChip";
import { EmptyState } from "../components/ui/States";
import { listProjectsAnyStatus, listTrashedProjects, restoreProject, setProjectStatus } from "../lib/api";
import { countDataOffByProject } from "../lib/install/api";
import { deleteJob } from "../lib/jobDeletion";
import { fetchServerNowMs } from "../lib/clockSkew";
import { formatApiError } from "../lib/errors";
import { isForemanPlus, isSupervisorPlus } from "../lib/install/types";
import { trashStatusLine } from "../lib/projectTrash";
import { useEffectiveRole } from "../lib/useEffectiveRole";

const STATUS_WORDS: Record<string, string> = {
  completed: "Finished",
  cancelled: "Cancelled",
};

export function JobHistory() {
  const qc = useQueryClient();
  const { effectiveRole } = useEffectiveRole();
  // Supervisor+ reopens finished jobs, deletes jobs, and works the trash
  // (slice 5 widened delete/restore from owner-only to supervisor+).
  const boss = isSupervisorPlus(effectiveRole);
  // The hand-over log is foreman+ in the database (opening_assignment_events'
  // own policy), so the card is drawn to exactly the people it would answer —
  // an empty panel with no explanation is worse than no panel.
  const canSeeHandovers = isForemanPlus(effectiveRole);
  const [message, setMessage] = useState<string | null>(null);

  const projects = useQuery({
    queryKey: ["projectsAll"],
    queryFn: listProjectsAnyStatus,
  });
  const done = (projects.data ?? []).filter((p) => p.status !== "active");

  // Wave E: how much of what each finished job recorded turned out to be
  // wrong. A job's epitaph is not only how long it took — a job that finished
  // fast with nine units data off did not finish clean.
  const dataOff = useQuery({
    queryKey: ["dataOffByProject", done.map((p) => p.id).join(",")],
    queryFn: () => countDataOffByProject(done.map((p) => p.id)),
    enabled: done.length > 0,
  });

  const trashed = useQuery({
    queryKey: ["projectsTrashed"],
    queryFn: listTrashedProjects,
    enabled: boss,
  });
  const serverNow = useQuery({
    queryKey: ["serverNowMs"],
    queryFn: fetchServerNowMs,
    enabled: boss,
    staleTime: 60_000,
  });

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["projectsAll"] });
    void qc.invalidateQueries({ queryKey: ["projects"] });
    void qc.invalidateQueries({ queryKey: ["projectsTrashed"] });
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
    mutationFn: ({ id, reason }: { id: string; reason: string }) =>
      deleteJob(id, reason),
    onSuccess: () => {
      setMessage("Deleted — it disappears everywhere. Undo for 30 days, right here.");
      refresh();
    },
    onError: (e) => setMessage(formatApiError(e)),
  });

  const undo = useMutation({
    mutationFn: (id: string) => restoreProject(id),
    onSuccess: () => {
      setMessage("Restored — it's back everywhere, exactly as it was.");
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
                  {(dataOff.data?.get(p.id) ?? 0) > 0 &&
                    ` · ${dataOff.data?.get(p.id)} unit${
                      dataOff.data?.get(p.id) === 1 ? "" : "s"
                    } data off`}
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
              {boss && (
                <button
                  className="link"
                  style={{ color: "var(--danger)" }}
                  disabled={remove.isPending}
                  onClick={() => {
                    const reason = window.prompt(
                      `Delete ${p.job_code}? It disappears everywhere, and you have 30 days to undo right here.\n\nWhy are you deleting it? (every supervisor is told)`,
                    );
                    if (reason && reason.trim()) {
                      remove.mutate({ id: p.id, reason: reason.trim() });
                    }
                  }}
                >
                  delete
                </button>
              )}
            </div>
            {canSeeHandovers && <AssignmentHistoryCard projectId={p.id} />}
          </li>
        ))}
      </ul>
      {done.length === 0 && (
        <EmptyState
          title="No finished jobs yet."
          message="When a supervisor completes a job from its page, it moves here with everything it ever tracked."
        />
      )}

      {boss && (
        <>
          <h2 style={{ marginTop: 28 }}>Deleted</h2>
          <p className="muted">
            30 days to undo, then it's gone for good — including its warehouse material, which
            keeps its job name until then.
          </p>
          <ul className="unit-list">
            {(trashed.data ?? []).map((p) => {
              const line =
                serverNow.data != null && p.deleted_at
                  ? trashStatusLine(p.deleted_at, serverNow.data)
                  : null;
              const beingErased = line === "being erased";
              return (
                <li key={p.id} className="opening-review-row">
                  <div className="wh-row">
                    <div className="wh-row-main">
                      <span className="wh-row-title">{p.job_code}</span>
                      <div className="wh-row-sub">
                        {p.name}
                        {line ? ` · ${line}` : ""}
                      </div>
                    </div>
                    {!beingErased && (
                      <button
                        className="button-like"
                        disabled={undo.isPending}
                        onClick={() => undo.mutate(p.id)}
                      >
                        {undo.isPending ? "Restoring…" : "Undo"}
                      </button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
          {trashed.data?.length === 0 && (
            <EmptyState
              title="Nothing in the trash."
              message="Delete a job from Active projects and it lands here for 30 days before it's gone for good."
            />
          )}
        </>
      )}
    </div>
  );
}
