// What an installer sees where the spec card would have been, when the
// supplier's sheet simply doesn't cover this mark.
//
// Before this, mark #7 on Black Desert rendered as nothing at all — no card, no
// message, just empty space between the photos and the buttons. That reads as a
// broken app, and an installer's next move is to stop and phone someone.
//
// It isn't broken. Supplier sheets skip marks; that's ordinary. So this says so
// plainly, in one calm line, with no warning colour and no error styling — the
// office already has it, and the installer should carry on with the rest of
// their day.
//
// Deliberately NOT the foreman's reconciliation report: an installer sees only
// the mark in their hand, never the project-wide list of what doesn't add up.

import { useQuery } from "@tanstack/react-query";
import { listSpecDiscrepancyAcks } from "../../lib/install/api";
import { markBase } from "../../lib/install/extract";
import { installerMissingSpecMessage } from "../../lib/install/specReconciliation";

interface Props {
  projectId: string | null | undefined;
  /** The opening's code, e.g. "7" or "7-2"; the mark is derived from it. */
  openingCode: string | null | undefined;
}

/**
 * Renders the notice, or nothing when there's no mark to talk about. Only mount
 * this when the mark genuinely has no spec — the caller already knows, because
 * it just failed to find one.
 */
export function MissingSpecNotice({ projectId, openingCode }: Props) {
  const mark = openingCode ? markBase(openingCode).trim() : "";

  // Shares its cache key with the foreman report, so this is usually free.
  const acks = useQuery({
    queryKey: ["specDiscrepancyAcks", projectId],
    queryFn: () => listSpecDiscrepancyAcks(projectId ?? ""),
    enabled: Boolean(projectId && mark),
  });

  if (!mark) return null;

  const acknowledged = (acks.data ?? []).some(
    (a) =>
      a.kind === "mark_without_spec" &&
      a.mark_code.trim().toUpperCase() === mark.toUpperCase(),
  );

  return (
    <div className="detail-card">
      <span className="field-label" style={{ margin: 0 }}>
        Spec · mark #{mark}
      </span>
      <p className="muted" style={{ margin: "4px 0 0" }}>
        {installerMissingSpecMessage(mark, acknowledged)}
      </p>
    </div>
  );
}
