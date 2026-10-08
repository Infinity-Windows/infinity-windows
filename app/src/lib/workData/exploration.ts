/** Read-only drilldown over an already-reconciled UnitLabor projection.
 * Nothing here recomputes eligibility, payroll, or source evidence — it only
 * filters, facets, and buckets what unitLabor()/reconcileWorkday() already
 * produced. Source taxonomy stays whatever was actually recorded: no field
 * here invents a category/subtype/material/floor value that wasn't stored. */
import { summarizeCohort, type UnitFacts, type UnitLabor } from "./cohorts";
import type { EvidenceClaim, ShiftCoverage } from "./reconcile";

export type Facet = "category" | "subtype" | "material" | "floor";

export interface UnitFilters {
  category?: string | null;
  subtype?: string | null;
  material?: string | null;
  floor?: string | null;
  minArea?: number | null;
  maxArea?: number | null;
  text?: string;
}

export interface UnitMetrics {
  count: number;
  knownAreaSqFt: number;
  paidSeconds: number;
  eligibleCount: number;
  trustedAreaSqFt: number;
  trustedSeconds: number;
  excludedCount: number;
  excludedSeconds: number;
  hoursPerSqFt: number | null;
}

export interface UnitActivityRow {
  activityId: string;
  label: string;
  seconds: number;
  sourceIds: string[];
}

function isBlank(value: string | null): boolean {
  return value === null || value.trim() === "";
}

/** A blank raw string folds into Unknown; a nonblank label (even the literal
 * text "unknown") stays its own distinct value — never merged with missing. */
function normalizeFacetValue(raw: string | null): string | null {
  return isBlank(raw) ? null : raw;
}

function isSetNumber(value: number | null | undefined): value is number {
  return value !== undefined && value !== null;
}

function assertValidAreaBounds(minArea: number | null | undefined, maxArea: number | null | undefined): void {
  const checkBound = (value: number, label: string) => {
    if (!Number.isFinite(value) || value < 0) throw new Error(`${label} must be a finite area of 0 or more square feet.`);
  };
  if (isSetNumber(minArea)) checkBound(minArea, "Minimum area");
  if (isSetNumber(maxArea)) checkBound(maxArea, "Maximum area");
  if (isSetNumber(minArea) && isSetNumber(maxArea) && maxArea < minArea) {
    throw new Error("Maximum area must be greater than or equal to minimum area.");
  }
}

function matchesFacet(raw: string | null, filter: string | null | undefined): boolean {
  if (filter === undefined) return true;
  if (filter === null) return isBlank(raw);
  return raw === filter;
}

function matchesText(unit: UnitFacts, text: string): boolean {
  const fields: Array<string | null> = [unit.label, unit.category, unit.subtype, unit.material, unit.floor];
  return fields.some(value => value !== null && value.toLowerCase().includes(text));
}

/** Narrows the selected unit set only. Never alters payroll/source records or
 * hides excluded labor — exclusions still ride along on the returned rows. */
export function filterUnits(rows: readonly UnitLabor[], filters: UnitFilters): UnitLabor[] {
  assertValidAreaBounds(filters.minArea, filters.maxArea);
  const bounded = isSetNumber(filters.minArea) || isSetNumber(filters.maxArea);
  const text = filters.text?.trim().toLowerCase();
  return rows.filter(row => {
    if (!matchesFacet(row.unit.category, filters.category)) return false;
    if (!matchesFacet(row.unit.subtype, filters.subtype)) return false;
    if (!matchesFacet(row.unit.material, filters.material)) return false;
    if (!matchesFacet(row.unit.floor, filters.floor)) return false;
    if (bounded) {
      if (row.areaSqFt === null) return false;
      if (isSetNumber(filters.minArea) && row.areaSqFt < filters.minArea) return false;
      if (isSetNumber(filters.maxArea) && row.areaSqFt > filters.maxArea) return false;
    }
    if (text && !matchesText(row.unit, text)) return false;
    return true;
  });
}

/** Distinct actual source values for a facet, Unknown last. No taxonomy is
 * hard-coded — this enumerates whatever the units in `rows` actually carry. */
export function facetValues(rows: readonly UnitLabor[], field: Facet): Array<string | null> {
  const values = new Set<string | null>();
  for (const row of rows) values.add(normalizeFacetValue(row.unit[field]));
  const named = [...values].filter((v): v is string => v !== null).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return values.has(null) ? [...named, null] : named;
}

function assertUniqueUnits(rows: readonly UnitLabor[]): void {
  const seen = new Set<string>();
  for (const row of rows) {
    if (seen.has(row.unit.id)) throw new Error("Duplicate canonical unit. Refresh the report.");
    seen.add(row.unit.id);
  }
}

