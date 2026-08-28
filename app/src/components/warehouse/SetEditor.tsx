// The set editor (wave M, owner ask 2026-08-28: "make sure I have full
// access to editing every single set — everything that is connected to a
// unit, how many parts, what type of set it is, etcetera"). Extracted out
// of DeliveryDetail (#433) so the materials ledger can mount the exact same
// editor JobMaterials.tsx now does — one mark's every piece in one place:
// rename the set, retype a piece, add one, or delete one or the whole set.
//
// Rename, piece-edit, and delete are IDENTICAL for both callers — same RPCs,
// same confirm sentences — and live here. Only "add one more piece" differs:
// DeliveryDetail already has a delivery to add expected pieces to
// (add_delivery_set); JobMaterials' ledger has no delivery in hand, and
// customCheckin — the RPC shaped for "something arrived, check it in right
// now" — hard-requires an active container and has no waiting-job argument
// at all, so there is no working inline form to offer there. The
// addPieceStrategy prop carries whichever is true; see the "unavailable"
// case below.
import { useMutation } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useState } from "react";
import {
  deletePackages,
  PART_LABELS,
  renamePackage,
  setPackagePart,
  type PartType,
  type StoragePackage,
} from "../../lib/storage";
import { formatApiError } from "../../lib/errors";
import { showUndoToast } from "../../lib/undoToast";
import type { DeliverySet, SlotRow } from "../../lib/warehouse/deliveryReceiving";
import type { MaterialsScope } from "../../lib/warehouse/materialsScope";

export type AddPieceStrategy =
  | {
      kind: "delivery";
      /** Fire the caller's own add_delivery_set mutation — DeliveryDetail
       *  owns its message and refresh so onSuccess there stays untouched. */
      run: () => void;
      pending: boolean;
    }
  | {
      /** customCheckin needs an active container (no loose/none option the
       *  RPC will accept) and has no pending-job-name argument at all, so a
       *  waiting job's ledger can call it for neither scope. Honest fallback
       *  rather than a form that would fail on submit. */
      kind: "unavailable";
      message: ReactNode;
    };

export interface SetEditorProps {
  scope: MaterialsScope;
  set: DeliverySet;
  /** Every package the set's rows reference, keyed by id — for reading each
   *  row's current piece fields and the set's current category. */
  packagesById: Map<string, StoragePackage>;
  partChoices: string[];
  /** foreman+ — gates add/delete, same floor DeliveryDetail always used. */
  lead: boolean;
  onClose: () => void;
  /** Invalidate/refetch whatever query the caller reads packages from. */
  onChanged: () => void;
  onMessage: (message: string | null) => void;
  addPieceStrategy: AddPieceStrategy;
  /** Named for the "delete this set" confirm sentence — DeliveryDetail
   *  always said "this delivery"; the ledger names itself instead. */
  deleteScopeLabel: string;
}

