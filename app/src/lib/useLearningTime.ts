// The one line a Learn screen adds to be counted: `useLearningTime("tab", tab)`.
//
// Everything interesting is in learningTime.ts — the gate, the cadence, the
// clamps, and the reason there is no outbox. This is the React wrapper, and it
// is deliberately thin so the rules stay testable without a DOM.

import { useEffect } from "react";
import {
  screenIsActive,
  sendLearningHeartbeat,
  startHeartbeats,
  subscribeToScreenActivity,
  type LearningItemKind,
} from "./learningTime";

/**
 * Record time on one Learn item for as long as this component is mounted AND
 * the screen is in front of somebody.
 *
 * `key` may be null or empty — a tab whose id is not known yet, a term sheet
 * with nothing open — and the hook simply does nothing until it is real. That
 * matters because the alternative is a row keyed 'undefined' in the owner's
 * table.
 *
 * A change of key ends one item's beat and starts the next; the row for the
 * item just left keeps its seconds, because rows are per (visit, item) and a
 * person coming back to it adds to the same row.
 */
export function useLearningTime(
  kind: LearningItemKind,
  key: string | null | undefined,
): void {
  useEffect(() => {
    const item = (key ?? "").trim();
    if (!item) return;

    // The scheduler goes FIRST, and the order matters: subscribing is what
    // tells the idle clock somebody just arrived here (see
    // subscribeToScreenActivity). Asking screenIsActive before that would ask
    // it about a page nobody had touched since whatever they were doing an
    // hour ago on another screen.
    const stop = startHeartbeats({
      isActive: screenIsActive,
      subscribe: subscribeToScreenActivity,
      onBeat: (seconds) => void sendLearningHeartbeat(kind, item, seconds),
    });

    // Then one beat straight away, worth zero seconds, IF the screen is really
    // in front of somebody. It opens the row, so a visit that ends before the
    // first full interval still shows up as a visit rather than vanishing —
    // the difference between "opened the glossary and left" and "never opened
    // it", which is exactly the kind of difference the owner is asking about.
    // It is also the beat that plants the server's marker, so the first real
    // one fifteen seconds later is credited in full.
    // Gated like every other beat: a screen mounted behind a locked phone was
    // not opened by anybody.
    if (screenIsActive()) void sendLearningHeartbeat(kind, item, 0);

    return stop;
  }, [kind, key]);
}
