import { cloneJson, postgresInstantMicros, uuid } from "../workConfiguration/model";

export class TotalsUnavailableError extends Error {
  constructor() { super("Activity totals are unavailable. Refresh to check the current records."); this.name = "TotalsUnavailableError"; }
}
export interface TotalsQuantity { state: "known" | "partial"; microseconds: string | null; knownMicros: string }
export interface TotalsActivity {
  definitionId: string; definitionVersionId: string; definitionVersion: number;
  scope: "general" | "specific"; labelEn: string; labelEs: string; retired: boolean;
  personal: TotalsQuantity & { includesLive: boolean }; scopeTotal: TotalsQuantity;
  machineSubsets: { machineKind: string; microseconds: string }[];
}
export interface TotalsReconciliation {
  scope: "personal" | "authorized_scope";
  unresolvedScope: boolean; ledgerCount: number; grossMicros: string | null; payrollMicros: string | null;
  classifiedMicros: string; setupMicros: string; unclassifiedMicros: string; breakElapsedMicros: string;
  breakDeductionMicros: string; policyAdjustmentMicros: string; issues: string[];
}
export type TotalsCohort = { availability: "unavailable"; reason: "unit_selection_required" | "role_restricted" }
  | { availability: "available"; unitId: string; eligible: boolean; exclusions: string[]; actualLaborMicros: string;
      excludedLaborMicros: string; eligibleUnitIds: string[]; laborNumeratorMicros: string;
      areaSquareFeetNumerator: string; areaSquareFeetDenominator: string;
      dimensionSource: "measured" | "plans" | "estimated" | null; dimensionVerification: "unverified" | "verified" | "noncurrent";
      floor: { state: "unallocated"; label: string | null; areaCountedOnce: true }; generalOverheadIncluded: false };
export interface TotalsView {
  asOf: string; actorId: string; projectId: string; unitId: string | null;
  window: { kind: "all_retained_selected_scope"; from: null; until: string; personalScope: "actual_actor_selected_scope" };
  complete: boolean; personalComplete: boolean; activities: TotalsActivity[];
  scopeKnownMicros: string; personalKnownMicros: string; reconciliation: TotalsReconciliation; cohort: TotalsCohort;
}
export type TotalsReply = { protocolVersion: 1; availability: "unavailable"; totals: null }
  | { protocolVersion: 1; availability: "available"; totals: TotalsView };
const fail = (): never => { throw new TotalsUnavailableError(); };
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== keys.length || keys.some(k => !Object.hasOwn(value, k))) return fail();
  return value as Record<string, unknown>;
}
function bool(value: unknown): boolean { return typeof value === "boolean" ? value : fail(); }
function text(value: unknown, max = 500): string {
  return typeof value === "string" && value.length <= max && !value.includes("\0") ? value : fail();
}
function integer(value: unknown, min: number, max: number): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max ? value : fail();
}
function amount(value: unknown, signed = false): bigint {
  if (typeof value !== "string" || !(signed ? /^(?:0|-?[1-9][0-9]{0,39})$/ : /^(?:0|[1-9][0-9]{0,39})$/).test(value)) return fail();
  return BigInt(value);
}
function decimal(value: unknown): string {
  if (typeof value !== "string" || value.length > 220 || !/^(?:0|[1-9][0-9]*)(?:\.[0-9]*[1-9])?$/.test(value)) return fail();
  return value;
}
function strings(value: unknown, max: number): string[] {
  if (!Array.isArray(value) || value.length > max) return fail();
  const rows = value.map(v => text(v)); if (new Set(rows).size !== rows.length) return fail(); return rows;
}
function id(value: unknown): string { return uuid(value).toLowerCase(); }
function timestamp(value: unknown): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/.test(value)) return fail();
  postgresInstantMicros(value); return value;
}
function quantity(raw: unknown, personal: boolean, complete: boolean): bigint {
  const q = object(raw, ["state", "microseconds", "knownMicros", ...(personal ? ["includesLive"] : [])]);
  const known = amount(q.knownMicros);
  if (q.state !== (complete ? "known" : "partial") || (complete ? q.microseconds !== q.knownMicros : q.microseconds !== null)) return fail();
  if (personal) bool(q.includesLive);
  return known;
}
/** Exact server values are preserved. Partial/absent data never becomes zero,
 * and one selected unit cannot pretend to be a job-wide trusted cohort.
 * The shared plain-JSON clone also enforces the client's bounded memory limit. */
