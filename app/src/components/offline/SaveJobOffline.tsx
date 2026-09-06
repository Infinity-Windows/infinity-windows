// The "Save for offline" control, and the strip that does it for a list of
// jobs. One hook underneath both, so a job saved from the job page and a job
// saved from a landing's "Save all" are the same save and show the same date.
//
// The label is the whole feature: a foreman standing at the truck reads
// "Saved offline · 2 h ago" and knows the phone is ready, or reads "Save for
// offline" and taps it. Nothing here moves when hovered (role-maps rule).

import { useT } from "../../lib/i18n";
import { agoLabel, useSaveJobsOffline } from "../../lib/offline/useSaveJobsOffline";

/** One job's button, for the job page. */
export function SaveJobOffline({ projectId }: { projectId: string }) {
  const t = useT();
  const { run, saved, start } = useSaveJobsOffline([projectId]);
  const record = saved[projectId];
  const failedNow =
    run.phase === "done" ? (run.results[0]?.failed.length ?? 0) : 0;

  let label: string;
  if (run.phase === "saving") {
    label = run.total > 0 ? t("offline.saving", { done: run.done, total: run.total }) : t("offline.savingStart");
  } else if (run.phase === "error") {
    label = t("offline.failed");
  } else if (run.phase === "done" && failedNow > 0) {
    label = t("offline.savedPartly", { n: failedNow });
  } else if (record && record.failed > 0) {
    // Honest after a reload too: a save that lost pictures says so until
    // somebody refreshes it with better signal.
    label = t("offline.savedMissing", { ago: agoLabel(t, record.at), n: record.failed });
  } else if (record) {
    label = t("offline.saved", { ago: agoLabel(t, record.at) });
  } else {
    label = t("offline.save");
  }

  return (
    <button
      type="button"
      className="action-btn"
      data-testid="save-job-offline"
      data-state={run.phase === "saving" ? "saving" : run.phase === "error" ? "failed" : record ? "saved" : "idle"}
      disabled={run.phase === "saving"}
      title={record ? t("offline.refresh") : undefined}
      aria-live="polite"
      onClick={() => void start()}
    >
      {label}
    </button>
  );
}

/**
 * "N of M jobs saved on this phone · Save all", for the three landings. Hidden
 * when there are no jobs to save; never gated by role — an installer's own
 * jobs are exactly the ones that should be on their phone.
 */
export function SaveJobsStrip({ projectIds }: { projectIds: readonly string[] }) {
  const t = useT();
  const unique = [...new Set(projectIds)];
  const { run, saved, start } = useSaveJobsOffline(unique);
  if (unique.length === 0) return null;
  const savedCount = unique.filter((id) => saved[id]).length;

  let action: string;
  if (run.phase === "saving") {
    action = t("offline.savingJobs", {
      i: run.jobIndex + 1,
      n: run.jobCount,
      done: run.done,
      total: Math.max(run.total, run.done),
    });
  } else if (run.phase === "error") {
    action = t("offline.failed");
  } else if (savedCount === unique.length) {
    action = t("offline.refreshAll");
  } else {
    action = t("offline.saveAll");
  }

  return (
    <div className="save-offline-strip" data-testid="save-jobs-strip">
      <span className="muted">{t("offline.strip", { saved: savedCount, total: unique.length })}</span>
      <button
        type="button"
        className="action-btn"
        disabled={run.phase === "saving"}
        aria-live="polite"
        onClick={() => void start()}
      >
        {action}
      </button>
    </div>
  );
}
