import { describe, expect, it } from "vitest";
import {
  basisKey, isValidReviewBasis, emptyVerificationDraft, validateVerification, buildVerificationIntent,
  emptyQcDraft, validateQcAction, buildQcIntent,
  type ReviewBasis, type ReviewContext, type RawDimensionObservation, type VerificationDraft,
  type QcDraft, type QcDefect,
} from "./form";

const basis = (changes: Partial<ReviewBasis> = {}): ReviewBasis => ({
  unitId: "unit-1", unitRevision: 3, factId: "fact-1", factRevision: 2,
  scopeToken: "scope-1", reviewRevision: 1, submissionId: "sub-1", generation: 1, ...changes,
});

const original = (changes: Partial<RawDimensionObservation> = {}): RawDimensionObservation => ({
  observerId: "observer-1", widthDecimal: "60", heightDecimal: "48", unit: "in",
  source: "estimated", sourceReference: "plan:note", ...changes,
});

const ctx = (changes: Partial<ReviewContext> = {}): ReviewContext => ({
  basis: basis(), basisStatus: "current", actorId: "actor-1", original: original(), ...changes,
});

const vDraft = (c: ReviewContext, changes: Partial<VerificationDraft> = {}): VerificationDraft => ({
  ...emptyVerificationDraft(c), width: "60", height: "48", units: "in", source: "measured",
  reference: "field-note:1", ...changes,
});

describe("basisKey", () => {
  it("is stable for identical fields and changes when any field changes", () => {
    expect(basisKey(basis())).toBe(basisKey(basis()));
    expect(basisKey(basis())).not.toBe(basisKey(basis({ unitRevision: 4 })));
    expect(basisKey(basis())).not.toBe(basisKey(basis({ factRevision: 3 })));
    expect(basisKey(basis())).not.toBe(basisKey(basis({ submissionId: null })));
    expect(basisKey(basis())).not.toBe(basisKey(basis({ generation: 2 })));
  });
});

describe("isValidReviewBasis", () => {
  it("accepts a well-formed basis and rejects malformed tokens/revisions", () => {
    expect(isValidReviewBasis(basis())).toBe(true);
    expect(isValidReviewBasis(basis({ unitId: "" }))).toBe(false);
    expect(isValidReviewBasis(basis({ unitId: "has space" }))).toBe(false);
    expect(isValidReviewBasis(basis({ factRevision: 0 }))).toBe(false);
    expect(isValidReviewBasis(basis({ unitRevision: -1 }))).toBe(false);
    expect(isValidReviewBasis(basis({ submissionId: "" }))).toBe(false);
    expect(isValidReviewBasis(basis({ submissionId: null }))).toBe(true);
    expect(isValidReviewBasis(null)).toBe(false);
  });
});

describe("emptyVerificationDraft", () => {
  it("seeds units from the original observation's unit, not a fixed default", () => {
    expect(emptyVerificationDraft(ctx({ original: original({ unit: "mm" }) })).units).toBe("mm");
    expect(emptyVerificationDraft(ctx({ original: null })).units).toBe("in");
  });
});

