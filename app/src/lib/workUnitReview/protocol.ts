import { cloneJson, postgresInstantMicros, uuid as validateUuid } from "../workConfiguration/model";

export class UnitReviewProtocolError extends Error {
  constructor() { super("Unit review is unavailable. Refresh before another action."); this.name = "UnitReviewProtocolError"; }
}
function fail(): never { throw new UnitReviewProtocolError(); }
const ACTIONS = ["verify_dimensions", "submit", "pass", "fail", "claim_resolved", "reopen"] as const;
export type ReviewAction = typeof ACTIONS[number];
export type DimensionUnit = "in" | "ft" | "mm" | "cm";
export interface ReviewBasis {
  unitId: string; unitRevision: number; factId: string; factRevision: number; scopeToken: string;
  reviewRevision: number; submissionId: string | null; generation: number;
}
export interface ReviewObservation {
  observerId: string | null; source: "measured" | "plans" | "estimated";
  widthDecimal: string; heightDecimal: string; unit: DimensionUnit; sourceReference: string | null;
}
export interface ReviewDefect { id: string; summary: string; state: "open" | "claimed_resolved" | "verified_resolved" }
export interface ReviewView {
  basis: ReviewBasis | null; basisStatus: "current" | "stale" | "unavailable";
  capabilities: { verifyDimensions: boolean; submit: boolean; pass: boolean; fail: boolean; claimResolved: boolean; reopen: boolean };
  observation: ReviewObservation | null;
  dimensionVerification: { state: "unverified" | "verified" | "noncurrent"; verificationId: string | null };
  qc: { state: "not_submitted" | "awaiting_review" | "passed" | "failed";
    acceptance: "accepted" | "not_accepted" | "recorded_only" | "noncurrent"; lifecycle: "proven" | "unproven"; qcAccepted: boolean };
  work: { availability: "available" | "unavailable"; activeCount: number | null; pendingCount: number | null };
  defects: ReviewDefect[];
}
export type ReviewReply = { protocolVersion: 1; asOf: string; availability: "available"; review: ReviewView }
  | { protocolVersion: 1; asOf: string; availability: "unavailable"; review: null };
export interface ReviewReceipt {
  protocolVersion: 1; commandId: string; action: ReviewAction; unitId: string; eventId: string;
  reviewRevision: number; generation: number; submissionId: string | null; recordedAt: string; outcome: "applied";
}
export interface ReviewCancellation {
  protocolVersion: 1; commandId: string; action: ReviewAction; unitId: string;
  recordedAt: string; outcome: "cancelled"; original: ReviewPayload;
}
export type ReviewStoredReceipt = ReviewReceipt | ReviewCancellation;
export type ReviewReceiptReply = { protocolVersion: 1; availability: "available"; receipt: ReviewStoredReceipt }
  | { protocolVersion: 1; availability: "unavailable"; receipt: null };
export type ReviewPayload = { action: "verify_dimensions"; basis: ReviewBasis; data: {
  widthDecimal: string; heightDecimal: string; unit: DimensionUnit; source: "measured" | "plans"; sourceReference: string | null } }
  | { action: "submit" | "pass" | "reopen"; basis: ReviewBasis; data: { note: string | null } }
  | { action: "fail"; basis: ReviewBasis; data: { note: string; defects: { id: string; summary: string }[] } }
  | { action: "claim_resolved"; basis: ReviewBasis; data: { note: string | null; defectIds: string[] } };

