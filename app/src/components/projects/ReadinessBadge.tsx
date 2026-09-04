// The readiness pill (Wave J, J1): "Not ready" beside a job's name, wherever
// its name is shown with the mode badge.
//
// It sits BESIDE JobModeBadge, never on top of it. The two say different
// things — the mode badge is what KIND of job this is and never changes; this
// one is what state the job is in this week — and a reader who has learned to
// find the mode pill in a row of cards should still find it in the same place.
//
// A job that is Ready wears nothing. Every job in this company was ready until
// somebody said otherwise, so a "Ready" pill on every card would be a row of
// green stickers nobody reads, and the one card that matters would be the one
// missing a sticker. Absence is the quiet state; the pill is the exception.

import { useT } from "../../lib/i18n";

export function ReadinessBadge({
  readyState,
  className,
}: {
  /** projects.ready_state. `undefined` means a database that has not had wave
   * J's migration yet — nothing is shown, and the card still renders. */
  readyState?: string | null;
  className?: string;
}) {
  const t = useT();
  if (readyState !== "not_ready") return null;
  return (
    <span className={className ? `job-ready-badge ${className}` : "job-ready-badge"}>
      {t("pipeline.notReady")}
    </span>
  );
}
