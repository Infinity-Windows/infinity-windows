import { roleRank } from "../install/types";

// The UI half of the two-layer financials gate. Layer 1 is the strict
// owner-only RLS policy on `vehicle_financials` (hard security). Layer 2 is this
// pure predicate: show the financials section ONLY when the caller's TRUE role
// is owner AND they are not previewing another role — so "view as installer"
// faithfully hides the money exactly like a real installer would see it.

export interface FinancialsGateInput {
  /** The real signed-in user's role (never a previewed/client role). */
  realRole: string | null | undefined;
  /** Whether a supervisor+ is currently previewing another role. */
  isPreviewing: boolean;
}

/** True only for a real owner who is not previewing another role. */
export function canSeeFinancials({ realRole, isPreviewing }: FinancialsGateInput): boolean {
  if (isPreviewing) return false;
  return roleRank(realRole) >= 3;
}