function object(raw: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return fail();
  const value = raw as Record<string, unknown>;
  if (Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) return fail();
  return value;
}
function integer(value: unknown, min = 0): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= min ? value : fail();
}
function boolean(value: unknown): boolean { return typeof value === "boolean" ? value : fail(); }
function oneOf<T extends string>(value: unknown, values: readonly T[]): T {
  return typeof value === "string" && values.includes(value as T) ? value as T : fail();
}
function text(value: unknown, max: number, nonblank = false): string {
  if (typeof value !== "string" || [...value].length > max || value.includes("\0") || nonblank && !value.trim()) return fail();
  // JSON may carry lone UTF-16 surrogates; PostgreSQL UTF-8 cannot.
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) { const next = value.charCodeAt(++i); if (!(next >= 0xdc00 && next <= 0xdfff)) fail(); }
    else if (code >= 0xdc00 && code <= 0xdfff) fail();
  }
  return value;
}
const nullableText = (value: unknown, max: number, nonblank = false) => value === null ? null : text(value, max, nonblank);
// PostgreSQL uuid values and normalized JSON requests use lowercase spelling.
// Canonicalize before identity comparisons and duplicate checks as SQL does.
const uuid = (value: unknown) => validateUuid(value).toLowerCase();
const nullableUuid = (value: unknown) => value === null ? null : uuid(value);
function utc(value: unknown): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/.test(value)) return fail();
  postgresInstantMicros(value); return value;
}
function boundedClone(raw: unknown, bytes: number): unknown {
  const copy = cloneJson(raw);
  if (new TextEncoder().encode(JSON.stringify(copy)).byteLength > bytes) fail();
  return copy;
}
/** Exact text only: no Number conversion, exponent spelling, or input rounding. */
export function canonicalReviewDecimal(raw: unknown): string {
  if (typeof raw !== "string" || raw.length > 100 || !/^[0-9]+(?:\.[0-9]+)?$/.test(raw)) return fail();
  const [whole, fraction = ""] = raw.split(".");
  const integerPart = whole.replace(/^0+(?=\d)/, ""), fractionalPart = fraction.replace(/0+$/, "");
  const value = integerPart + (fractionalPart ? "." + fractionalPart : "");
  if (value === "0") return fail();
  return value;
}
function dimensionUnit(raw: unknown): DimensionUnit { return oneOf(raw, ["in", "ft", "mm", "cm"]); }
function boundedDimension(value: string, unit: DimensionUnit): void {
  const [whole, fraction = ""] = value.split(".");
  const amount = BigInt(whole + fraction), scale = 10n ** BigInt(fraction.length);
  const [numerator, denominator] = { in: [1n, 1n], ft: [12n, 1n], mm: [5n, 127n], cm: [50n, 127n] }[unit];
  if (amount * numerator > 100000n * scale * denominator) fail();
}
function parseBasis(raw: unknown, expectedUnitId?: string): ReviewBasis {
  const b = object(raw, ["unitId", "unitRevision", "factId", "factRevision", "scopeToken", "reviewRevision", "submissionId", "generation"]);
  const unitId = uuid(b.unitId);
  if (expectedUnitId !== undefined && unitId !== expectedUnitId) fail();
  if (typeof b.scopeToken !== "string" || !/^ur1:[0-9a-f]{64}$/.test(b.scopeToken)) fail();
  return { unitId, unitRevision: integer(b.unitRevision), factId: uuid(b.factId), factRevision: integer(b.factRevision, 1),
    scopeToken: b.scopeToken, reviewRevision: integer(b.reviewRevision), submissionId: nullableUuid(b.submissionId), generation: integer(b.generation) };
}
function parseObservation(raw: unknown): ReviewObservation | null {
  if (raw === null) return null;
  const o = object(raw, ["observerId", "source", "widthDecimal", "heightDecimal", "unit", "sourceReference"]);
  const widthDecimal = canonicalReviewDecimal(o.widthDecimal), heightDecimal = canonicalReviewDecimal(o.heightDecimal), unit = dimensionUnit(o.unit);
  if (widthDecimal !== o.widthDecimal || heightDecimal !== o.heightDecimal) fail();
  boundedDimension(widthDecimal, unit); boundedDimension(heightDecimal, unit);
  return { observerId: nullableUuid(o.observerId), source: oneOf(o.source, ["measured", "plans", "estimated"]),
    widthDecimal, heightDecimal, unit, sourceReference: nullableText(o.sourceReference, 1000, true) };
}
function parseView(raw: unknown, unitId: string): ReviewView {
  const v = object(raw, ["basis", "basisStatus", "capabilities", "observation", "dimensionVerification", "qc", "work", "defects"]);
  const basis = v.basis === null ? null : parseBasis(v.basis, unitId), basisStatus = oneOf(v.basisStatus, ["current", "stale", "unavailable"]);
  const c = object(v.capabilities, ["verifyDimensions", "submit", "pass", "fail", "claimResolved", "reopen"]);
  const capabilities = { verifyDimensions: boolean(c.verifyDimensions), submit: boolean(c.submit), pass: boolean(c.pass),
    fail: boolean(c.fail), claimResolved: boolean(c.claimResolved), reopen: boolean(c.reopen) };
  if ((!basis || basisStatus !== "current") && Object.values(capabilities).some(Boolean)) fail();
  const observation = parseObservation(v.observation);
  if (capabilities.verifyDimensions && (!observation || !observation.observerId)) fail();
  const d = object(v.dimensionVerification, ["state", "verificationId"]);
  const dimensionVerification = { state: oneOf(d.state, ["unverified", "verified", "noncurrent"]), verificationId: nullableUuid(d.verificationId) };
  if ((dimensionVerification.state === "unverified") !== (dimensionVerification.verificationId === null)) fail();
  const q = object(v.qc, ["state", "acceptance", "lifecycle", "qcAccepted"]);
  const qc = { state: oneOf(q.state, ["not_submitted", "awaiting_review", "passed", "failed"]),
    acceptance: oneOf(q.acceptance, ["accepted", "not_accepted", "recorded_only", "noncurrent"]),
    lifecycle: oneOf(q.lifecycle, ["proven", "unproven"]), qcAccepted: boolean(q.qcAccepted) };
  if (qc.qcAccepted !== (qc.acceptance === "accepted") || qc.qcAccepted && (!basis || basisStatus !== "current" || qc.state !== "passed" || qc.lifecycle !== "proven")) fail();
  const w = object(v.work, ["availability", "activeCount", "pendingCount"]);
  const availability = oneOf(w.availability, ["available", "unavailable"]);
  if (availability === "unavailable" && (w.activeCount !== null || w.pendingCount !== null)) fail();
  const work = { availability, activeCount: availability === "available" ? integer(w.activeCount) : null,
    pendingCount: availability === "available" ? integer(w.pendingCount) : null };
  if (!Array.isArray(v.defects) || v.defects.length > 200) fail();
  const defects = v.defects.map(rawDefect => {
    const e = object(rawDefect, ["id", "summary", "state"]);
    return { id: uuid(e.id), summary: text(e.summary, 1000, true), state: oneOf(e.state, ["open", "claimed_resolved", "verified_resolved"]) };
  });
  if (new Set(defects.map(e => e.id)).size !== defects.length) fail();
  if (qc.qcAccepted && (work.availability !== "available" || work.activeCount !== 0 || work.pendingCount !== 0 || defects.some(e => e.state !== "verified_resolved"))) fail();
  return { basis, basisStatus, capabilities, observation, dimensionVerification, qc, work, defects };
}
export function parseUnitReviewReply(raw: unknown, expectedUnitId: string): ReviewReply {
  try {
    expectedUnitId = uuid(expectedUnitId);
    const value = object(boundedClone(raw, 100000), ["protocolVersion", "asOf", "availability", "review"]);
    if (value.protocolVersion !== 1) fail();
    const asOf = utc(value.asOf);
    if (value.availability === "unavailable") { if (value.review !== null) fail(); return { protocolVersion: 1, asOf, availability: "unavailable", review: null }; }
    if (value.availability !== "available") fail();
    return { protocolVersion: 1, asOf, availability: "available", review: parseView(value.review, expectedUnitId) };
  } catch { return fail(); }
}
/** Normalize only documented decimal spelling and unordered defect identities. */
export function parseUnitReviewPayload(raw: unknown): ReviewPayload {
  try {
    const p = object(boundedClone(raw, 32768), ["action", "basis", "data"]), basis = parseBasis(p.basis);
    const action = oneOf(p.action, ACTIONS);
    if (action === "verify_dimensions") {
      const d = object(p.data, ["widthDecimal", "heightDecimal", "unit", "source", "sourceReference"]);
      const widthDecimal = canonicalReviewDecimal(d.widthDecimal), heightDecimal = canonicalReviewDecimal(d.heightDecimal), unit = dimensionUnit(d.unit);
      boundedDimension(widthDecimal, unit); boundedDimension(heightDecimal, unit);
      return { action, basis, data: { widthDecimal, heightDecimal, unit, source: oneOf(d.source, ["measured", "plans"]), sourceReference: nullableText(d.sourceReference, 1000, true) } };
    }
    if (action === "submit" || action === "pass" || action === "reopen") {
      const d = object(p.data, ["note"]); return { action, basis, data: { note: nullableText(d.note, 2000) } };
    }
    if (action === "fail") {
      const d = object(p.data, ["note", "defects"]);
      if (!Array.isArray(d.defects) || d.defects.length > 20) fail();
      const defects = d.defects.map(rawDefect => { const e = object(rawDefect, ["id", "summary"]); return { id: uuid(e.id), summary: text(e.summary, 1000, true) }; });
      if (new Set(defects.map(e => e.id)).size !== defects.length) fail();
      return { action, basis, data: { note: text(d.note, 2000, true), defects: defects.sort((a, b) => a.id.localeCompare(b.id)) } };
    }
    const d = object(p.data, ["note", "defectIds"]);
    if (!Array.isArray(d.defectIds) || d.defectIds.length < 1 || d.defectIds.length > 200) fail();
    const defectIds = d.defectIds.map(uuid);
    if (new Set(defectIds).size !== defectIds.length) fail();
    return { action, basis, data: { note: nullableText(d.note, 2000), defectIds: defectIds.sort() } };
  } catch { return fail(); }
}
export function parseUnitReviewReceipt(raw: unknown, commandId: string, expected?: Pick<ReviewPayload, "action" | "basis">): ReviewReceipt {
  try {
    commandId = uuid(commandId);
    const r = object(boundedClone(raw, 100000), ["protocolVersion", "commandId", "action", "unitId", "eventId", "reviewRevision", "generation", "submissionId", "recordedAt", "outcome"]);
    if (r.protocolVersion !== 1 || uuid(r.commandId) !== commandId || r.outcome !== "applied") fail();
    const action = oneOf(r.action, ACTIONS), unitId = uuid(r.unitId);
    if (expected && (action !== expected.action || unitId !== uuid(expected.basis.unitId))) fail();
    return { protocolVersion: 1, commandId, action, unitId, eventId: uuid(r.eventId), reviewRevision: integer(r.reviewRevision, 1),
      generation: integer(r.generation), submissionId: nullableUuid(r.submissionId), recordedAt: utc(r.recordedAt), outcome: "applied" };
  } catch { return fail(); }
}
/** Cancellation binds the complete original. It proves that this UUID can no
 * longer apply, not that the current unit is accepted or free of other work. */