export function SetEditor({
  scope,
  set,
  packagesById,
  partChoices,
  lead,
  onClose,
  onChanged,
  onMessage,
  addPieceStrategy,
  deleteScopeLabel,
}: SetEditorProps) {
  // Renaming is for unbound sets only: a bound set's mark comes from the
  // job's own window, and rename_package refuses it by design — so no field
  // is offered at all.
  const boundMarks = scope.projectId != null;
  const missing = set.expected - set.arrived;

  const [setName, setSetName] = useState(() => ({
    pending: scope.pendingName ?? "",
    mark: set.mark,
  }));
  const [pieceDraft, setPieceDraft] = useState<
    Record<string, { index: string; total: string; type: string }>
  >({});

  // Rename the whole set: every piece, whatever its state, or the old name
  // survives on stragglers. Metadata only; the undo toast puts it all back.
  const saveSetName = useMutation({
    mutationFn: async () => {
      const prior = { pending: scope.pendingName, mark: set.mark };
      const nextPending = boundMarks ? null : setName.pending.trim() || null;
      const nextMark = setName.mark.trim();
      if (!nextMark) throw new Error("Every set needs a mark, like 16 or 13A.");
      for (const pid of set.allIds) {
        await renamePackage(pid, nextPending, nextMark);
      }
      return { ids: set.allIds, prior };
    },
    onSuccess: ({ ids, prior }) => {
      onClose();
      onChanged();
      showUndoToast({
        message: "Set renamed.",
        undo: async () => {
          for (const pid of ids) {
            await renamePackage(pid, prior.pending, prior.mark);
          }
          onChanged();
        },
      });
    },
    onError: (e) => onMessage(formatApiError(e)),
  });

  const savePiece = useMutation({
    mutationFn: async (args: {
      row: SlotRow;
      index: number | null;
      total: number | null;
      type: string | null;
    }) => {
      for (const pid of args.row.allIds) {
        await setPackagePart(pid, args.index, args.total, args.type);
      }
    },
    onSuccess: () => {
      onMessage("Piece updated.");
      onChanged();
    },
    onError: (e) => onMessage(formatApiError(e)),
  });

  const deletePieces = useMutation({
    mutationFn: async (ids: string[]) => deletePackages(ids),
    onSuccess: (r) => {
      onMessage(
        r.refused.length > 0
          ? `Deleted ${r.deleted}. Refused: ${r.refused.map((x) => `${x.serial} (${x.reason})`).join("; ")}`
          : `Deleted ${r.deleted}.`,
      );
      onClose();
      onChanged();
    },
    onError: (e) => onMessage(formatApiError(e)),
  });

  return (
    <div className="detail-card" style={{ marginBottom: 8 }}>
      <div className="wh-row">
        <strong>Edit #{set.mark}</strong>
        <span className="wh-row-sub">
          {set.expected} expected · {set.arrived} arrived · {set.stored} put away
        </span>
        <button className="button-like" onClick={onClose}>
          Close
        </button>
      </div>
      {!boundMarks && (
        <div className="wh-row" style={{ marginTop: 6 }}>
          <input
            value={setName.pending}
            onChange={(e) => setSetName((prev) => ({ ...prev, pending: e.target.value }))}
            placeholder="Waiting-job name"
            aria-label="Waiting-job name"
            maxLength={120}
            style={{ flex: 1, minWidth: 180 }}
          />
          <input
            value={setName.mark}
            onChange={(e) => setSetName((prev) => ({ ...prev, mark: e.target.value }))}
            aria-label="Mark"
            maxLength={40}
            style={{ width: 100 }}
          />
          <button
            className="primary"
            disabled={saveSetName.isPending}
            onClick={() => saveSetName.mutate()}
          >
            {saveSetName.isPending ? "Saving…" : "Save name"}
          </button>
        </div>
      )}
      {boundMarks && (
        <p className="muted" style={{ margin: "4px 0 0", fontSize: 12 }}>
          This set is tied to a built job — its mark comes from the job&rsquo;s
          own window, so only the pieces are editable here.
        </p>
      )}
      <ul className="unit-list" style={{ marginTop: 6 }}>
        {set.slots.map((row) => {
          const rowFirst = packagesById.get(row.allIds[0] ?? "");
          const d = pieceDraft[row.key] ?? {
            index: rowFirst?.part_index != null ? String(rowFirst.part_index) : "",
            total: rowFirst?.part_total != null ? String(rowFirst.part_total) : "",
            type: rowFirst?.part_type ?? "",
          };
          const setD = (patch: Partial<typeof d>) =>
            setPieceDraft((prev) => ({ ...prev, [row.key]: { ...d, ...patch } }));
          return (
            <li key={row.key} className="opening-review-row">
              <div className="wh-row">
                <span className="wh-row-sub" style={{ flex: 1, minWidth: 140 }}>
                  {row.label}
                </span>
                {!row.isCrate && (
                  <>
                    <input
                      type="number"
                      min={1}
                      max={99}
                      value={d.index}
                      onChange={(e) => setD({ index: e.target.value })}
                      aria-label={`Piece number for ${row.label}`}
                      style={{ width: 64 }}
                    />
                    <span className="muted">of</span>
                    <input
                      type="number"
                      min={1}
                      max={99}
                      value={d.total}
                      onChange={(e) => setD({ total: e.target.value })}
                      aria-label={`Piece total for ${row.label}`}
                      style={{ width: 64 }}
                    />
                    <select
                      value={d.type}
                      onChange={(e) => setD({ type: e.target.value })}
                      aria-label={`What is ${row.label}`}
                    >
                      <option value="">— what is it? —</option>
                      {partChoices.map((t) => (
                        <option key={t} value={t}>
                          {PART_LABELS[t as PartType] ?? t}
                        </option>
                      ))}
                    </select>
                    <button
                      className="button-like"
                      disabled={savePiece.isPending}
                      onClick={() =>
                        savePiece.mutate({
                          row,
                          index: d.index.trim() === "" ? null : Number(d.index),
                          total: d.total.trim() === "" ? null : Number(d.total),
                          type: d.type || null,
                        })
                      }
                    >
                      Save
                    </button>
                  </>
                )}
                {lead && (
                  <button
                    className="link"
                    style={{ color: "var(--danger)" }}
                    disabled={deletePieces.isPending}
                    onClick={() => {
                      if (
                        window.confirm(
                          `Delete ${row.label}? ${row.received} of its ${row.expected} already arrived — arrived pieces are real material. This can't be undone.`,
                        )
                      ) {
                        deletePieces.mutate(row.allIds);
                      }
                    }}
                  >
                    delete
                  </button>
                )}
              </div>
            </li>
          );
        })}
      </ul>
      {lead && (
        <div className="wh-row" style={{ marginTop: 6 }}>
          {addPieceStrategy.kind === "delivery" ? (
            <button
              className="button-like"
              disabled={addPieceStrategy.pending}
              onClick={() => addPieceStrategy.run()}
            >
              + one more piece
            </button>
          ) : (
            <span className="wh-row-sub">{addPieceStrategy.message}</span>
          )}
          <button
            className="button-like"
            style={{ color: "var(--danger)" }}
            disabled={deletePieces.isPending}
            onClick={() => {
              if (
                window.confirm(
                  `Delete ALL of #${set.mark} from ${deleteScopeLabel}? ${missing} still-expected die with it, and ${set.arrived} arrived piece${set.arrived === 1 ? "" : "s"} — real material — get deleted too. This can't be undone.`,
                )
              ) {
                deletePieces.mutate(set.allIds);
              }
            }}
          >
            Delete this set…
          </button>
        </div>
      )}
    </div>
  );
}