describe("validateVerification", () => {
  it("passes a complete, independently measured, matching draft", () => {
    const c = ctx();
    expect(validateVerification(c, vDraft(c), "idle", true)).toBeNull();
  });

  it("requires sign-in before anything else", () => {
    expect(validateVerification(ctx({ actorId: null }), vDraft(ctx()), "idle", true)).toBe("sign_in");
  });

  it("blocks on a stale or unavailable basis", () => {
    expect(validateVerification(ctx({ basisStatus: "stale" }), vDraft(ctx()), "idle", true)).toBe("stale");
    expect(validateVerification(ctx({ basisStatus: "unavailable" }), vDraft(ctx()), "idle", true)).toBe("unavailable");
    expect(validateVerification(ctx({ basis: null }), vDraft(ctx()), "idle", true)).toBe("unavailable");
    expect(validateVerification(ctx({ basis: basis({ factRevision: 0 }) }), vDraft(ctx()), "idle", true)).toBe("unavailable");
  });

  it.each(["pending", "unknown", "applied"] as const)("blocks delivery=%s and never builds an intent", (delivery) => {
    const c = ctx();
    expect(validateVerification(c, vDraft(c), delivery, true)).toBe(
      delivery === "pending" ? "pending" : delivery === "applied" ? "applied" : "unknown_delivery",
    );
    expect(buildVerificationIntent(c, vDraft(c), delivery, true)).toBeNull();
  });

  it("allows idle and refused delivery to proceed to further checks", () => {
    const c = ctx();
    expect(validateVerification(c, vDraft(c), "refused", true)).toBeNull();
  });

  it("refuses when the caller is not allowed", () => {
    const c = ctx();
    expect(validateVerification(c, vDraft(c), "idle", false)).toBe("not_allowed");
  });

  it("refuses a draft whose owner or basis no longer matches the current context", () => {
    const c = ctx();
    expect(validateVerification(c, vDraft(c, { actorId: "someone-else" }), "idle", true)).toBe("draft_changed");
    expect(validateVerification(c, vDraft(c, { basisKey: "stale-key" }), "idle", true)).toBe("draft_changed");
  });

  it("requires a known, distinct original observer and refuses self-verification", () => {
    expect(validateVerification(ctx({ original: original({ observerId: null }) }), vDraft(ctx()), "idle", true))
      .toBe("observer_unknown");
    const selfCtx = ctx({ original: original({ observerId: "actor-1" }) });
    expect(validateVerification(selfCtx, vDraft(selfCtx), "idle", true)).toBe("self_verification");
  });

  it("does not treat a blank observer id as an independent reviewer", () => {
    const c = ctx({ original: original({ observerId: "" }) });
    expect(validateVerification(c, vDraft(ctx()), "idle", true)).toBe("observer_unknown");
  });

  it("requires a known original observation to compare against", () => {
    const c = ctx({ original: null });
    expect(validateVerification(c, vDraft(c), "idle", true)).toBe("observation_required");
  });

  it("refuses an original observation with an unknown unit or source", () => {
    expect(validateVerification(
      ctx({ original: original({ unit: "yd" as unknown as RawDimensionObservation["unit"] }) }), vDraft(ctx()), "idle", true,
    )).toBe("observation_required");
    expect(validateVerification(
      ctx({ original: original({ source: "guessed" as unknown as RawDimensionObservation["source"] }) }), vDraft(ctx()), "idle", true,
    )).toBe("observation_required");
  });

  it("refuses a non-string, zero, or negative original decimal without coercing it", () => {
    expect(validateVerification(ctx({ original: original({ widthDecimal: 60 as unknown as string }) }), vDraft(ctx()), "idle", true))
      .toBe("observation_required");
    expect(validateVerification(ctx({ original: original({ widthDecimal: "0" }) }), vDraft(ctx()), "idle", true))
      .toBe("observation_required");
    expect(validateVerification(ctx({ original: original({ widthDecimal: "-5" }) }), vDraft(ctx()), "idle", true))
      .toBe("observation_required");
  });

  it("refuses an original observation over the 100000in ceiling", () => {
    const c = ctx({ original: original({ widthDecimal: "100001", heightDecimal: "1", unit: "in" }) });
    expect(validateVerification(c, vDraft(c), "idle", true)).toBe("observation_required");
  });

  it("requires measured or plans as the evidence source", () => {
    const c = ctx();
    expect(validateVerification(c, vDraft(c, { source: "" }), "idle", true)).toBe("evidence_source");
  });

  it("requires a nonblank reference bounded to 1000 codepoints", () => {
    const c = ctx();
    expect(validateVerification(c, vDraft(c, { reference: "   " }), "idle", true)).toBe("evidence_reference");
    expect(validateVerification(c, vDraft(c, { reference: "x".repeat(1001) }), "idle", true)).toBe("evidence_reference");
    expect(validateVerification(c, vDraft(c, { reference: "x".repeat(1000) }), "idle", true)).toBeNull();
  });

  it("accepts an original observation whose own reference exceeds the draft's 1000-codepoint bound", () => {
    const c = ctx({ original: original({ sourceReference: "x".repeat(2000) }) });
    expect(validateVerification(c, vDraft(c), "idle", true)).toBeNull();
  });

  it("rejects non-positive, non-numeric or oversized draft dimensions without silent coercion", () => {
    const c = ctx();
    expect(validateVerification(c, vDraft(c, { width: "0" }), "idle", true)).toBe("invalid_dimensions");
    expect(validateVerification(c, vDraft(c, { width: "-5" }), "idle", true)).toBe("invalid_dimensions");
    expect(validateVerification(c, vDraft(c, { width: "abc" }), "idle", true)).toBe("invalid_dimensions");
    expect(validateVerification(c, vDraft(c, { width: "10000", height: "1", units: "ft" }), "idle", true)).toBe("invalid_dimensions");
  });

  it("rejects a draft string longer than 100 characters, with an exponent, or with a sign", () => {
    const c = ctx({ original: original({ widthDecimal: "1", heightDecimal: "1" }) });
    expect(validateVerification(c, vDraft(c, { width: "1".repeat(101), height: "1" }), "idle", true)).toBe("invalid_dimensions");
    expect(validateVerification(c, vDraft(c, { width: "1e500", height: "1" }), "idle", true)).toBe("invalid_dimensions");
    expect(validateVerification(c, vDraft(c, { width: "+1", height: "1" }), "idle", true)).toBe("invalid_dimensions");
  });

  it("refuses incomplete dot spellings even when the numeric values would agree", () => {
    const c = ctx({ original: original({ widthDecimal: "0.5", heightDecimal: "72", unit: "in" }) });
    expect(validateVerification(c, vDraft(c, { width: ".5", height: "72." }), "idle", true)).toBe("invalid_dimensions");
  });

  it.each([
    ["5", "4", "ft"], ["1524", "1219.2", "mm"], ["152.4", "121.92", "cm"],
  ] as const)("matches %s %s %s exactly against a 60x48in original with no float tolerance", (w, h, units) => {
    const c = ctx({ original: original({ widthDecimal: "60", heightDecimal: "48", unit: "in" }) });
    expect(validateVerification(c, vDraft(c, { width: w, height: h, units }), "idle", true)).toBeNull();
  });

  it("matches an exact mm-to-inch cancellation that a naive 0.0393701 multiplier would not reproduce", () => {
    // 127mm = 5in exactly (127 * 5/127), not an approximation. A decimal
    // multiplier like 0.0393701 would drift from 5 by a tiny but nonzero
    // amount; the BigInt rational conversion must agree exactly.
    const c = ctx({ original: original({ widthDecimal: "5", heightDecimal: "48", unit: "in" }) });
    expect(validateVerification(c, vDraft(c, { width: "127", height: "1219.2", units: "mm" }), "idle", true)).toBeNull();
  });

  it("matches a long repeating-fraction decimal exactly when both sides carry identical digits", () => {
    const repeating = "33.333333333333333333333333333333";
    const c = ctx({ original: original({ widthDecimal: repeating, heightDecimal: "48", unit: "in" }) });
    expect(validateVerification(c, vDraft(c, { width: repeating, height: "48" }), "idle", true)).toBeNull();
    expect(validateVerification(c, vDraft(c, { width: repeating.slice(0, -1), height: "48" }), "idle", true))
      .toBe("dimension_mismatch");
  });

  it("refuses a value one ulp away instead of rounding it into agreement", () => {
    const c = ctx({ original: original({ widthDecimal: "60", heightDecimal: "48", unit: "in" }) });
    expect(validateVerification(c, vDraft(c, { width: "60.0000001" }), "idle", true)).toBe("dimension_mismatch");
  });

  it("refuses disagreement and requires a new canonical observation instead of silent replacement", () => {
    const c = ctx({ original: original({ widthDecimal: "60", heightDecimal: "48", unit: "in" }) });
    expect(validateVerification(c, vDraft(c, { width: "61" }), "idle", true)).toBe("dimension_mismatch");
  });

  it("corroborating evidence does not change the original estimate's recorded source", () => {
    const c = ctx({ original: original({ source: "estimated" }) });
    const intent = buildVerificationIntent(c, vDraft(c), "idle", true);
    expect(intent).not.toBeNull();
    expect(c.original?.source).toBe("estimated");
  });
});

