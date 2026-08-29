// The ledger's scope (wave M, owner ask 2026-08-28): JobMaterials used to be
// ?job=<projectId>-only, which meant a WAITING job — pending_job_name, no
// project row yet — could never be shown at all, even though the owner's
// whole live inventory is waiting-job material. A scope is now either half
// of that union: a real job's id, or a waiting job's typed name. Every read
// on the ledger keys on the same union so the two halves behave identically.

import type { StoragePackage } from "../storage";

export interface MaterialsScope {
  /** A real job's id, or null when the scope is a waiting job instead. */
  projectId: string | null;
  /** A waiting job's typed name, or null when the scope is a real job. */
  pendingName: string | null;
}

/** Read `?job=` / `?pending=` into a scope. Neither present reads as no
 *  scope at all (both null) — the caller shows the picker in that case. */
export function scopeFromParams(params: URLSearchParams): MaterialsScope {
  const job = params.get("job");
  if (job) return { projectId: job, pendingName: null };
  const pending = params.get("pending");
  if (pending) return { projectId: null, pendingName: pending };
  return { projectId: null, pendingName: null };
}

export function hasScope(scope: MaterialsScope): boolean {
  return scope.projectId != null || scope.pendingName != null;
}

/** The union filter every ledger read shares: a real job's own packages, or
 *  an unfiled package typed against this exact waiting-job name. */
export function matchesScope(
  p: Pick<StoragePackage, "project_id" | "pending_job_name">,
  scope: MaterialsScope,
): boolean {
  if (scope.projectId != null) return p.project_id === scope.projectId;
  if (scope.pendingName != null) {
    return p.project_id == null && (p.pending_job_name ?? null) === scope.pendingName;
  }
  return false;
}

/** One stable string per scope — namespaces localStorage keys and lets a
 *  waiting scope key off its name instead of an id it doesn't have
 *  ("pending:<name>"), same prefix `jobTallies` already keys pending jobs by. */
export function scopeKey(scope: MaterialsScope): string {
  if (scope.projectId != null) return scope.projectId;
  if (scope.pendingName != null) return `pending:${scope.pendingName}`;
  return "";
}

/** The ledger link for a scope — every hub row and cross-link uses this so
 *  the URL shape never drifts between callers. */
export function scopeHref(scope: MaterialsScope): string {
  if (scope.projectId != null) return `/warehouse/materials?job=${scope.projectId}`;
  if (scope.pendingName != null) {
    return `/warehouse/materials?pending=${encodeURIComponent(scope.pendingName)}`;
  }
  return "/warehouse/materials";
}

/** The Rewrite-this-set view's link for one mark inside a scope (wave R) —
 *  the single entry point both doors (the ledger's set-level edit and the
 *  tailgate's "Edit set…") now navigate to, instead of each opening its own
 *  inline editor. */
export function rewriteSetHref(scope: MaterialsScope, mark: string): string {
  const base =
    scope.projectId != null
      ? `job=${encodeURIComponent(scope.projectId)}`
      : scope.pendingName != null
        ? `pending=${encodeURIComponent(scope.pendingName)}`
        : "";
  return `/storage/rewrite-set?${base}&mark=${encodeURIComponent(mark)}`;
}

/** Every distinct waiting-job name with unfiled material — the picker's
 *  second option group. Sorted for a stable, scannable list. */
export function distinctPendingJobNames(packages: StoragePackage[]): string[] {
  const names = new Set<string>();
  for (const p of packages) {
    if (p.project_id == null && p.pending_job_name) names.add(p.pending_job_name);
  }
  return [...names].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}
