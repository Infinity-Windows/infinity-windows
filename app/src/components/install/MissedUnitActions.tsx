// What a supervisor does with a window somebody found on site.
//
// Wave E (transcripts program, Q18). Three answers, and which two are offered
// depends on whether the unit carries WORK, not on how it was born:
//
//   Keep    — always. Rename it once the paperwork catches up ("Missed 2" was
//             really W-14), and everything downstream follows the new name.
//   Merge   — only while nothing has been clocked or installed against it. It
//             deletes a row, so it is offered exactly when deleting it costs
//             no evidence. Otherwise: Keep + rename.
//   Remove  — same rule, and it is the ordinary soft delete underneath, so a
//             removed missed unit is hidden and restorable, never destroyed.
//
// The refusals live in SQL as plain sentences (merge_field_unit /
// remove_field_unit); this component hides the buttons it knows will be
// refused, and shows whatever the server says when it refuses anyway.

import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { useT } from "../../lib/i18n";
import {
  mergeFieldUnit,
  removeFieldUnit,
  renameFieldUnit,
} from "../../lib/install/api";
import type { ProjectOpening } from "../../lib/install/types";

export interface MissedUnitActionsProps {
  opening: ProjectOpening;
  /** Every live opening on this job — the merge target list. */
  openings: readonly ProjectOpening[];
  /** Supervisor and up. Below that this is a read-only badge. */
  canAct: boolean;
  onDone: (message: string) => void;
  onError: (error: unknown) => void;
}

export function MissedUnitActions({
  opening,
  openings,
  canAct,
  onDone,
  onError,
}: MissedUnitActionsProps) {
  const t = useT();
  const [name, setName] = useState(opening.opening_code);
  const [into, setInto] = useState("");

  const rename = useMutation({
    mutationFn: () => renameFieldUnit(opening.id, name.trim()),
    onSuccess: (row) => onDone(`Kept as ${row.opening_code}.`),
    onError,
  });
  const merge = useMutation({
    mutationFn: () => mergeFieldUnit(opening.id, into),
    onSuccess: (row) => onDone(`Merged into ${row.opening_code}.`),
    onError,
  });
  const remove = useMutation({
    mutationFn: () => removeFieldUnit(opening.id),
    onSuccess: () => onDone("Taken back off the job — it is in the removed list."),
    onError,
  });

  const busy = rename.isPending || merge.isPending || remove.isPending;
  const targets = openings.filter((o) => o.id !== opening.id && !o.field_added);

  return (
    <div className="detail-card missed-unit-card">
      <p className="field-label" style={{ margin: 0 }}>
        {t("missed.badge")}
      </p>
      <p className="muted" style={{ margin: "4px 0" }}>
        Added from the site. It counts as a real window or door everywhere until
        somebody says otherwise.
      </p>
      {!canAct ? (
        <p className="muted" style={{ margin: 0, fontSize: 13 }}>
          A supervisor decides whether it keeps this name, is really an existing
          mark, or comes back off.
        </p>
      ) : (
        <>
          <label className="field-label">Keep it — under this name</label>
          <div className="row-gap">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              aria-label="Name for this unit"
            />
            <button
              className="action-btn"
              disabled={busy || !name.trim() || name.trim() === opening.opening_code}
              onClick={() => rename.mutate()}
            >
              Save the name
            </button>
          </div>

          <label className="field-label">Or it is really an existing mark</label>
          <div className="row-gap">
            <select value={into} onChange={(e) => setInto(e.target.value)}>
              <option value="">Merge into…</option>
              {targets.map((o) => (
                <option key={o.id} value={o.opening_code}>
                  {o.opening_code}
                </option>
              ))}
            </select>
            <button className="action-btn" disabled={busy || !into} onClick={() => merge.mutate()}>
              Merge
            </button>
          </div>

          <button
            className="link"
            style={{ color: "var(--danger)" }}
            disabled={busy}
            onClick={() => remove.mutate()}
          >
            Take it back off the job
          </button>
        </>
      )}
    </div>
  );
}
