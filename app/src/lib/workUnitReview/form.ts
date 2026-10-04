/** Pure controlled form models/validators for unit dimension verification and
 * final QC review. No RPC/DTO shape, no network, no storage. Every exported
 * validator/builder is a pure function of its explicit arguments: no role
 * inference, no data-trust flags, no actor authority derived here. The
 * server remains authoritative; this module only blocks an obviously invalid
 * or stale callback before it leaves the form. */
import { normalizeDimensions, type DimensionInput, type DimensionUnits } from "../workCapture/dimensions";

/** Stable immutable semantic basis every review action is pinned against. */
export interface ReviewBasis {
  readonly unitId: string;
  readonly unitRevision: number;
  readonly factId: string;
  readonly factRevision: number;
  readonly scopeToken: string;
  readonly reviewRevision: number;
  readonly submissionId: string | null;
  readonly generation: number;
}

function isSafeNonNegativeInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && Number.isSafeInteger(value) && value >= 0;
}
function isNonBlankToken(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !/\s/.test(value);
}

/** True only for a basis whose fields satisfy every documented invariant:
 * safe nonnegative revisions, a strictly positive factRevision, and
 * required nonnull tokens with no whitespace/empty content. */
export function isValidReviewBasis(basis: ReviewBasis | null | undefined): basis is ReviewBasis {
  if (!basis || typeof basis !== "object") return false;
  return isNonBlankToken(basis.unitId)
    && isSafeNonNegativeInt(basis.unitRevision)
    && isNonBlankToken(basis.factId)
    && typeof basis.factRevision === "number" && Number.isSafeInteger(basis.factRevision) && basis.factRevision > 0
    && isNonBlankToken(basis.scopeToken)
    && isSafeNonNegativeInt(basis.reviewRevision)
    && (basis.submissionId === null || isNonBlankToken(basis.submissionId))
    && isSafeNonNegativeInt(basis.generation);
}

/** Stable JSON across every field, in a fixed order, so two bases with the
 * same semantic content always produce the same key. JSON-encoding each
 * field (rather than joining with a plain delimiter) avoids any collision
 * between a field's own content and a chosen separator character. */
export function basisKey(basis: ReviewBasis): string {
  return JSON.stringify([
    "unit-review-basis-v1",
    basis.unitId,
    basis.unitRevision,
    basis.factId,
    basis.factRevision,
    basis.scopeToken,
    basis.reviewRevision,
    basis.submissionId,
    basis.generation,
  ]);
}

function cloneBasis(basis: ReviewBasis): ReviewBasis {
  return Object.freeze({
    unitId: basis.unitId,
    unitRevision: basis.unitRevision,
    factId: basis.factId,
    factRevision: basis.factRevision,
    scopeToken: basis.scopeToken,
    reviewRevision: basis.reviewRevision,
    submissionId: basis.submissionId,
    generation: basis.generation,
  });
}

export interface ReviewContext {
  readonly basis: ReviewBasis | null;
  readonly basisStatus: "current" | "stale" | "unavailable";
  readonly actorId: string | null;
  readonly observerId: string | null;
  readonly original: DimensionInput | null;
}

export type ReviewDelivery = "idle" | "pending" | "unknown" | "refused" | "applied";

/** Shared reason codes. Simple enough for a parent catalog to map to copy. */
export type ReasonCode =
  | "stale"
  | "unavailable"
  | "sign_in"
  | "draft_changed"
  | "not_allowed"
  | "pending"
  | "unknown_delivery"
  | "applied"
  | "observer_unknown"
  | "self_verification"
  | "observation_required"
  | "invalid_dimensions"
  | "evidence_source"
  | "evidence_reference"
  | "dimension_mismatch"
  | "invalid_qc_state"
  | "unresolved_defects"
  | "note_required"
  | "defect_required"
  | "invalid_defect"
  | "defect_selection";

function countCodepoints(value: string): number {
  return Array.from(value).length;
}

interface Rational {
  readonly num: bigint;
  readonly den: bigint;
}

const DECIMAL_RE = /^([+-]?)(\d+(?:\.\d*)?|\.\d+)(?:[eE]([+-]?\d+))?$/;

/** A bounded, exact decimal-string parser: at most 100 raw characters, an
 * exponent bounded in magnitude before it ever reaches BigInt. No float
 * tolerance anywhere in this path. */