export function parseUnitReviewStoredReceipt(raw: unknown, commandId: string, expected?: ReviewPayload): ReviewStoredReceipt {
  try {
    const copy = boundedClone(raw, 100000) as Record<string, unknown>;
    if (copy?.outcome !== "cancelled") return parseUnitReviewReceipt(copy, commandId, expected);
    const r = object(copy, ["protocolVersion", "commandId", "action", "unitId", "recordedAt", "outcome", "original"]);
    const original = parseUnitReviewPayload(r.original), normalizedCommand = uuid(commandId);
    if (r.protocolVersion !== 1 || uuid(r.commandId) !== normalizedCommand || r.action !== original.action
      || uuid(r.unitId) !== original.basis.unitId || expected && JSON.stringify(original) !== JSON.stringify(parseUnitReviewPayload(expected))) fail();
    return { protocolVersion: 1, commandId: normalizedCommand, action: original.action, unitId: original.basis.unitId,
      recordedAt: utc(r.recordedAt), outcome: "cancelled", original };
  } catch { return fail(); }
}
export function parseUnitReviewReceiptReply(raw: unknown, commandId: string): ReviewReceiptReply {
  try {
    commandId = uuid(commandId);
    const r = object(boundedClone(raw, 100000), ["protocolVersion", "availability", "receipt"]);
    if (r.protocolVersion !== 1) fail();
    if (r.availability === "unavailable") { if (r.receipt !== null) fail(); return { protocolVersion: 1, availability: "unavailable", receipt: null }; }
    if (r.availability !== "available") fail();
    return { protocolVersion: 1, availability: "available", receipt: parseUnitReviewStoredReceipt(r.receipt, commandId) };
  } catch { return fail(); }
}
