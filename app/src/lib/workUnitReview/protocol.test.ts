import { describe, expect, it } from "vitest";
import { canonicalReviewDecimal, parseUnitReviewPayload, parseUnitReviewReceipt, parseUnitReviewReceiptReply,
  parseUnitReviewReply, UnitReviewProtocolError } from "./protocol";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const UNIT = id(1), COMMAND = id(2), AT = "2026-10-04T12:00:00.000123Z";
const basis = () => ({ unitId: UNIT, unitRevision: 3, factId: id(3), factRevision: 2, scopeToken: "ur1:" + "a".repeat(64),
  reviewRevision: 0, submissionId: null, generation: 0 });
const view = () => ({ basis: basis(), basisStatus: "current", capabilities: { verifyDimensions: true, submit: true,
  pass: false, fail: false, claimResolved: false, reopen: false },
  observation: { observerId: id(4), source: "estimated", widthDecimal: "1.000000000000000001", heightDecimal: "72", unit: "in", sourceReference: "original estimate" },
  dimensionVerification: { state: "unverified", verificationId: null },
  qc: { state: "not_submitted", acceptance: "not_accepted", lifecycle: "unproven", qcAccepted: false },
  work: { availability: "available", activeCount: 0, pendingCount: 0 }, defects: [] as unknown[] });
const reply = () => ({ protocolVersion: 1, asOf: AT, availability: "available", review: view() });
const verify = () => ({ action: "verify_dimensions", basis: basis(), data: { widthDecimal: "0001.00000000000000000100", heightDecimal: "072.00", unit: "in", source: "measured", sourceReference: "tape at opening" } });
const receipt = () => ({ protocolVersion: 1, commandId: COMMAND, action: "verify_dimensions", unitId: UNIT, eventId: id(5),
  reviewRevision: 1, generation: 0, submissionId: null, recordedAt: AT, outcome: "applied" });