export function parseTotalsReply(raw: unknown, projectId: string, unitId: string | null, actorId: string): TotalsReply {
  try {
    const expectedProject = id(projectId), expectedUnit = unitId === null ? null : id(unitId), expectedActor = id(actorId);
    const copy = cloneJson(raw), reply = object(copy, ["protocolVersion", "availability", "totals"]);
    if (reply.protocolVersion !== 1) return fail();
    if (reply.availability === "unavailable") { if (reply.totals !== null) return fail(); return copy as TotalsReply; }
    if (reply.availability !== "available") return fail();
    const t = object(reply.totals, ["asOf", "actorId", "projectId", "unitId", "window", "complete", "personalComplete", "activities", "scopeKnownMicros", "personalKnownMicros", "reconciliation", "cohort"]);
    if (id(t.actorId) !== expectedActor || id(t.projectId) !== expectedProject || (t.unitId === null ? null : id(t.unitId)) !== expectedUnit) return fail();
    const asOf = timestamp(t.asOf), window = object(t.window, ["kind", "from", "until", "personalScope"]);
    if (window.kind !== "all_retained_selected_scope" || window.from !== null || window.until !== asOf || window.personalScope !== "actual_actor_selected_scope") return fail();
    const complete = bool(t.complete), personalComplete = bool(t.personalComplete);
    if (complete && !personalComplete) return fail();
    if (!Array.isArray(t.activities) || t.activities.length > 5000) return fail();
    let scopeSum = 0n, personalSum = 0n, liveRows = 0;
    const versions = new Set<string>();
    for (const rawActivity of t.activities) {
      const a = object(rawActivity, ["definitionId", "definitionVersionId", "definitionVersion", "scope", "labelEn", "labelEs", "retired", "personal", "scopeTotal", "machineSubsets"]);
      id(a.definitionId); const version = id(a.definitionVersionId);
      if (versions.has(version)) return fail(); versions.add(version);
      integer(a.definitionVersion, 1, Number.MAX_SAFE_INTEGER); text(a.labelEn); text(a.labelEs); bool(a.retired);
      if (a.scope !== (expectedUnit === null ? "general" : "specific")) return fail();
      const personal = quantity(a.personal, true, personalComplete), scope = quantity(a.scopeTotal, false, complete);
      if ((a.personal as Record<string, unknown>).includesLive && ++liveRows > 1) return fail();
      if (personal > scope) return fail(); personalSum += personal; scopeSum += scope;
      if (!Array.isArray(a.machineSubsets) || a.machineSubsets.length > 100) return fail();
      const kinds = new Set<string>(); let machineSum = 0n;
      for (const rawMachine of a.machineSubsets) {
        const m = object(rawMachine, ["machineKind", "microseconds"]), kind = text(m.machineKind, 100);
        if (!kind.trim() || kinds.has(kind)) return fail(); kinds.add(kind); machineSum += amount(m.microseconds);
      }
      if (machineSum > scope) return fail();
    }
    if (amount(t.scopeKnownMicros) !== scopeSum || amount(t.personalKnownMicros) !== personalSum) return fail();
    const r = object(t.reconciliation, ["scope", "unresolvedScope", "ledgerCount", "grossMicros", "payrollMicros", "classifiedMicros", "setupMicros", "unclassifiedMicros", "breakElapsedMicros", "breakDeductionMicros", "policyAdjustmentMicros", "issues"]);
    if (r.scope !== "personal" && r.scope !== "authorized_scope") return fail();
    const unresolved = bool(r.unresolvedScope); integer(r.ledgerCount, 0, 500); strings(r.issues, 100);
    const classified = amount(r.classifiedMicros), setup = amount(r.setupMicros), gap = amount(r.unclassifiedMicros), elapsed = amount(r.breakElapsedMicros), deduction = amount(r.breakDeductionMicros);
    if (amount(r.policyAdjustmentMicros, true) !== elapsed - deduction || (unresolved && complete)) return fail();
    if (r.grossMicros !== null && amount(r.grossMicros) !== classified + setup + gap + elapsed) return fail();
    if (r.payrollMicros !== null) {
      const paid = amount(r.payrollMicros, true);
      if (r.grossMicros !== null && paid !== amount(r.grossMicros) - deduction) return fail();
    }
    const c = t.cohort as Record<string, unknown>;
    if (!c || typeof c !== "object") return fail();
    if (c.availability === "unavailable") {
      object(c, ["availability", "reason"]);
      if (c.reason !== (expectedUnit === null ? "unit_selection_required" : "role_restricted")) return fail();
    } else {
      object(c, ["availability", "unitId", "eligible", "exclusions", "actualLaborMicros", "excludedLaborMicros", "eligibleUnitIds", "laborNumeratorMicros", "areaSquareFeetNumerator", "areaSquareFeetDenominator", "dimensionSource", "dimensionVerification", "floor", "generalOverheadIncluded"]);
      if (c.availability !== "available" || expectedUnit === null || id(c.unitId) !== expectedUnit) return fail();
      const eligible = bool(c.eligible), exclusions = strings(c.exclusions, 100);
      const actual = amount(c.actualLaborMicros), excluded = amount(c.excludedLaborMicros), labor = amount(c.laborNumeratorMicros);
      if (actual !== scopeSum || excluded !== (eligible ? 0n : actual) || labor !== (eligible ? actual : 0n)) return fail();
      if (!Array.isArray(c.eligibleUnitIds) || c.eligibleUnitIds.length !== (eligible ? 1 : 0) || (eligible && id(c.eligibleUnitIds[0]) !== expectedUnit)) return fail();
      const area = decimal(c.areaSquareFeetNumerator); if (amount(c.areaSquareFeetDenominator) <= 0n) return fail();
      if (!["measured", "plans", "estimated", null].includes(c.dimensionSource as string | null) || !["unverified", "verified", "noncurrent"].includes(c.dimensionVerification as string)) return fail();
      if (eligible ? r.scope !== "authorized_scope" || !complete || actual <= 0n || area === "0" || exclusions.length !== 0 || c.dimensionVerification !== "verified" || gap !== 0n || amount(r.policyAdjustmentMicros, true) !== 0n : area !== "0" || exclusions.length === 0) return fail();
      const floor = object(c.floor, ["state", "label", "areaCountedOnce"]);
      if (floor.state !== "unallocated" || floor.areaCountedOnce !== true || c.generalOverheadIncluded !== false) return fail();
      if (floor.label !== null) text(floor.label);
    }
    return copy as TotalsReply;
  } catch { return fail(); }
}
