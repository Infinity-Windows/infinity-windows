// Pure helpers for pre-issuing unit IDs from a project's plan-set.
//
// The rule mirrors the `preissue_project_units` RPC so the UI can show the
// same expected-vs-issued math before calling the database, and so the core
// calculation is unit-testable without a DB connection.

export interface PlannedNeed {
  window_type_id: string;
  quantity: number;
}

export interface ExistingUnit {
  window_type_id: string;
}

/**
 * Units to pre-issue for one type = planned quantity - existing count, never
 * negative. If more units already exist than planned (over-delivery), we issue 0.
 */
export function unitsToIssueForType(planned: number, existing: number): number {
  return Math.max(0, planned - existing);
}

export interface PreissuePlanRow {
  window_type_id: string;
  planned: number;
  existing: number;
  toIssue: number;
}

/**
 * Compute the pre-issue plan across every planned type for a project: how many
 * units are planned, how many already exist (in ANY status), and how many new
 * IDs a pre-issue run would create.
 */
export function computePreissuePlan(
  needs: PlannedNeed[],
  units: ExistingUnit[],
): PreissuePlanRow[] {
  return needs.map((n) => {
    const existing = units.filter(
      (u) => u.window_type_id === n.window_type_id,
    ).length;
    return {
      window_type_id: n.window_type_id,
      planned: n.quantity,
      existing,
      toIssue: unitsToIssueForType(n.quantity, existing),
    };
  });
}

/** Total planned quantity across all types. */
export function totalPlanned(plan: PreissuePlanRow[]): number {
  return plan.reduce((sum, r) => sum + r.planned, 0);
}

/** Total units that already have IDs across all types. */
export function totalExisting(plan: PreissuePlanRow[]): number {
  return plan.reduce((sum, r) => sum + r.existing, 0);
}

/** Total number of new units a pre-issue run would create. */
export function totalToIssue(plan: PreissuePlanRow[]): number {
  return plan.reduce((sum, r) => sum + r.toIssue, 0);
}
