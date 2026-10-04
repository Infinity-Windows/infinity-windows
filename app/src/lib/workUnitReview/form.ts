/** Pure controlled form models/validators for unit dimension verification and
 * final QC review. Canonical command payloads, no network, no storage. Every exported
 * validator/builder is a pure function of its explicit arguments: no role
 * inference, no data-trust flags, no actor authority derived here. The
 * server remains authoritative; this module only blocks an obviously invalid
 * or stale callback before it leaves the form.
 *
 * Widths and heights travel as exact decimal strings end to end -- never
 * through `Number` -- so a digit beyond double precision is never silently
 * rounded away before the server sees it. */
import type { DimensionSource, DimensionUnits } from "../workCapture/dimensions";

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

/** The server's exact raw observation, as originally captured. Widths and
 * heights are decimal strings, never numbers: a number field here would
 * force a lossy `Number` round-trip before this module ever saw the value.
 * The original observer lives here, not as a separate context field, so a
 * caller can never desync "who observed this" from "what was observed". */
export interface RawDimensionObservation {
  readonly observerId: string | null;
  readonly widthDecimal: string;
  readonly heightDecimal: string;
  readonly unit: DimensionUnits;
  readonly source: DimensionSource;
  readonly sourceReference: string | null;
}

export interface ReviewContext {
  readonly basis: ReviewBasis | null;
  readonly basisStatus: "current" | "stale" | "unavailable";
  readonly actorId: string | null;
  readonly original: RawDimensionObservation | null;
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

// Draft strings may retain incomplete typing states, but validation and emission
// require the same complete unsigned plain-decimal grammar as the server.
const DECIMAL_RE = /^([0-9]+(?:\.[0-9]+)?)$/;

/** A bounded, exact decimal-string parser: at most 100 raw characters, no
 * sign, no exponent. Every digit stays in BigInt; no float tolerance
 * anywhere in this path. */
function parseBoundedDecimal(raw: string): Rational | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 100) return null;
  const m = DECIMAL_RE.exec(raw);
  if (!m) return null;
  const mantissa = m[1];
  const dotIdx = mantissa.indexOf(".");
  const fracLen = dotIdx === -1 ? 0 : mantissa.length - dotIdx - 1;
  const digits = dotIdx === -1 ? mantissa : mantissa.slice(0, dotIdx) + mantissa.slice(dotIdx + 1);
  const digitsBig = BigInt(digits);
  const num = digitsBig;
  const den = 10n ** BigInt(fracLen);
  return { num, den };
}

/** Formats an already-validated positive decimal rational (den a power of
 * ten, as every `parseBoundedDecimal` result is) as the canonical, strict
 * transport string: no sign, no exponent, no leading/trailing dot, and
 * leading/trailing zeros collapsed without losing any significant digit.
 * `0001.00` => `"1"`; `0000.0100` => `"0.01"`. Never rounds: all
 * significant digits survive unchanged. */
function canonicalDecimalString(value: Rational): string {
  let scale = 0;
  let scaleDen = value.den;
  while (scaleDen > 1n) { scaleDen /= 10n; scale += 1; }
  const digits = value.num.toString();
  let intPart: string;
  let fracPart: string;
  if (scale === 0) {
    intPart = digits;
    fracPart = "";
  } else if (digits.length > scale) {
    intPart = digits.slice(0, digits.length - scale);
    fracPart = digits.slice(digits.length - scale);
  } else {
    intPart = "0";
    fracPart = "0".repeat(scale - digits.length) + digits;
  }
  intPart = intPart.replace(/^0+(?=\d)/, "");
  fracPart = fracPart.replace(/0+$/, "");
  return fracPart.length > 0 ? `${intPart}.${fracPart}` : intPart;
}

const UNIT_FACTORS: Record<DimensionUnits, Rational> = {
  in: { num: 1n, den: 1n },
  ft: { num: 12n, den: 1n },
  mm: { num: 5n, den: 127n },
  cm: { num: 50n, den: 127n },
};
const DIMENSION_UNITS = new Set<DimensionUnits>(["in", "ft", "mm", "cm"]);
const DIMENSION_SOURCES = new Set<DimensionSource>(["measured", "plans", "estimated"]);
const MAX_INCHES: Rational = { num: 100000n, den: 1n };