function computeUnitMetrics(rows: readonly UnitLabor[]): UnitMetrics {
  const cohort = summarizeCohort(rows);
  return {
    count: rows.length,
    knownAreaSqFt: rows.reduce((sum, row) => sum + (row.areaSqFt ?? 0), 0),
    paidSeconds: rows.reduce((sum, row) => sum + row.paidSeconds, 0),
    eligibleCount: cohort.eligibleIds.length,
    trustedAreaSqFt: cohort.areaSqFt,
    trustedSeconds: cohort.paidSeconds,
    excludedCount: rows.length - cohort.eligibleIds.length,
    excludedSeconds: cohort.excludedSeconds,
    hoursPerSqFt: cohort.hoursPerSqFt,
  };
}

function computeExclusionReasons(rows: readonly UnitLabor[]): Array<{ reason: string; count: number; seconds: number }> {
  const byReason = new Map<string, { count: number; seconds: number }>();
  for (const row of rows) {
    if (row.eligible) continue;
    for (const reason of new Set(row.exclusions)) {
      const entry = byReason.get(reason) ?? { count: 0, seconds: 0 };
      entry.count += 1;
      entry.seconds += row.paidSeconds;
      byReason.set(reason, entry);
    }
  }
  return [...byReason.entries()]
    .map(([reason, totals]) => ({ reason, ...totals }))
    .sort((a, b) => (a.reason < b.reason ? -1 : a.reason > b.reason ? 1 : 0));
}

/** `paidSeconds` is operational labor for every selected unit, trusted or
 * not. `trustedAreaSqFt`/`trustedSeconds` reuse summarizeCohort's exact
 * eligible numerator and denominator. Exclusion reasons overlap by design —
 * a unit with two reasons counts once under each, but its seconds are never
 * folded into any total above beyond its own single contribution. */
export function summarizeUnits(
  rows: readonly UnitLabor[],
): UnitMetrics & { reasons: Array<{ reason: string; count: number; seconds: number }> } {
  assertUniqueUnits(rows);
  return { ...computeUnitMetrics(rows), reasons: computeExclusionReasons(rows) };
}

/** Each unit lands in exactly one recorded bucket (or explicit Unknown), so
 * bucket totals always reconcile to summarizeUnits() of the same input —
 * there is no General/overhead row here to allocate across buckets. */
export function groupUnitMetrics(rows: readonly UnitLabor[], field: Facet): Array<UnitMetrics & { value: string | null }> {
  assertUniqueUnits(rows);
  const buckets = new Map<string | null, UnitLabor[]>();
  for (const row of rows) {
    const value = normalizeFacetValue(row.unit[field]);
    const bucket = buckets.get(value);
    if (bucket) bucket.push(row);
    else buckets.set(value, [row]);
  }
  return facetValues(rows, field).map(value => ({ value, ...computeUnitMetrics(buckets.get(value) ?? []) }));
}

/** Only single-source, unambiguous Specific paid slices matched to a
 * selected canonical unit — the identical restriction unitLabor() applies,
 * broken out by activityId+label instead of summed into one total. The same
 * activityId under a different historical label stays its own row; a
 * multi-source (conflicted) slice is never attributed to anyone here, same
 * as it never reaches unitLabor()'s paidSeconds. */
export function unitActivityRows(
  rows: readonly UnitLabor[],
  claims: readonly EvidenceClaim[],
  coverage: readonly ShiftCoverage[],
): Map<string, UnitActivityRow[]> {
  assertUniqueUnits(rows);
  const sources = new Map(claims.map(c => [c.sourceId, c]));
  type ActivityGroup = { activityId: string; label: string; seconds: number; sourceIds: Set<string> };
  const byUnit = new Map(rows.map(row => [row.unit.id, new Map<string, ActivityGroup>()]));
  // Walk paid slices once; scanning every shift again for each selected unit
  // would make a large job's read-only drilldown unnecessarily expensive.
  for (const shift of coverage) for (const slice of shift.slices) {
    if (slice.kind !== "specific" || slice.sourceIds.length !== 1) continue;
    const sourceClaim = sources.get(slice.sourceIds[0]);
    if (!sourceClaim || sourceClaim.unitId === null) continue;
    const groups = byUnit.get(sourceClaim.unitId);
    if (!groups) continue;
    const key = JSON.stringify([sourceClaim.activityId, sourceClaim.label]);
    const group = groups.get(key) ?? { activityId: sourceClaim.activityId,
      label: sourceClaim.label, seconds: 0, sourceIds: new Set<string>() };
    group.seconds += slice.seconds;
    group.sourceIds.add(slice.sourceIds[0]);
    groups.set(key, group);
  }
  return new Map([...byUnit].map(([unitId, groups]) => [unitId, [...groups.values()]
    .map(g => ({ activityId: g.activityId, label: g.label, seconds: g.seconds, sourceIds: [...g.sourceIds].sort() }))
    .sort((a, b) => a.activityId !== b.activityId
      ? a.activityId < b.activityId ? -1 : 1
      : a.label < b.label ? -1 : a.label > b.label ? 1 : 0)]));
}
