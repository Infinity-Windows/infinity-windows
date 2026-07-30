// Whether to offer dispatch to a foreman who has never used it.
//
// Every opening in the company is `planned` and exactly one has an assignee, so
// dispatch reads as unwanted. It is more likely undiscovered: it lives behind a
// toggle a lead has no reason to press on a job that looks finished-ish. This
// puts one line in front of them on the jobs where it would help, and takes it
// away the moment they use it.

export interface NudgeOpening {
  assigned_to: string | null;
  status: string;
}

export interface DispatchNudge {
  /** Openings with work left that nobody owns. */
  unassigned: number;
}

/**
 * Null means show nothing. The bar appears only for a foreman-plus, only when
 * dispatch is closed, and only when not one opening on the job is assigned —
 * so it never nags a lead who is part-way through assigning.
 */
export function dispatchNudge(
  openings: readonly NudgeOpening[],
  opts: { isLead: boolean; dispatchMode: boolean },
): DispatchNudge | null {
  if (!opts.isLead || opts.dispatchMode) return null;
  if (openings.some((o) => o.assigned_to)) return null;

  const unassigned = openings.filter((o) => o.status !== "installed").length;
  return unassigned > 0 ? { unassigned } : null;
}

export function dispatchNudgeText(nudge: DispatchNudge): string {
  return nudge.unassigned === 1
    ? "1 opening isn't assigned to anyone."
    : `${nudge.unassigned} openings aren't assigned to anyone.`;
}
