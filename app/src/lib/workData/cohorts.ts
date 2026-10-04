import type { EvidenceClaim, ShiftCoverage } from "./reconcile";

export interface UnitFacts {
  id: string; label: string; category: string | null; subtype: string | null;
  material: string | null; floor: string | null; widthIn: number | null; heightIn: number | null;
  dimensionSource: string | null; dimensionsVerified: boolean; complete: boolean;
  qcAccepted: boolean; hasUntimedEvidence: boolean;
}
export interface UnitLabor {
  unit: UnitFacts; areaSqFt: number | null; paidSeconds: number; rawSourceIds: string[];
  exclusions: string[]; eligible: boolean;
}
/** Area is counted once by canonical unit, independent of helpers and stages.
 * Only an unambiguous paid slice contributes attributed labor. Raw source
 * durations remain drilldown evidence, never a second labor total. */
export function unitLabor(units: readonly UnitFacts[], claims: readonly EvidenceClaim[], coverage: readonly ShiftCoverage[]): UnitLabor[] {
  const seen = new Set<string>();
  const sources = new Map(claims.map(c => [c.sourceId, c]));
  return units.map(unit => {
    if (seen.has(unit.id)) throw new Error("Duplicate canonical unit. Refresh the report.");
    seen.add(unit.id);
    const rows = claims.filter(c => c.unitId === unit.id);
    const exclusions = new Set<string>();
    const area = unit.widthIn !== null && unit.heightIn !== null && Number.isFinite(unit.widthIn) &&
      Number.isFinite(unit.heightIn) && unit.widthIn > 0 && unit.heightIn > 0 ? unit.widthIn * unit.heightIn / 144 : null;
    if (area === null || !Number.isFinite(area)) exclusions.add("dimensions_missing");
    if (!unit.dimensionsVerified || !unit.dimensionSource) exclusions.add("dimensions_unverified");
    if (!unit.complete) exclusions.add("incomplete");
    if (!unit.qcAccepted) exclusions.add("qc_not_accepted");
    if (unit.hasUntimedEvidence) exclusions.add("untimed_evidence");
    if (rows.some(c => c.rework)) exclusions.add("rework");
    if (rows.some(c => c.pending || c.unresolved)) exclusions.add("unresolved_evidence");
    let seconds = 0;
    const matched = new Set<string>();
    for (const shift of coverage) {
      const related = rows.filter(c => c.profileId === shift.shift.profileId &&
        (c.shiftId === shift.shift.id || (c.shiftId === null && c.projectId === shift.shift.projectId &&
          Date.parse(c.startedAt) < Date.parse(shift.shift.endedAt ?? "9999-01-01") &&
          Date.parse(c.endedAt ?? "9999-01-01") > Date.parse(shift.shift.startedAt))));
      if (!related.length) continue;
      related.forEach(c => matched.add(c.sourceId));
      if (shift.provisional || shift.shift.status !== "approved") exclusions.add("payroll_not_approved");
      if (!shift.breakPlacementKnown || shift.conflictSeconds > 0 || shift.unknownSeconds > 0 || shift.issues.length > 0) exclusions.add("coverage_exception");
      for (const slice of shift.slices) {
        if (slice.kind !== "specific" || slice.sourceIds.length !== 1) continue;
        if (sources.get(slice.sourceIds[0])?.unitId === unit.id) seconds += slice.seconds;
      }
    }
    if (rows.some(c => !matched.has(c.sourceId))) exclusions.add("outside_payroll");
    if (seconds === 0) exclusions.add("no_attributed_labor");
    return { unit, areaSqFt: area !== null && Number.isFinite(area) ? area : null, paidSeconds: seconds,
      rawSourceIds: rows.map(c => c.sourceId), exclusions: [...exclusions], eligible: exclusions.size === 0 };
  });
}

/** Numerator and denominator are built from the exact same eligible units. */
export function summarizeCohort(rows: readonly UnitLabor[]) {
  const eligible = rows.filter(r => r.eligible);
  const areaSqFt = eligible.reduce((n, r) => n + r.areaSqFt!, 0);
  const paidSeconds = eligible.reduce((n, r) => n + r.paidSeconds, 0);
  const floorArea = new Map<string, number>();
  for (const row of rows) if (row.areaSqFt !== null) {
    const floor = row.unit.floor?.trim() || "unknown";
    floorArea.set(floor, (floorArea.get(floor) ?? 0) + row.areaSqFt);
  }
  return { eligibleIds: eligible.map(r => r.unit.id), areaSqFt, paidSeconds,
    hoursPerSqFt: areaSqFt > 0 ? paidSeconds / 3600 / areaSqFt : null,
    excludedSeconds: rows.filter(r => !r.eligible).reduce((n, r) => n + r.paidSeconds, 0), floorArea };
}
