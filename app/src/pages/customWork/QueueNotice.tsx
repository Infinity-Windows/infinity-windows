import { useState } from "react";
import { discardWorkQueue, retryWork } from "../../lib/customWork/queue";
import { workAwaitingShiftReview } from "../../lib/customWork/model";
import type { WorkStore } from "../../lib/customWork/useWork";
import { formatApiError } from "../../lib/errors";

export function QueueNotice({ work }: { work: WorkStore }) {
  const [error, setError] = useState("");
  const [exported, setExported] = useState(false);
  // Asked on the page, not with window.confirm: an installed app or embedded
  // browser can swallow that box, and then the button did nothing at all
  // (Matt, 2026-11-20: "isn't giving me a confirm. It didn't clear out").
  const [confirming, setConfirming] = useState(false);
  const run = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      setError("");
    } catch (e) {
      setError(formatApiError(e));
    }
  };
  if (work.queueError)
    return (
      <p role="alert" className="cw-error">
        {work.queueError} Saved work has not been removed.
      </p>
    );
  if (!work.queue.length) return error ? <p role="alert">{error}</p> : null;
  const awaitingShiftReview = workAwaitingShiftReview(work.queue);
  const pendingCount = work.queue.length - awaitingShiftReview.size;
  const refusal = work.queue.find((c) => c.error && !awaitingShiftReview.has(c.id))?.error;
  return (
    <aside className="cw-notice" aria-label="Pending work">
      <strong>
        {pendingCount > 0 && `${pendingCount} work changes saved on this device — pending sync`}
        {pendingCount > 0 && awaitingShiftReview.size > 0 && " · "}
        {awaitingShiftReview.size > 0 && `${awaitingShiftReview.size} saved for review`}
      </strong>
      {awaitingShiftReview.size > 0 && (
        <p>The captured start did not fit its paid shift. You can clock in and start new work. Export the captured times for a foreman to review.</p>
      )}
      {refusal && (
        <p role="alert">
          {refusal} Your captured times are preserved below for review.
        </p>
      )}
      <div className="cw-actions">
        {pendingCount > 0 && <button
          onClick={() =>
            void run(async () => {
              if (work.user) await retryWork(work.user);
              await work.refresh();
            })
          }
        >
          Retry sync
        </button>}
        <button
          onClick={() => {
            const url = URL.createObjectURL(
              new Blob([JSON.stringify(work.queue, null, 2)], {
                type: "application/json",
              }),
            );
            const a = document.createElement("a");
            a.href = url;
            a.download = "forge-pending-work.json";
            a.click();
            URL.revokeObjectURL(url);
            setExported(true);
          }}
        >
          Export pending work
        </button>
        {(refusal || awaitingShiftReview.size > 0) && exported && !confirming && (
          <button onClick={() => setConfirming(true)}>Remove exported pending changes</button>
        )}
      </div>
      {confirming && (
        <div role="alertdialog" aria-label="Remove pending changes">
          <p>Keep the exported file for a foreman to review. Remove these unsynced changes from this device? Saved server records and payroll will not be changed.</p>
          <div className="cw-actions">
            <button
              onClick={() =>
                void run(async () => {
                  if (work.user) {
                    await discardWorkQueue(work.user);
                    await work.refresh();
                  }
                  setConfirming(false);
                })
              }
            >
              Remove from this device
            </button>
            <button onClick={() => setConfirming(false)}>Keep</button>
          </div>
        </div>
      )}
      {error && <p role="alert">{error}</p>}
    </aside>
  );
}
