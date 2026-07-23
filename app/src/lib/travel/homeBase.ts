// Home-base rule for deciding whether a job is "out of town" (and therefore a
// candidate for crew travel). Deliberately dead-simple and in ONE place so the
// owner can change it without hunting: compare the project's `site_state`
// against the company's home state. A mismatch ⇒ out of town.
//
// To change the home base, edit HOME_STATE below (use the two-letter postal
// code, e.g. "UT", "TX", "CA"). This is intentionally not a DB setting yet —
// keep it obvious and easy to swap. Full state names also compare correctly as
// long as both sides use the same form.

/** The company's home state (two-letter postal code). Change this to relocate. */
export const HOME_STATE = "UT";

function normalizeState(s: string): string {
  return s.trim().toUpperCase();
}

/**
 * Is a job out of town? Unknown/blank `site_state` returns false so we never
 * nag about jobs we can't classify. Comparison is case/whitespace-insensitive.
 */
export function isOutOfTown(
  siteState: string | null | undefined,
  homeState: string = HOME_STATE,
): boolean {
  if (!siteState || !siteState.trim()) return false;
  return normalizeState(siteState) !== normalizeState(homeState);
}