describe("buildVerificationIntent", () => {
  it("returns null for every invalid input and never touches the root context", () => {
    const c = ctx({ actorId: null });
    expect(buildVerificationIntent(c, vDraft(ctx()), "idle", true)).toBeNull();
  });

  it("returns a frozen intent with action/basis/data only -- no observer, actor, or kind/evidence fields", () => {
    const c = ctx();
    const intent = buildVerificationIntent(c, vDraft(c), "idle", true);
    expect(intent).not.toBeNull();
    expect(intent!.action).toBe("verify_dimensions");
    expect(intent!.basis).toEqual(c.basis);
    expect(intent!.basis).not.toBe(c.basis);
    expect(intent!.data.sourceReference).toBe("field-note:1");
    expect(intent!.data.widthDecimal).toBe("60");
    expect(intent!.data.heightDecimal).toBe("48");
    expect(Object.isFrozen(intent)).toBe(true);
    expect(Object.isFrozen(intent!.basis)).toBe(true);
    expect(Object.isFrozen(intent!.data)).toBe(true);
    expect(intent).not.toHaveProperty("kind");
    expect(intent).not.toHaveProperty("evidence");
    expect(intent).not.toHaveProperty("observerId");
    expect(intent).not.toHaveProperty("actorId");
  });

  it("carries the exact raw decimal strings, with digits beyond double precision, unchanged through JSON", () => {
    const c = ctx({ original: original({ widthDecimal: "1.00000000000000000001", heightDecimal: "48", unit: "in" }) });
    const draft = vDraft(c, { width: "1.00000000000000000001", height: "48" });
    const intent = buildVerificationIntent(c, draft, "idle", true);
    expect(intent).not.toBeNull();
    expect(intent!.data.widthDecimal).toBe("1.00000000000000000001");
    const roundTripped = JSON.parse(JSON.stringify(intent));
    expect(roundTripped.data.widthDecimal).toBe("1.00000000000000000001");
    // A double cannot distinguish this value from "1" -- the string survived
    // only because it was never parsed with Number.
    expect(Number("1.00000000000000000001")).toBe(1);
  });

  it("stays unaffected by later mutation of the draft object used to build it", () => {
    const c = ctx();
    const draft = { ...vDraft(c) };
    const intent = buildVerificationIntent(c, draft, "idle", true);
    (draft as { width: string }).width = "999";
    expect(intent!.data.widthDecimal).toBe("60");
  });
});

