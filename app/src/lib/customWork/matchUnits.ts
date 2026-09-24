// The duplicate check on the blank "New unit" form (crew redesign K1.4 / F4,
// 2026-09-23). The same shape as quickJobs.ts's match for tracking jobs, for
// the same reason: a second person typing "16" on a job that already has a
// unit 16 should JOIN it, not fork a twin the reports then count twice.
//
// Exact match after normalising (case, whitespace) always counts; a
// containment match only from two characters, so typing "1" on a job with
// units 1, 12, 16 and 21 does not light up the whole list. Finished units are
// still matches — the point is to say "this exists", and the card shows its
// state. Pure; unit-tested.

import type { WorkUnit } from "./model";

function norm(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

export function matchingUnits(
  units: readonly WorkUnit[],
  jobId: string | null,
  typedLabel: string,
): WorkUnit[] {
  const typed = norm(typedLabel);
  if (!typed) return [];
  return units.filter((u) => {
    if ((u.project_id ?? null) !== (jobId ?? null)) return false;
    const label = norm(u.label);
    if (label === typed) return true;
    // Containment needs two characters on BOTH sides: "21" must not light up
    // unit "1" any more than "1" lights up unit 21.
    return (
      typed.length >= 2 &&
      label.length >= 2 &&
      (label.includes(typed) || typed.includes(label))
    );
  });
}