describe("exact unit review boundary", () => {
  it("retains original estimate and exact corroboration without numeric conversion", () => {
    const raw = reply(), parsed = parseUnitReviewReply(raw, UNIT);
    expect(parsed.availability).toBe("available");
    if (parsed.availability !== "available") throw Error();
    expect(parsed.review.observation).toEqual(raw.review.observation);
    expect(parseUnitReviewPayload(verify())).toMatchObject({ data: { widthDecimal: "1.000000000000000001", heightDecimal: "72" } });
    expect(raw.review.observation.source).toBe("estimated");
  });
  it.each(["0", "0.00", "-1", "+1", ".5", "72.", "1e2", "NaN", "Infinity", " 1", "1 ", "1,5", "1".repeat(101), 1, null])("rejects ambiguous decimal %j", raw => {
    expect(() => canonicalReviewDecimal(raw)).toThrow(UnitReviewProtocolError);
  });
  it("uses exact rational size boundaries rather than rounded JS numbers", () => {
    const raw = verify(); raw.data.unit = "ft"; raw.data.widthDecimal = "8333.333333333333333";
    expect(() => parseUnitReviewPayload(raw)).not.toThrow();
    raw.data.widthDecimal = "8333.333333333333334";
    expect(() => parseUnitReviewPayload(raw)).toThrow(UnitReviewProtocolError);
    raw.data.unit = "mm"; raw.data.widthDecimal = "2540000";
    expect(() => parseUnitReviewPayload(raw)).not.toThrow();
    raw.data.widthDecimal = "2540000.000000000000001";
    expect(() => parseUnitReviewPayload(raw)).toThrow(UnitReviewProtocolError);
  });
  it("requires a permission-safe unavailable envelope without hidden details", () => {
    const unavailable = { protocolVersion: 1, asOf: AT, availability: "unavailable", review: null };
    expect(parseUnitReviewReply(unavailable, UNIT)).toEqual(unavailable);
    expect(() => parseUnitReviewReply({ ...unavailable, hiddenCount: 2 }, UNIT)).toThrow();
    expect(() => parseUnitReviewReply({ ...unavailable, review: view() }, UNIT)).toThrow();
  });
  it("accepts an authorized missing fact with no review authority", () => {
    const raw = reply();
    Object.assign(raw.review, { basis: null, basisStatus: "unavailable", observation: null,
      capabilities: { verifyDimensions: false, submit: false, pass: false, fail: false, claimResolved: false, reopen: false } });
    expect(() => parseUnitReviewReply(raw, UNIT)).not.toThrow();
    raw.review.capabilities.submit = true;
    expect(() => parseUnitReviewReply(raw, UNIT)).toThrow();
  });
  it("keeps claimed and verified corrections distinct and rejects false accepted QC", () => {
    const raw = reply(); raw.review.defects = [{ id: id(6), summary: "Fix seal", state: "claimed_resolved" }];
    const parsed = parseUnitReviewReply(raw, UNIT);
    expect(parsed.availability === "available" && parsed.review.defects[0].state).toBe("claimed_resolved");
    Object.assign(raw.review.qc, { state: "passed", acceptance: "accepted", lifecycle: "proven", qcAccepted: true });
    expect(() => parseUnitReviewReply(raw, UNIT)).toThrow();
    raw.review.defects = [{ id: id(6), summary: "Fix seal", state: "verified_resolved" }];
    expect(() => parseUnitReviewReply(raw, UNIT)).not.toThrow();
    raw.review.work.activeCount = 1;
    expect(() => parseUnitReviewReply(raw, UNIT)).toThrow();
  });
  it.each(["qcAccepted", "unitId", "timestamp", "token", "defects", "observer", "verification", "canonical", "work"]) ("refuses malformed %s without yielding a view", kind => {
    const raw = reply();
    switch (kind) {
      case "qcAccepted": raw.review.qc.qcAccepted = true; break;
      case "unitId": raw.review.basis.unitId = id(99); break;
      case "timestamp": raw.asOf = "2026-02-30T12:00:00Z"; break;
      case "token": raw.review.basis.scopeToken = "client fabricated"; break;
      case "defects": raw.review.defects = [{ id: id(6), summary: "Fix", state: "invented" }]; break;
      case "observer": Object.assign(raw.review.observation, { observerId: null }); break;
      case "verification": raw.review.dimensionVerification.state = "verified"; break;
      case "canonical": raw.review.observation.widthDecimal = "01.00"; break;
      case "work": Object.assign(raw.review.work, { availability: "unavailable" }); break;
    }
    expect(() => parseUnitReviewReply(raw, UNIT)).toThrow(UnitReviewProtocolError);
  });
  it("permits rejection of real existing claims without inventing new defects", () => {
    expect(parseUnitReviewPayload({ action: "fail", basis: basis(), data: { note: "Claim was not fixed", defects: [] } })).toMatchObject({ data: { defects: [] } });
    const data = { note: null, defectIds: [id(9), id(8)] };
    expect(parseUnitReviewPayload({ action: "claim_resolved", basis: basis(), data })).toMatchObject({ data: { defectIds: [id(8), id(9)] } });
    expect(data.defectIds).toEqual([id(9), id(8)]);
    expect(() => parseUnitReviewPayload({ action: "claim_resolved", basis: basis(), data: { ...data, defectIds: [id(8), id(8)] } })).toThrow();
  });
  it("rejects oversized and hostile values before serialization", () => {
    expect(() => parseUnitReviewPayload({ action: "submit", basis: basis(), data: { note: "😀".repeat(2001) } })).toThrow();
    expect(() => parseUnitReviewPayload({ action: "submit", basis: basis(), data: { note: "\ud800" } })).toThrow();
    const raw = verify(); Object.defineProperty(raw, "action", { get() { throw Error("do not invoke"); } });
    expect(() => parseUnitReviewPayload(raw)).toThrow(UnitReviewProtocolError);
    expect(() => parseUnitReviewPayload({ ...verify(), actorId: id(4) })).toThrow();
  });
  it("binds receipts to the exact original and never turns history into current QC", () => {
    const original = parseUnitReviewPayload(verify());
    expect(parseUnitReviewReceipt(receipt(), COMMAND, original)).not.toHaveProperty("qcAccepted");
    expect(() => parseUnitReviewReceipt({ ...receipt(), unitId: id(9) }, COMMAND, original)).toThrow();
    expect(() => parseUnitReviewReceipt({ ...receipt(), action: "pass" }, COMMAND, original)).toThrow();
    expect(() => parseUnitReviewReceipt({ ...receipt(), commandId: id(9) }, COMMAND)).toThrow();
    expect(parseUnitReviewReceiptReply({ protocolVersion: 1, availability: "unavailable", receipt: null }, COMMAND)).toEqual({ protocolVersion: 1, availability: "unavailable", receipt: null });
    expect(() => parseUnitReviewReceiptReply({ protocolVersion: 1, availability: "unavailable", receipt: receipt() }, COMMAND)).toThrow();
  });
});