const defect = (changes: Partial<QcDefect> = {}): QcDefect => ({ id: "d1", summary: "crack", state: "open", ...changes });

const qDraft = (c: ReviewContext, changes: Partial<QcDraft> = {}): QcDraft => ({
  ...emptyQcDraft(c), note: "looks good", newDefects: [], resolvedDefectIds: [], ...changes,
});

describe("validateQcAction", () => {
  it("requires sign-in, a current valid basis, and known delivery state", () => {
    const c = ctx();
    expect(validateQcAction(ctx({ actorId: null }), qDraft(c), "idle", "not_submitted", [], "submit", true)).toBe("sign_in");
    expect(validateQcAction(ctx({ basisStatus: "stale" }), qDraft(c), "idle", "not_submitted", [], "submit", true)).toBe("stale");
    expect(validateQcAction(ctx({ basisStatus: "unavailable" }), qDraft(c), "idle", "not_submitted", [], "submit", true)).toBe("unavailable");
    expect(validateQcAction(c, qDraft(c), "pending", "not_submitted", [], "submit", true)).toBe("pending");
    expect(validateQcAction(c, qDraft(c), "applied", "not_submitted", [], "submit", true)).toBe("applied");
    expect(validateQcAction(c, qDraft(c), "unknown", "not_submitted", [], "submit", true)).toBe("unknown_delivery");
  });

  it("refuses when not allowed and when the draft no longer matches the basis/owner", () => {
    const c = ctx();
    expect(validateQcAction(c, qDraft(c), "idle", "not_submitted", [], "submit", false)).toBe("not_allowed");
    expect(validateQcAction(c, qDraft(c, { actorId: "other" }), "idle", "not_submitted", [], "submit", true)).toBe("draft_changed");
    expect(validateQcAction(c, qDraft(c, { basisKey: "wrong" }), "idle", "not_submitted", [], "submit", true)).toBe("draft_changed");
  });

  it("blocks on an unknown current review state for every action", () => {
    const c = ctx();
    expect(validateQcAction(c, qDraft(c), "idle", "unknown", [], "submit", true)).toBe("invalid_qc_state");
    expect(validateQcAction(c, qDraft(c), "idle", "unknown", [], "pass", true)).toBe("invalid_qc_state");
  });

  it("refuses when the supplied existing defect list has a duplicate id or an unknown state", () => {
    const c = ctx();
    expect(validateQcAction(c, qDraft(c), "idle", "awaiting_review", [defect({ id: "x" }), defect({ id: "x" })], "pass", true))
      .toBe("invalid_defect");
    expect(validateQcAction(
      c, qDraft(c), "idle", "awaiting_review",
      [defect({ state: "resolved" as QcDefect["state"] })], "pass", true,
    )).toBe("invalid_defect");
  });

  it("submit is only valid from not_submitted", () => {
    const c = ctx();
    expect(validateQcAction(c, qDraft(c), "idle", "not_submitted", [], "submit", true)).toBeNull();
    expect(validateQcAction(c, qDraft(c), "idle", "awaiting_review", [], "submit", true)).toBe("invalid_qc_state");
  });

  it("pass requires awaiting_review with a submission id and refuses any still-open defect", () => {
    const c = ctx();
    expect(validateQcAction(c, qDraft(c), "idle", "awaiting_review", [], "pass", true)).toBeNull();
    expect(validateQcAction(c, qDraft(c), "idle", "not_submitted", [], "pass", true)).toBe("invalid_qc_state");
    const noSubmission = ctx({ basis: basis({ submissionId: null }) });
    expect(validateQcAction(noSubmission, qDraft(noSubmission), "idle", "awaiting_review", [], "pass", true))
      .toBe("invalid_qc_state");
    expect(validateQcAction(c, qDraft(c), "idle", "awaiting_review", [defect({ state: "open" })], "pass", true))
      .toBe("unresolved_defects");
  });

  it("pass allows claimed_resolved and verified_resolved defects -- only an open one blocks it", () => {
    const c = ctx();
    const allClaimed = [defect({ id: "d1", state: "claimed_resolved" }), defect({ id: "d2", state: "verified_resolved" })];
    expect(validateQcAction(c, qDraft(c), "idle", "awaiting_review", allClaimed, "pass", true)).toBeNull();
    const partiallyOpen = [defect({ id: "d1", state: "claimed_resolved" }), defect({ id: "d2", state: "open" })];
    expect(validateQcAction(c, qDraft(c), "idle", "awaiting_review", partiallyOpen, "pass", true)).toBe("unresolved_defects");
  });

  it("pass refuses when the draft itself still carries new, unsaved defect findings", () => {
    const c = ctx();
    const draft = qDraft(c, { newDefects: [{ id: "new-1", summary: "unsaved finding" }] });
    expect(validateQcAction(c, draft, "idle", "awaiting_review", [], "pass", true)).toBe("unresolved_defects");
  });

  it("fail requires awaiting_review, a nonblank note, and up to 20 well-formed unique new defects", () => {
    const c = ctx();
    const ok = qDraft(c, { newDefects: [{ id: "n1", summary: "bad seal" }] });
    expect(validateQcAction(c, ok, "idle", "awaiting_review", [], "fail", true)).toBeNull();
    expect(validateQcAction(c, qDraft(c, { note: "" }), "idle", "awaiting_review", [], "fail", true)).toBe("note_required");
    expect(validateQcAction(c, qDraft(c, { note: "x".repeat(2001) }), "idle", "awaiting_review", [], "fail", true)).toBe("note_required");
    const tooMany = Array.from({ length: 21 }, (_, i) => ({ id: `n${i}`, summary: "bad" }));
    expect(validateQcAction(c, qDraft(c, { newDefects: tooMany }), "idle", "awaiting_review", [], "fail", true)).toBe("defect_required");
    expect(validateQcAction(c, qDraft(c, { newDefects: [{ id: "", summary: "bad" }] }), "idle", "awaiting_review", [], "fail", true))
      .toBe("invalid_defect");
    expect(validateQcAction(c, qDraft(c, { newDefects: [{ id: "n1", summary: " " }] }), "idle", "awaiting_review", [], "fail", true))
      .toBe("invalid_defect");
    expect(validateQcAction(c, qDraft(c, { newDefects: [{ id: "n1", summary: "x".repeat(1001) }] }), "idle", "awaiting_review", [], "fail", true))
      .toBe("invalid_defect");
    expect(validateQcAction(c, qDraft(c, { newDefects: [{ id: "n1", summary: "a" }, { id: "n1", summary: "b" }] }), "idle", "awaiting_review", [], "fail", true))
      .toBe("invalid_defect");
    expect(validateQcAction(c, qDraft(c, { newDefects: [{ id: "d1", summary: "collides" }] }), "idle", "awaiting_review", [defect({ id: "d1" })], "fail", true))
      .toBe("invalid_defect");
    expect(validateQcAction(c, qDraft(c), "idle", "not_submitted", [], "fail", true)).toBe("invalid_qc_state");
  });

  it("fail with zero new defects is only valid when it actually rejects an outstanding claim", () => {
    const c = ctx();
    const noNewDefects = qDraft(c, { newDefects: [] });
    expect(validateQcAction(c, noNewDefects, "idle", "awaiting_review", [], "fail", true)).toBe("defect_required");
    const withClaim = [defect({ id: "d1", state: "claimed_resolved" })];
    expect(validateQcAction(c, noNewDefects, "idle", "awaiting_review", withClaim, "fail", true)).toBeNull();
    const withVerifiedOnly = [defect({ id: "d1", state: "verified_resolved" })];
    expect(validateQcAction(c, noNewDefects, "idle", "awaiting_review", withVerifiedOnly, "fail", true)).toBe("defect_required");
  });

  it("claim_resolved is only valid from failed and requires existing, open, unique defect ids", () => {
    const c = ctx();
    const existing = [
      defect({ id: "d1", state: "open" }),
      defect({ id: "d2", state: "claimed_resolved" }),
      defect({ id: "d3", state: "verified_resolved" }),
    ];
    expect(validateQcAction(c, qDraft(c, { resolvedDefectIds: ["d1"] }), "idle", "failed", existing, "claim_resolved", true)).toBeNull();
    expect(validateQcAction(c, qDraft(c, { resolvedDefectIds: [] }), "idle", "failed", existing, "claim_resolved", true)).toBe("defect_selection");
    expect(validateQcAction(c, qDraft(c, { resolvedDefectIds: ["ghost"] }), "idle", "failed", existing, "claim_resolved", true)).toBe("defect_selection");
    expect(validateQcAction(c, qDraft(c, { resolvedDefectIds: ["d2"] }), "idle", "failed", existing, "claim_resolved", true)).toBe("defect_selection");
    expect(validateQcAction(c, qDraft(c, { resolvedDefectIds: ["d3"] }), "idle", "failed", existing, "claim_resolved", true)).toBe("defect_selection");
    expect(validateQcAction(c, qDraft(c, { resolvedDefectIds: ["d1", "d1"] }), "idle", "failed", existing, "claim_resolved", true)).toBe("defect_selection");
    expect(validateQcAction(c, qDraft(c, { resolvedDefectIds: ["d1"] }), "idle", "awaiting_review", existing, "claim_resolved", true)).toBe("invalid_qc_state");
  });

  it("claimed resolution returns the unit to review rather than passing it directly, and never marks a defect verified", () => {
    const c = ctx();
    const existing = [defect({ id: "d1", state: "open" })];
    const intent = buildQcIntent(c, qDraft(c, { resolvedDefectIds: ["d1"] }), "idle", "failed", existing, "claim_resolved", true);
    expect(intent!.action).toBe("claim_resolved");
    expect(intent!.action).not.toBe("pass");
  });

  it("reopen is only valid from passed or failed and requires a nonblank reason", () => {
    const c = ctx();
    expect(validateQcAction(c, qDraft(c), "idle", "passed", [], "reopen", true)).toBeNull();
    expect(validateQcAction(c, qDraft(c), "idle", "failed", [], "reopen", true)).toBeNull();
    expect(validateQcAction(c, qDraft(c), "idle", "not_submitted", [], "reopen", true)).toBe("invalid_qc_state");
    expect(validateQcAction(c, qDraft(c, { note: "" }), "idle", "passed", [], "reopen", true)).toBe("note_required");
  });

  it("reopen carries only a note -- no defect data, so it cannot mutate defect state itself", () => {
    const c = ctx();
    const intent = buildQcIntent(c, qDraft(c), "idle", "passed", [defect({ state: "verified_resolved" })], "reopen", true);
    expect(intent!.action).toBe("reopen");
    expect(intent!.data).not.toHaveProperty("defects");
    expect(intent!.data).not.toHaveProperty("defectIds");
  });

  it("allows self-final-QC without comparing against any observer identity", () => {
    const c = ctx({ original: original({ observerId: null }), actorId: "actor-1" });
    expect(validateQcAction(c, qDraft(c), "idle", "awaiting_review", [], "pass", true)).toBeNull();
  });

  it("blocks every action for pending/unknown/applied delivery with no intent built", () => {
    const c = ctx();
    for (const delivery of ["pending", "unknown", "applied"] as const) {
      expect(buildQcIntent(c, qDraft(c), delivery, "awaiting_review", [], "pass", true)).toBeNull();
    }
  });
});