function parseBoundedDecimal(raw: string): Rational | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 100) return null;
  const m = DECIMAL_RE.exec(raw);
  if (!m) return null;
  const [, sign, mantissa, expStr] = m;
  const exp = expStr === undefined ? 0 : Number(expStr);
  if (!Number.isInteger(exp) || Math.abs(exp) > 400) return null;
  const dotIdx = mantissa.indexOf(".");
  const fracLen = dotIdx === -1 ? 0 : mantissa.length - dotIdx - 1;
  const digits = dotIdx === -1 ? mantissa : mantissa.slice(0, dotIdx) + mantissa.slice(dotIdx + 1);
  const pow = exp - fracLen;
  if (Math.abs(pow) > 500) return null;
  const digitsBig = BigInt(digits.length === 0 ? "0" : digits);
  let num: bigint;
  let den: bigint;
  if (pow >= 0) { num = digitsBig * 10n ** BigInt(pow); den = 1n; }
  else { num = digitsBig; den = 10n ** BigInt(-pow); }
  if (sign === "-") num = -num;
  return { num, den };
}

const UNIT_FACTORS: Record<DimensionUnits, Rational> = {
  in: { num: 1n, den: 1n },
  ft: { num: 12n, den: 1n },
  mm: { num: 10n, den: 254n },
  cm: { num: 100n, den: 254n },
};

function toInchesRational(value: Rational, units: DimensionUnits): Rational {
  const f = UNIT_FACTORS[units];
  return { num: value.num * f.num, den: value.den * f.den };
}

function rationalIsPositive(value: Rational): boolean {
  return value.den !== 0n && value.num > 0n;
}

function rationalEquals(a: Rational, b: Rational): boolean {
  return a.num * b.den === b.num * a.den;
}

function numberToRational(value: number): Rational | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return parseBoundedDecimal(value.toString());
}

/** Exact cross-multiplied comparison of two dimension inputs' inch-scale
 * width/height, independent of their original units. Never rounds, never
 * compares the public display rounding, never guesses a tolerance. Returns
 * null when either side cannot be parsed into an exact rational (treated as
 * "cannot confirm agreement" by the caller, not as a silent pass). */
function dimensionsMatchExactly(width: Rational, height: Rational, units: DimensionUnits, original: DimensionInput): boolean | null {
  const originalWidth = numberToRational(original.width), originalHeight = numberToRational(original.height);
  if (!originalWidth || !originalHeight) return null;
  return rationalEquals(toInchesRational(width, units), toInchesRational(originalWidth, original.units))
    && rationalEquals(toInchesRational(height, units), toInchesRational(originalHeight, original.units));
}

/* -------------------------------------------------------------------------
 * Independent dimension verification
 * ---------------------------------------------------------------------- */

export interface VerificationDraft {
  readonly actorId: string | null;
  readonly basisKey: string;
  readonly width: string;
  readonly height: string;
  readonly units: DimensionUnits;
  readonly source: "measured" | "plans" | "";
  readonly reference: string;
}

export function emptyVerificationDraft(ctx: ReviewContext): VerificationDraft {
  return {
    actorId: ctx.actorId,
    basisKey: ctx.basis && isValidReviewBasis(ctx.basis) ? basisKey(ctx.basis) : "",
    width: "",
    height: "",
    units: ctx.original?.units ?? "in",
    source: "",
    reference: "",
  };
}

function deliveryBlockReason(delivery: ReviewDelivery): ReasonCode | null {
  switch (delivery) {
    case "idle":
    case "refused":
      return null;
    case "pending":
      return "pending";
    case "applied":
      return "applied";
    default:
      return "unknown_delivery";
  }
}

