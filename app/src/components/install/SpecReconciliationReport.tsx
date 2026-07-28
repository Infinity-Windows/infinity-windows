// "What doesn't add up" — the specs sheet cross-referenced against the building
// plans, in the words a foreman would use.
//
// Runs automatically whenever the review screen renders (which is where a
// foreman lands the moment an extraction finishes), never behind a button. The
// finding is always derived from live data, so a re-extract can't leave a stale
// answer on screen.
//
// FOREMAN AND ABOVE ONLY. Chasing a supplier for a missing sheet is an office
// job; an installer must never see the project-wide list. They get one calm
// line on the single unit they're holding instead — see `MissingSpecNotice`.
// The route this renders under is already foreman-gated, but the check is
// repeated here so the component can't leak if it's ever reused somewhere open.
//
// Says NOTHING when the two documents agree. A clean job must stay silent.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import {
  acknowledgeSpecDiscrepancy,
  listSpecDiscrepancyAcks,
  unacknowledgeSpecDiscrepancy,
} from "../../lib/install/api";
import { formatApiError } from "../../lib/install/errors";
import { isForemanPlus } from "../../lib/install/types";
import type { ProjectOpening } from "../../lib/install/types";
import { useEffectiveRole } from "../../lib/useEffectiveRole";
import {
  describeAcknowledged,
  markLabel,
  planMarksFromOpenings,
  reconcileSpecsWithPlans,
  reconciliationLines,
  type Discrepancy,
  type ReconcileSpec,
} from "../../lib/install/specReconciliation";

interface Props {
  projectId: string;
  /** Every opening on the project — the plans side of the comparison. */
  openings: ProjectOpening[];
  /** Extracted/saved spec rows — the spec-sheet side. */
  specs: ReconcileSpec[];
}

/** Why each kind matters, said once under its sentence. */
const KIND_HELP: Record<Discrepancy["kind"], string> = {
  mark_without_spec:
    "The plans call for these but the supplier's sheet doesn't cover them. Ask the supplier for the missing sheets.",
  spec_without_mark:
    "The supplier priced these but no opening on the plans uses them. Usually an interior unit, a leftover, or a mis-read label.",
  spec_without_size:
    "The sheet names these but gives no dimensions, so nobody can cut an opening to them yet.",
  spec_without_drawing:
    "The written spec is there, just not the picture — the crew can install, but they can't check the shape.",
};

export function SpecReconciliationReport({ projectId, openings, specs }: Props) {
  const queryClient = useQueryClient();
  const { effectiveRole } = useEffectiveRole();
  const isLead = isForemanPlus(effectiveRole);
  const [message, setMessage] = useState<string | null>(null);
  const [noteFor, setNoteFor] = useState<string | null>(null);
  const [note, setNote] = useState("");

  // Never fetch foreman-only data for an installer, so the gate holds under
  // "view as role" preview too.
  const acks = useQuery({
    queryKey: ["specDiscrepancyAcks", projectId],
    queryFn: () => listSpecDiscrepancyAcks(projectId),
    enabled: isLead && Boolean(projectId),
  });

  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: ["specDiscrepancyAcks", projectId] });

  const label = useMutation({
    mutationFn: (args: { d: Discrepancy; note: string | null }) =>
      acknowledgeSpecDiscrepancy({
        projectId,
        markCode: args.d.mark,
        kind: args.d.kind,
        note: args.note,
      }),
    onSuccess: () => {
      setNoteFor(null);
      setNote("");
      refresh();
    },
    onError: (e) => setMessage(formatApiError(e)),
  });

  const unlabel = useMutation({
    mutationFn: (d: Discrepancy) =>
      unacknowledgeSpecDiscrepancy({
        projectId,
        markCode: d.mark,
        kind: d.kind,
      }),
    onSuccess: refresh,
    onError: (e) => setMessage(formatApiError(e)),
  });

  if (!isLead) return null;

  const report = reconcileSpecsWithPlans({
    planMarks: planMarksFromOpenings(openings),
    specs,
    acknowledgements: acks.data ?? [],
  });

  // A job where the two documents agree says nothing at all.
  if (report.reconciled) return null;

  const openLines = reconciliationLines(report.open);
  const chased = describeAcknowledged(report);

  const rowKey = (d: Discrepancy) => `${d.mark}::${d.kind}`;

  const actions = (d: Discrepancy) => {
    if (d.acknowledged) {
      return (
        <button className="link" onClick={() => unlabel.mutate(d)}>
          Not a known gap
        </button>
      );
    }
    if (noteFor === rowKey(d)) {
      return (
        <span style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <input
            autoFocus
            value={note}
            placeholder="Optional — e.g. emailed the supplier 7/28"
            onChange={(e) => setNote(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") label.mutate({ d, note: note || null });
              if (e.key === "Escape") setNoteFor(null);
            }}
          />
          <button
            className="action-btn"
            disabled={label.isPending}
            onClick={() => label.mutate({ d, note: note || null })}
          >
            Save
          </button>
        </span>
      );
    }
    return (
      <button
        className="link"
        onClick={() => {
          setNoteFor(rowKey(d));
          setNote("");
        }}
      >
        We know about this
      </button>
    );
  };

  return (
    <div className="detail-card" style={{ marginTop: 8 }}>
      <strong>What doesn't add up</strong>
      <p className="muted" style={{ margin: "2px 0 8px" }}>
        The spec sheet checked against the building plans. {report.planMarkCount}{" "}
        marks on the plans, {report.specMarkCount} on the sheet.
      </p>

      {message && <p className="error">{message}</p>}

      {openLines.map((line) => (
        <div key={line.kind} style={{ marginTop: 8 }}>
          <p style={{ margin: 0 }}>{line.text}</p>
          <p className="muted" style={{ margin: "2px 0 0", fontSize: 12 }}>
            {KIND_HELP[line.kind]}
          </p>
          <ul className="unit-list" style={{ marginTop: 4 }}>
            {report.open
              .filter((d) => d.kind === line.kind)
              .map((d) => (
                <li
                  key={rowKey(d)}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: 8,
                    flexWrap: "wrap",
                  }}
                >
                  <span>
                    <strong>{markLabel(d)}</strong>
                    {d.units > 0 && (
                      <span className="muted">
                        {" "}
                        · {d.units} {d.units === 1 ? "unit" : "units"}
                      </span>
                    )}
                    {d.style && (
                      <span className="muted" style={{ fontSize: 12 }}>
                        {" "}
                        · {d.style}
                      </span>
                    )}
                  </span>
                  {actions(d)}
                </li>
              ))}
          </ul>
        </div>
      ))}

      {chased && (
        <div style={{ marginTop: 12 }}>
          <p className="muted" style={{ margin: 0 }}>
            {chased} Crews see these as known gaps, not blanks.
          </p>
          <ul className="unit-list" style={{ marginTop: 4 }}>
            {report.acknowledged.map((d) => (
              <li
                key={rowKey(d)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 8,
                  flexWrap: "wrap",
                }}
              >
                <span className="muted">
                  {markLabel(d)}
                  {d.note ? ` — ${d.note}` : ""}
                </span>
                {actions(d)}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