describe("buildQcIntent", () => {
  it("returns null unless validation passes", () => {
    const c = ctx();
    expect(buildQcIntent(c, qDraft(c, { note: "" }), "idle", "awaiting_review", [], "fail", true)).toBeNull();
  });

  it("builds a frozen submit intent with action/basis/data and a note-only data object", () => {
    const c = ctx();
    const intent = buildQcIntent(c, qDraft(c), "idle", "not_submitted", [], "submit", true);
    expect(intent!.action).toBe("submit");
    expect(intent!.basis).toEqual(c.basis);
    expect(intent!.basis).not.toBe(c.basis);
    expect(intent).not.toHaveProperty("kind");
    expect(intent).not.toHaveProperty("note");
    expect(intent).not.toHaveProperty("defects");
    expect(intent).not.toHaveProperty("defectIds");
    expect(intent!.data).toEqual({ note: "looks good" });
    expect(Object.isFrozen(intent)).toBe(true);
    expect(Object.isFrozen(intent!.data)).toBe(true);
  });

  it("builds a fail intent whose data carries only the new defects, frozen and copied", () => {
    const c = ctx();
    const newDefects = [{ id: "n1", summary: "bad seal" }];
    const draft = qDraft(c, { newDefects });
    const intent = buildQcIntent(c, draft, "idle", "awaiting_review", [], "fail", true);
    if (!intent || intent.action !== "fail") throw new Error("expected a fail intent");
    expect(intent.data.defects).toEqual(newDefects);
    expect(intent.data).not.toHaveProperty("defectIds");
    expect(Object.isFrozen(intent.data)).toBe(true);
    expect(Object.isFrozen(intent.data.defects)).toBe(true);
    newDefects.push({ id: "n2", summary: "late addition" });
    expect(intent.data.defects).toHaveLength(1);
  });

  it("builds a fail intent with zero defects when rejecting an existing claim", () => {
    const c = ctx();
    const existing = [defect({ id: "d1", state: "claimed_resolved" })];
    const intent = buildQcIntent(c, qDraft(c, { newDefects: [] }), "idle", "awaiting_review", existing, "fail", true);
    if (!intent || intent.action !== "fail") throw new Error("expected a fail intent");
    expect(intent.data.defects).toEqual([]);
  });

  it("builds a claim_resolved intent whose data carries only the chosen defect ids", () => {
    const c = ctx();
    const existing = [defect({ id: "d1", state: "open" })];
    const ids = ["d1"];
    const draft = qDraft(c, { resolvedDefectIds: ids });
    const intent = buildQcIntent(c, draft, "idle", "failed", existing, "claim_resolved", true);
    if (!intent || intent.action !== "claim_resolved") throw new Error("expected a claim_resolved intent");
    expect(intent.data.defectIds).toEqual(["d1"]);
    expect(intent.data).not.toHaveProperty("defects");
    ids.push("d2");
    expect(intent.data.defectIds).toHaveLength(1);
  });

  it("never performs network or storage side effects and leaves inputs unmutated", () => {
    const c = ctx();
    const draft = qDraft(c);
    const before = JSON.stringify(draft);
    buildQcIntent(c, draft, "idle", "not_submitted", [], "submit", true);
    expect(JSON.stringify(draft)).toBe(before);
    expect(JSON.stringify(c.basis)).toBe(JSON.stringify(basis()));
  });
});