export function validateVerification(
  ctx: ReviewContext,
  draft: VerificationDraft,
  delivery: ReviewDelivery,
  allowed: boolean,
): ReasonCode | null {
  if (!isNonBlankToken(ctx.actorId)) return "sign_in";
  if (ctx.basisStatus === "stale") return "stale";
  if (ctx.basisStatus !== "current" || !isValidReviewBasis(ctx.basis)) return "unavailable";
  const deliveryReason = deliveryBlockReason(delivery);
  if (deliveryReason) return deliveryReason;
  if (allowed !== true) return "not_allowed";
  if (draft.actorId !== ctx.actorId || draft.basisKey !== basisKey(ctx.basis)) return "draft_changed";
  if (!isNonBlankToken(ctx.observerId)) return "observer_unknown";
  if (ctx.observerId === ctx.actorId) return "self_verification";
  if (!ctx.original) return "observation_required";
  try {
    const original = normalizeDimensions({ ...ctx.original, sourceReference: null });
    if (original.widthIn > 100000 || original.heightIn > 100000) return "observation_required";
  } catch { return "observation_required"; }

  if (draft.source !== "measured" && draft.source !== "plans") return "evidence_source";
  const reference = draft.reference.trim();
  if (reference.length === 0 || countCodepoints(draft.reference) > 1000) return "evidence_reference";

  const widthValue = Number(draft.width);
  const heightValue = Number(draft.height);
  let normalized;
  try {
    normalized = normalizeDimensions({
      width: widthValue,
      height: heightValue,
      units: draft.units,
      source: draft.source,
      sourceReference: null,
    });
  } catch {
    return "invalid_dimensions";
  }
  if (normalized.widthIn > 100000 || normalized.heightIn > 100000) return "invalid_dimensions";
  const widthRational = parseBoundedDecimal(draft.width);
  const heightRational = parseBoundedDecimal(draft.height);
  if (!widthRational || !heightRational || !rationalIsPositive(widthRational) || !rationalIsPositive(heightRational)) {
    return "invalid_dimensions";
  }

  // Compare the entered decimals before Number conversion can discard digits.
  // This is an advisory client check; SQL numeric remains authoritative.
  const matches = dimensionsMatchExactly(widthRational, heightRational, draft.units, ctx.original);
  if (matches !== true) return "dimension_mismatch";

  return null;
}

export interface VerificationIntent {
  readonly kind: "verify_dimensions";
  readonly basis: ReviewBasis;
  readonly evidence: DimensionInput;
}

export function buildVerificationIntent(
  ctx: ReviewContext,
  draft: VerificationDraft,
  delivery: ReviewDelivery,
  allowed: boolean,
): VerificationIntent | null {
  if (validateVerification(ctx, draft, delivery, allowed) !== null) return null;
  // isValidReviewBasis(ctx.basis) was already confirmed by validateVerification above.
  const basis = cloneBasis(ctx.basis as ReviewBasis);
  const evidence: DimensionInput = Object.freeze({
    width: Number(draft.width),
    height: Number(draft.height),
    units: draft.units,
    source: draft.source as "measured" | "plans",
    sourceReference: draft.reference.trim(),
  });
  return Object.freeze({ kind: "verify_dimensions", basis, evidence });
}

/* -------------------------------------------------------------------------
 * Final QC review
 * ---------------------------------------------------------------------- */

export type QcState = "not_submitted" | "awaiting_review" | "failed" | "passed" | "unknown";

export interface QcDefect {
  readonly id: string;
  readonly summary: string;
  readonly resolved: boolean;
}

export interface QcDraft {
  readonly actorId: string | null;
  readonly basisKey: string;
  readonly note: string;
  readonly newDefects: readonly { readonly id: string; readonly summary: string }[];
  readonly resolvedDefectIds: readonly string[];
}

export function emptyQcDraft(ctx: ReviewContext): QcDraft {
  return {
    actorId: ctx.actorId,
    basisKey: ctx.basis && isValidReviewBasis(ctx.basis) ? basisKey(ctx.basis) : "",
    note: "",
    newDefects: [],
    resolvedDefectIds: [],
  };
}

export type QcAction = "submit" | "pass" | "fail" | "claim_resolved" | "reopen";

export interface QcIntent {
  readonly kind: QcAction;
  readonly basis: ReviewBasis;
  readonly note: string | null;
  readonly defects?: readonly { readonly id: string; readonly summary: string }[];
  readonly defectIds?: readonly string[];
}

