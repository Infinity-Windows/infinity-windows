import { useState } from "react";
import { discardWorkQueue, retryWork } from "../../lib/customWork/queue";
import type { WorkStore } from "../../lib/customWork/useWork";
import { formatApiError } from "../../lib/errors";

export function QueueNotice({ work }: { work: WorkStore }) {
  const [error, setError] = useState("");
  const [exported, setExported] = useState(false);
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
  const refusal = work.queue.find((c) => c.error)?.error;
  return (
    <aside className="cw-notice" aria-label="Pending work">
      <strong>
        {work.queue.length} work changes saved on this device — pending sync
      </strong>
      {refusal && (
        <p role="alert">
          {refusal} Your captured times are preserved below for review.
        </p>
      )}
      <div className="cw-actions">
        <button
          onClick={() =>
            void run(async () => {
              if (work.user) await retryWork(work.user);
              await work.refresh();
            })
          }
        >
          Retry sync
        </button>
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
        {refusal && exported && (
          <button
            onClick={() =>
              void run(async () => {
                if (
                  window.confirm(
                    "Keep the exported file for a foreman to review. Remove these unsynced changes from this device? Saved server records and payroll will not be changed.",
                  ) &&
                  work.user
                ) {
                  await discardWorkQueue(work.user);
                  await work.refresh();
                }
              })
            }
          >
            Remove exported pending changes
          </button>
        )}
      </div>
      {error && <p role="alert">{error}</p>}
    </aside>
  );
}