function isValidDimensionUnit(value: unknown): value is DimensionUnits {
  return typeof value === "string" && DIMENSION_UNITS.has(value as DimensionUnits);
}
function isValidDimensionSource(value: unknown): value is DimensionSource {
  return typeof value === "string" && DIMENSION_SOURCES.has(value as DimensionSource);
}

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

function rationalCompare(a: Rational, b: Rational): number {
  const left = a.num * b.den;
  const right = b.num * a.den;
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

/** Parses a raw decimal string in the given unit into an exact inches
 * rational, refusing anything non-positive or over the 100000in ceiling.
 * Every digit stays in BigInt the whole way; nothing here ever touches
 * `Number` for the magnitude itself. */
function parsePositiveBoundedInches(raw: string, unit: DimensionUnits): Rational | null {
  const parsed = parseBoundedDecimal(raw);
  if (!parsed || !rationalIsPositive(parsed)) return null;
  const inches = toInchesRational(parsed, unit);
  if (!rationalIsPositive(inches) || rationalCompare(inches, MAX_INCHES) > 0) return null;
  return inches;
}

interface InchPair {
  readonly widthIn: Rational;
  readonly heightIn: Rational;
}

/** Validates and converts the server's raw original observation. Returns
 * null for anything malformed, unknown-unit, unknown-source, non-positive,
 * or over the 100000in ceiling -- every such case is "cannot confirm
 * agreement", refused the same safe way as a genuinely missing original. */
function parseOriginalInches(original: RawDimensionObservation): InchPair | null {
  if (!isValidDimensionUnit(original.unit) || !isValidDimensionSource(original.source)) return null;
  const widthIn = parsePositiveBoundedInches(original.widthDecimal, original.unit);
  const heightIn = parsePositiveBoundedInches(original.heightDecimal, original.unit);
  if (!widthIn || !heightIn) return null;
  return { widthIn, heightIn };
}

function parseDraftInches(widthRaw: string, heightRaw: string, unit: DimensionUnits): InchPair | null {
  if (!isValidDimensionUnit(unit)) return null;
  const widthIn = parsePositiveBoundedInches(widthRaw, unit);
  const heightIn = parsePositiveBoundedInches(heightRaw, unit);
  if (!widthIn || !heightIn) return null;
  return { widthIn, heightIn };
}

/** Exact cross-multiplied comparison of two already-parsed inch-scale pairs.
 * Never rounds, never compares display rounding, never guesses a tolerance. */
function inchesMatchExactly(a: InchPair, b: InchPair): boolean {
  return rationalEquals(a.widthIn, b.widthIn) && rationalEquals(a.heightIn, b.heightIn);
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
    units: ctx.original?.unit ?? "in",
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

  if (!ctx.original) return "observation_required";
  const observerId = ctx.original.observerId;
  if (!isNonBlankToken(observerId)) return "observer_unknown";
  if (observerId === ctx.actorId) return "self_verification";

  const originalInches = parseOriginalInches(ctx.original);
  if (!originalInches) return "observation_required";

  if (draft.source !== "measured" && draft.source !== "plans") return "evidence_source";
  const reference = draft.reference.trim();
  if (reference.length === 0 || countCodepoints(draft.reference) > 1000) return "evidence_reference";

  const draftInches = parseDraftInches(draft.width, draft.height, draft.units);
  if (!draftInches) return "invalid_dimensions";

  // Compare the entered decimals exactly, as BigInt rationals, before this
  // value is ever serialized. This is an advisory client check; SQL numeric
  // remains authoritative.
  if (!inchesMatchExactly(draftInches, originalInches)) return "dimension_mismatch";

  return null;
}

/** The exact wire payload for a `verify_dimensions` command. Carries only
 * the action/basis/data the contract defines -- no observer, actor, trust,
 * request id, or client hash. Width/height stay decimal strings so a digit
 * beyond double precision survives JSON serialization unchanged. */
export interface VerificationIntent {
  readonly action: "verify_dimensions";
  readonly basis: ReviewBasis;
  readonly data: {
    readonly widthDecimal: string;
    readonly heightDecimal: string;
    readonly unit: DimensionUnits;
    readonly source: "measured" | "plans";
    readonly sourceReference: string;
  };
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
  // validateVerification already confirmed both parse as positive decimals;
  // Normalize redundant zeros only after complete transport spelling passes.
  const widthParsed = parseBoundedDecimal(draft.width);
  const heightParsed = parseBoundedDecimal(draft.height);
  if (!widthParsed || !heightParsed) return null;
  const data = Object.freeze({
    widthDecimal: canonicalDecimalString(widthParsed),
    heightDecimal: canonicalDecimalString(heightParsed),
    unit: draft.units,
    source: draft.source as "measured" | "plans",
    sourceReference: draft.reference.trim(),
  });
  return Object.freeze({ action: "verify_dimensions" as const, basis, data });
}

/* -------------------------------------------------------------------------
 * Final QC review
 * ---------------------------------------------------------------------- */

export type QcState = "not_submitted" | "awaiting_review" | "failed" | "passed" | "unknown";

export type QcDefectState = "open" | "claimed_resolved" | "verified_resolved";
const QC_DEFECT_STATES = new Set<QcDefectState>(["open", "claimed_resolved", "verified_resolved"]);

export interface QcDefect {
  readonly id: string;
  readonly summary: string;
  readonly state: QcDefectState;
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

type QcSimpleNoteData = { readonly note: string | null };
type QcFailData = {
  readonly note: string;
  readonly defects: readonly { readonly id: string; readonly summary: string }[];
};
type QcClaimData = { readonly note: string | null; readonly defectIds: readonly string[] };

/** The exact wire payload for a QC command: `{action, basis, data}` only --
 * no top-level kind/note/defects/defectIds. `data`'s shape is action-specific
 * per the contract. */
export type QcIntent =
  | { readonly action: "submit" | "pass" | "reopen"; readonly basis: ReviewBasis; readonly data: QcSimpleNoteData }
  | { readonly action: "fail"; readonly basis: ReviewBasis; readonly data: QcFailData }
  | { readonly action: "claim_resolved"; readonly basis: ReviewBasis; readonly data: QcClaimData };

function isValidExistingDefects(defects: readonly QcDefect[]): boolean {
  const seen = new Set<string>();
  for (const defect of defects) {
    if (!defect || typeof defect !== "object") return false;
    if (!isNonBlankToken(defect.id) || seen.has(defect.id)) return false;
    if (typeof defect.summary !== "string" || defect.summary.trim().length === 0) return false;
    if (!QC_DEFECT_STATES.has(defect.state)) return false;
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
      // claimed_resolved and verified_resolved defects do not block pass;
      // only a still-open defect does. Pass is what atomically turns a
      // claimed_resolved defect into verified_resolved -- claiming alone
      // never does.
      if (defects.some(d => d.state === "open")) return "unresolved_defects";
      return null;
    }
    case "fail": {
      if (state !== "awaiting_review" || ctx.basis.submissionId === null) return "invalid_qc_state";
      if (!isValidRequiredNote(draft.note)) return "note_required";
      if (draft.newDefects.length > 20) return "defect_required";
      // Zero new defects is only a real "fail" when it rejects an actual
      // outstanding claim back to open -- never a bare refusal with nothing
      // to reject and no fabricated defect to justify it.
      const rejectsAClaim = defects.some(d => d.state === "claimed_resolved");
      if (draft.newDefects.length === 0 && !rejectsAClaim) return "defect_required";
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
        // A defect that is already claimed_resolved or verified_resolved
        // cannot be claimed again -- only an open defect can.
        if (!defect || defect.state !== "open" || chosen.has(id)) return "defect_selection";
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
    return Object.freeze({ action, basis, data: Object.freeze({ note: trimmedNote, defects: defectsCopy }) });
  }
  if (action === "claim_resolved") {
    const defectIdsCopy = Object.freeze([...draft.resolvedDefectIds]);
    return Object.freeze({
      action,
      basis,
      data: Object.freeze({ note: trimmedNote.length === 0 ? null : trimmedNote, defectIds: defectIdsCopy }),
    });
  }
  return Object.freeze({ action, basis, data: Object.freeze({ note: trimmedNote.length === 0 ? null : trimmedNote }) });
}