function isValidExistingDefects(defects: readonly QcDefect[]): boolean {
  const seen = new Set<string>();
  for (const defect of defects) {
    if (!defect || typeof defect !== "object") return false;
    if (!isNonBlankToken(defect.id) || seen.has(defect.id)) return false;
    if (typeof defect.summary !== "string" || defect.summary.trim().length === 0) return false;
    if (typeof defect.resolved !== "boolean") return false;
    seen.add(defect.id);
  }
  return true;
}
function isNonBlankOrSpaced(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isValidOptionalNote(note: string): boolean {
  return typeof note === "string" && countCodepoints(note) <= 2000;
}
function isValidRequiredNote(note: string): boolean {
  return typeof note === "string" && note.trim().length > 0 && countCodepoints(note) <= 2000;
}

export function validateQcAction(
  ctx: ReviewContext,
  draft: QcDraft,
  delivery: ReviewDelivery,
  state: QcState,
  defects: readonly QcDefect[],
  action: QcAction,
  allowed: boolean,
): ReasonCode | null {
  if (!isNonBlankToken(ctx.actorId)) return "sign_in";
  if (ctx.basisStatus === "stale") return "stale";
  if (ctx.basisStatus !== "current" || !isValidReviewBasis(ctx.basis)) return "unavailable";
  const deliveryReason = deliveryBlockReason(delivery);
  if (deliveryReason) return deliveryReason;
  if (allowed !== true) return "not_allowed";
  if (draft.actorId !== ctx.actorId || draft.basisKey !== basisKey(ctx.basis)) return "draft_changed";
  if (state === "unknown") return "invalid_qc_state";
  if (!isValidExistingDefects(defects)) return "invalid_defect";

  const existingIds = new Set(defects.map(d => d.id));

  switch (action) {
    case "submit": {
      if (state !== "not_submitted") return "invalid_qc_state";
      if (!isValidOptionalNote(draft.note)) return "note_required";
      return null;
    }
    case "pass": {
      if (state !== "awaiting_review" || ctx.basis.submissionId === null) return "invalid_qc_state";
      if (!isValidOptionalNote(draft.note)) return "note_required";
      if (draft.newDefects.length > 0) return "unresolved_defects";
      if (defects.some(d => !d.resolved)) return "unresolved_defects";
      return null;
    }
    case "fail": {
      if (state !== "awaiting_review" || ctx.basis.submissionId === null) return "invalid_qc_state";
      if (!isValidRequiredNote(draft.note)) return "note_required";
      if (draft.newDefects.length < 1 || draft.newDefects.length > 20) return "defect_required";
      const newIds = new Set<string>();
      for (const d of draft.newDefects) {
        if (!isNonBlankToken(d.id) || !isNonBlankOrSpaced(d.summary) || countCodepoints(d.summary) > 1000) {
          return "invalid_defect";
        }
        if (newIds.has(d.id) || existingIds.has(d.id)) return "invalid_defect";
        newIds.add(d.id);
      }
      return null;
    }
    case "claim_resolved": {
      if (state !== "failed" || ctx.basis.submissionId === null) return "invalid_qc_state";
      if (!isValidOptionalNote(draft.note)) return "note_required";
      if (draft.resolvedDefectIds.length < 1) return "defect_selection";
      const chosen = new Set<string>();
      for (const id of draft.resolvedDefectIds) {
        const defect = defects.find(d => d.id === id);
        if (!defect || defect.resolved || chosen.has(id)) return "defect_selection";
        chosen.add(id);
      }
      return null;
    }
    case "reopen": {
      if ((state !== "passed" && state !== "failed") || ctx.basis.submissionId === null) return "invalid_qc_state";
      if (!isValidRequiredNote(draft.note)) return "note_required";
      return null;
    }
    default:
      return "invalid_qc_state";
  }
}

export function buildQcIntent(
  ctx: ReviewContext,
  draft: QcDraft,
  delivery: ReviewDelivery,
  state: QcState,
  defects: readonly QcDefect[],
  action: QcAction,
  allowed: boolean,
): QcIntent | null {
  if (validateQcAction(ctx, draft, delivery, state, defects, action, allowed) !== null) return null;
  const basis = cloneBasis(ctx.basis as ReviewBasis);
  const trimmedNote = draft.note.trim();

  if (action === "fail") {
    const defectsCopy = Object.freeze(draft.newDefects.map(d => Object.freeze({ id: d.id, summary: d.summary })));
    return Object.freeze({ kind: action, basis, note: trimmedNote, defects: defectsCopy });
  }
  if (action === "claim_resolved") {
    const defectIdsCopy = Object.freeze([...draft.resolvedDefectIds]);
    return Object.freeze({ kind: action, basis, note: trimmedNote.length === 0 ? null : trimmedNote, defectIds: defectIdsCopy });
  }
  if (action === "reopen") {
    return Object.freeze({ kind: action, basis, note: trimmedNote });
  }
  return Object.freeze({ kind: action, basis, note: trimmedNote.length === 0 ? null : trimmedNote });
}
