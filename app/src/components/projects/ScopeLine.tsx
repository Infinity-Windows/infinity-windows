// "40 openings · 32 windows · 8 doors · 2 stories" — wave X (X4).
//
// One line, two lengths. The job card gets the short one; the job header gets
// the same line plus which doors, in brackets, on every tab. Both read the same
// counted-in-the-database row (project_scope_counts) and the same pure rules
// (lib/scope.ts), so a card and the header it opens can never disagree.
//
// Deliberately its OWN component and one JSX line at each call site: these two
// files are edited by several waves at once, and a line is easier to land than
// a restructure.

import { useT } from "../../lib/i18n";
import {
  doorBreakdownParts,
  scopeLineParts,
  type ScopeCounts,
  type ScopePart,
} from "../../lib/scope";

/** The separator the crew flow already uses between facts on one line. */
const DOT = " · ";

export function ScopeLine({
  counts,
  stories,
  trackingOnly,
  showDoorKinds = false,
  className = "wh-row-sub",
  style,
}: {
  counts: ScopeCounts | null | undefined;
  /** What to SHOW, already decided by storiesToShow() — not the raw column. */
  stories?: number | null;
  trackingOnly?: boolean;
  /** Header only: "(5 sliders · 2 French · 1 bifold)" after the door count. */
  showDoorKinds?: boolean;
  className?: string;
  style?: React.CSSProperties;
}) {
  const t = useT();
  const { parts, trackingOnly: isTracking } = scopeLineParts(counts, {
    stories,
    trackingOnly,
  });
  const say = (p: ScopePart) => t(p.key, { n: p.n });

  if (isTracking) {
    return (
      <div className={className} style={style} data-scope-line="tracking">
        {t("scope.trackingJob")}
      </div>
    );
  }
  // Nothing known yet — a job still loading, or one whose counts failed to
  // read. An empty line is right: the card's own error notice says the rest.
  if (parts.length === 0) return null;

  const doorKinds = showDoorKinds ? doorBreakdownParts(counts) : [];
  const text = parts
    .map((p) =>
      // The door breakdown hangs off the door count itself, so "8 doors (5
      // sliders · 2 French · 1 bifold)" reads as one fact, not two.
      p.key.startsWith("scope.doors.") && doorKinds.length > 0
        ? `${say(p)} (${doorKinds.map(say).join(DOT)})`
        : say(p),
    )
    .join(DOT);

  return (
    <div className={className} style={style} data-scope-line="counts">
      {text}
    </div>
  );
}
