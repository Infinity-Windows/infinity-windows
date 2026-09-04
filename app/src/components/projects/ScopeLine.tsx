// "40 openings · 32 windows · 8 doors · 2 stories" — wave X (X4).
//
// One line, two lengths. The job card gets the short one; the job header gets
// the same line plus which doors, in brackets, on every tab. Both read the same
// counted-in-the-database row (project_scope_counts) and the same pure rules
// (lib/scope.ts), so every COUNT on a card matches the header it opens.
//
// STOREYS ARE THE ONE EXCEPTION, and it is deliberate. `storiesToShow()` prefers
// a traced 3D model's own storey count over the number typed on the job form,
// and answering it needs that job's model — a row of `project_plan_outlines`
// carrying the whole traced building as JSON. The header reads one, for the one
// job it is showing. The jobs list will NOT read one per card: pulling every
// listed job's model down to a phone is precisely the whole-table read this
// wave existed to delete, and it is the heaviest JSON in the app. So a card
// shows the typed number, and a job whose traced model disagrees with its form
// reads one number on the list and the surveyed one when you open it.
//
// If that ever needs to go away, the fix is a storey count carried on
// project_scope_counts — not an outline fetch on the list. It was left alone
// here because computing it in SQL would put `preferModelOutline`, `fitviewModel`
// and `storiesOf` in a second home, which is the bug wave X's own review found
// in the Studio.
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
  /**
   * What to SHOW. The job header passes `storiesToShow(outlines, typed)`; a job
   * card passes the typed `projects.stories` column, because the list does not
   * read every job's traced model (see the note at the top of this file).
   */
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
