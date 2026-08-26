import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { resetProjectPins } from "../../lib/install/api";
import { formatApiError } from "../../lib/install/errors";
import {
  describeMovedSummary,
  describeResetAll,
  movedMarkIds,
} from "../../lib/install/pinHistory";
import type { ProjectOpening } from "../../lib/install/types";
import { isNetworkError } from "../../lib/offline/outbox-core";
import { enqueuePinResetProject } from "../../lib/offline/outbox";
import { pushToast, toastError, toastSuccess } from "../../lib/toast";
import { ConfirmDanger } from "../ConfirmDanger";

interface Props {
  projectId: string;
  jobName: string;
  openings: ProjectOpening[];
}

/**
 * "Put every mark back" — the one bulk undo left in this bar.
 *
 * Pick 11 (owner-approved trade): a single drag now undoes through its own
 * toast, right where the drag happens (ProjectMap.tsx's showUndoToast call),
 * and Ctrl+Z moved there with it — one undo mechanism, not two, both walking
 * back the same move history. This bar keeps only the "put everything back"
 * affordance, deliberately behind a confirmation (ConfirmDanger, pick 10),
 * because someone may have nudged a mark on purpose to match the building.
 */
export function PlanMarkUndoBar({ projectId, jobName, openings }: Props) {
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  // Pick 10: the one danger-confirm pattern app-wide — an in-page card
  // instead of window.confirm.
  const [confirmResetAll, setConfirmResetAll] = useState(false);

  const movedCount = movedMarkIds(openings).size;

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ["openings", projectId] });
    queryClient.invalidateQueries({ queryKey: ["pinMoves", projectId] });
  };

  /**
   * Offline is not a failure here: the action names exactly what it wants
   * done — every mark on this job, back to the plan — so it can sit in the
   * durable outbox and be applied unchanged when the phone finds signal.
   */
  const run = async (
    online: () => Promise<unknown>,
    queueIt: () => Promise<string>,
    doneMessage: string,
  ) => {
    if (busy) return;
    setBusy(true);
    const offline = typeof navigator !== "undefined" && navigator.onLine === false;
    try {
      if (offline) {
        await queueIt();
        pushToast("No signal — saved. It will apply when you're back online.");
      } else {
        await online();
        toastSuccess(doneMessage);
      }
      refresh();
    } catch (err) {
      if (isNetworkError(err)) {
        try {
          await queueIt();
          pushToast("No signal — saved. It will apply when you're back online.");
          return;
        } catch (queueErr) {
          toastError(queueErr);
          return;
        }
      }
      toastError(err, formatApiError(err));
    } finally {
      setBusy(false);
    }
  };

  const resetAll = useMutation({
    mutationFn: async () => {
      await run(
        () => resetProjectPins(projectId),
        () => enqueuePinResetProject(projectId),
        movedCount === 1
          ? "1 mark is back where the plan put it."
          : `${movedCount} marks are back where the plan put them.`,
      );
    },
    onSuccess: () => setConfirmResetAll(false),
  });

  if (movedCount === 0) {
    return (
      <p className="muted mark-undo__clear">
        {/* The five-second toast owns single-move undo now (pick 11) — this
            sentence must not promise a button that lives here. */}
        {describeMovedSummary(0)} Drag one and a five-second Undo pops up;
        &ldquo;Put every mark back&rdquo; shows here once something moved.
      </p>
    );
  }

  return (
    <div className="mark-undo" aria-label="Undo mark moves">
      <p className="mark-undo__status">{describeMovedSummary(movedCount)}</p>

      {!confirmResetAll ? (
        <button
          type="button"
          className="mark-undo__all"
          disabled={busy}
          onClick={() => setConfirmResetAll(true)}
        >
          Put every mark back where the plan put it
          {movedCount === 1 ? " (1 mark)" : ` (${movedCount} marks)`}
        </button>
      ) : (
        <ConfirmDanger
          confirmText={busy ? "Putting back…" : "Put them back"}
          disabled={busy}
          onConfirm={() => resetAll.mutate()}
          onCancel={() => setConfirmResetAll(false)}
        >
          {describeResetAll(movedCount, jobName)}
        </ConfirmDanger>
      )}
    </div>
  );
}