describe("captured integration counterexamples", () => {
  it("rejects digits that a binary number would round into agreement", () => {
    const c = ctx({ original: original({ widthDecimal: "1", heightDecimal: "1" }) });
    expect(validateVerification(c, vDraft(c, { width: "1.00000000000000000001", height: "1" }), "idle", true)).toBe("dimension_mismatch");
  });
  it("retains trailing-dot draft text but refuses its incomplete spelling", () => {
    const c = ctx(); expect(validateVerification(c, vDraft(c, { width: "60.", height: "48." }), "idle", true)).toBe("invalid_dimensions");
  });
  it("refuses incomplete original measurements and preserves a long original reference", () => {
    const c = ctx({ original: original({ sourceReference: "😀".repeat(900) }) });
    expect(validateVerification(c, vDraft(c), "idle", true)).toBeNull();
    expect(validateVerification(ctx({ original: original({ widthDecimal: "0" }) }), vDraft(c), "idle", true)).toBe("observation_required");
  });
  it("requires exact current submission identity for all submitted QC actions", () => {
    const c = ctx({ basis: basis({ submissionId: null }) });
    expect(validateQcAction(c, qDraft(c, { newDefects: [{ id: "d2", summary: "Missing seal" }] }), "idle", "awaiting_review", [], "fail", true)).toBe("invalid_qc_state");
    expect(validateQcAction(c, qDraft(c, { resolvedDefectIds: ["d1"] }), "idle", "failed", [defect()], "claim_resolved", true)).toBe("invalid_qc_state");
    expect(validateQcAction(c, qDraft(c), "idle", "passed", [], "reopen", true)).toBe("invalid_qc_state");
  });
  it("does not treat non-current basisStatus as an independent reviewer or a valid state", () => {
    const c = ctx();
    expect(validateVerification({ ...c, basisStatus: "loading" as ReviewContext["basisStatus"] }, vDraft(c), "idle", true)).toBe("unavailable");
  });
  it("a reopen never resurrects defect currentness: claims stay exactly as recorded, not reset to open", () => {
    const c = ctx();
    const intent = buildQcIntent(c, qDraft(c), "idle", "failed", [defect({ state: "claimed_resolved" })], "reopen", true);
    expect(intent!.data).toEqual({ note: "looks good" });
  });
});


describe("strict canonical decimal transport", () => {
  it.each([["0001.00", "1"], ["0000.0100", "0.01"], ["0001.0000000000000000100", "1.00000000000000001"]])("normalizes only redundant zeros in %s", (raw, canonical) => {
    const c = ctx({ original: original({ widthDecimal: canonical, heightDecimal: "48" }) });
    const draft = vDraft(c, { width: raw });
    expect(buildVerificationIntent(c, draft, "idle", true)?.data.widthDecimal).toBe(canonical);
    expect(draft.width).toBe(raw);
  });
  it.each([72, "72.", ".72", "72e0", "+72", " 72"])("refuses malformed original transport %s without coercion", raw => {
    const c = ctx({ original: original({ widthDecimal: raw as string }) });
    expect(validateVerification(c, vDraft(c), "idle", true)).toBe("observation_required");
    expect(buildVerificationIntent(c, vDraft(c), "idle", true)).toBeNull();
  });
});
