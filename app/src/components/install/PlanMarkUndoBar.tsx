import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useState } from "react";
import { Undo2 } from "lucide-react";
import {
  getMyProfile,
  listPinMoves,
  listProfiles,
  resetOpeningPin,
  resetProjectPins,
  undoPinMove,
} from "../../lib/install/api";
import { formatApiError } from "../../lib/install/errors";
import {
  describeMovedSummary,
  describePinMove,
  describeResetAll,
  isMarkMoved,
  movedMarkIds,
  nextUndoableMove,
  undoableCount,
} from "../../lib/install/pinHistory";
import { openingMarkCode } from "../../lib/install/types";
import type { ProjectOpening } from "../../lib/install/types";
import { isNetworkError } from "../../lib/offline/outbox-core";
import {
  enqueuePinResetOpening,
  enqueuePinResetProject,
  enqueuePinUndo,
} from "../../lib/offline/outbox";
import { pushToast, toastError, toastSuccess } from "../../lib/toast";
import { ConfirmDanger } from "../ConfirmDanger";

interface Props {
  projectId: string;
  jobName: string;
  openings: ProjectOpening[];
  /** The mark tapped on the drawing, so "put THIS one back" can be offered. */
  selectedOpening: ProjectOpening | null;
}

/**
 * Undo for marks dragged around the plan.
 *
 * Taylor asked for "a back button, like a control Z". Undo is the primary
 * control and walks the job's move history back one step at a time; "Put every
 * mark back" is the same journey in one press and is deliberately quieter and
 * behind a confirmation, because someone may have nudged a mark on purpose to
 * match the building.
 *
 * There is no Redo. Putting a mark back where it was is what dragging it
 * already does, and a second stack that a second person can also press is more
 * ways to be surprised than it is worth on a shared job.
 */
export function PlanMarkUndoBar({
  projectId,
  jobName,
  openings,
  selectedOpening,
}: Props) {
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  // Pick 10: the one danger-confirm pattern app-wide — an in-page card
  // instead of window.confirm.
  const [confirmResetAll, setConfirmResetAll] = useState(false);

  const moves = useQuery({
    queryKey: ["pinMoves", projectId],
    queryFn: () => listPinMoves(projectId),
    enabled: !!projectId,
  });
  // Both already cached by the pages around this one — read them here so the
  // map only has to hand over the job and the selected mark.
  const me = useQuery({ queryKey: ["myProfile"], queryFn: getMyProfile });
  const crew = useQuery({ queryKey: ["profiles"], queryFn: listProfiles });
  const crewNameById = new Map(
    (crew.data ?? []).map((c) => [c.id, c.display_name]),
  );
  const currentUserId = me.data?.id ?? null;

  const history = moves.data ?? [];
  const head = nextUndoableMove(history);
  const remaining = undoableCount(history);
  const movedIds = movedMarkIds(openings);
  const movedCount = movedIds.size;
  const headOpening = head
    ? openings.find((o) => o.id === head.opening_id) ?? null
    : null;

  const refresh = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ["openings", projectId] });
    queryClient.invalidateQueries({ queryKey: ["pinMoves", projectId] });
  }, [queryClient, projectId]);

  /**
   * Offline is not a failure here. Every one of these actions names exactly
   * what it wants done — this move, this mark, this job — so it can sit in the
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

  const undo = useMutation({
    mutationFn: async () => {
      if (!head) return;
      const label = headOpening
        ? openingMarkCode(headOpening.opening_code)
        : "the mark";
      await run(
        () => undoPinMove(head.id),
        () => enqueuePinUndo(head.id),
        `Mark ${label} is back where it was.`,
      );
    },
  });

  const resetOne = useMutation({
    mutationFn: async (opening: ProjectOpening) => {
      await run(
        () => resetOpeningPin(opening.id),
        () => enqueuePinResetOpening(opening.id),
        `Mark ${openingMarkCode(opening.opening_code)} is back where the plan put it.`,
      );
    },
  });

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

  // "Control Z", as asked for. Laptop only — a phone has no keyboard, which is
  // why the button beside it is a full 44px thumb target rather than an icon.
  useEffect(() => {
    if (!head) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== "z" || !(e.metaKey || e.ctrlKey) || e.shiftKey) {
        return;
      }
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || target?.isContentEditable) {
        return;
      }
      e.preventDefault();
      undo.mutate();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [head?.id, busy]);

  const selectedIsMoved = selectedOpening ? isMarkMoved(selectedOpening) : false;

  if (!head && movedCount === 0) {
    return (
      <p className="muted mark-undo__clear">
        {describeMovedSummary(0)} Drag one and an Undo button appears here.
      </p>
    );
  }

  const undoLabel = head
    ? describePinMove({
        move: head,
        markLabel: headOpening
          ? openingMarkCode(headOpening.opening_code)
          : "a mark",
        movedByName: head.moved_by ? crewNameById.get(head.moved_by) : null,
        byCurrentUser: !!head.moved_by && head.moved_by === currentUserId,
        nowMs: Date.now(),
      })
    : "Nothing left to undo";

  return (
    <div className="mark-undo" aria-label="Undo mark moves">
      <p className="mark-undo__status">
        {describeMovedSummary(movedCount)}
        {remaining > 0 && (
          <span className="muted">
            {" "}
            {remaining === 1 ? "1 step" : `${remaining} steps`} to go back through.
          </span>
        )}
      </p>

      <div className="mark-undo__row">
        <button
          type="button"
          className="mark-undo__btn mark-undo__btn--primary"
          disabled={!head || busy}
          onClick={() => undo.mutate()}
          title={`${undoLabel} (Ctrl+Z)`}
        >
          <Undo2 size={18} aria-hidden />
          <span>{busy ? "Working…" : undoLabel}</span>
        </button>

        {selectedOpening && selectedIsMoved && (
          <button
            type="button"
            className="mark-undo__btn"
            disabled={busy}
            onClick={() => resetOne.mutate(selectedOpening)}
          >
            Put mark {openingMarkCode(selectedOpening.opening_code)} back on the
            plan
          </button>
        )}
      </div>

      {movedCount > 0 && !confirmResetAll && (
        <button
          type="button"
          className="mark-undo__all"
          disabled={busy}
          onClick={() => setConfirmResetAll(true)}
        >
          Put every mark back where the plan put it
          {movedCount === 1 ? " (1 mark)" : ` (${movedCount} marks)`}
        </button>
      )}
      {movedCount > 0 && confirmResetAll && (
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
