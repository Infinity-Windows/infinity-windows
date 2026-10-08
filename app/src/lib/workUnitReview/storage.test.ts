import { describe, expect, it } from "vitest";
import { bindReviewReceipt, freezeReviewOriginal, parseReviewJournalRecord, REVIEW_LEASE_MS, reviewDeliveryState } from "./storage";
import type { ReviewPayload, ReviewReceipt } from "./protocol";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const basis = { unitId: id(1), unitRevision: 3, factId: id(2), factRevision: 1, scopeToken: `ur1:${"a".repeat(64)}`,
  reviewRevision: 2, submissionId: id(3), generation: 4 };
const payload = (): ReviewPayload => ({ action: "verify_dimensions", basis: { ...basis }, data: {
  widthDecimal: "0001.00000000000000000100", heightDecimal: "072.00", unit: "in", source: "measured", sourceReference: "tape" } });
const receipt = (): ReviewReceipt => ({ protocolVersion: 1, commandId: id(4), action: "verify_dimensions", unitId: id(1), eventId: id(5),
  reviewRevision: 3, generation: 4, submissionId: id(3), recordedAt: "2026-10-04T10:00:00Z", outcome: "applied" });
const row = () => ({ version: 1, durability: "strict", ownerId: id(6), unitId: id(1), commandId: id(4), sequence: 0,
  predecessorId: null, revision: 0, payload: payload(), attempts: [], receipt: null });

describe("frozen unit review original and historical receipt", () => {
  it("freezes exact significant digits and original defect identities without mutating the caller", () => {
    const input = payload(), original = freezeReviewOriginal(id(4), input);
    expect(original.payload).toMatchObject({ data: { widthDecimal: "1.000000000000000001", heightDecimal: "72" } });
    expect(Object.isFrozen(original.payload.data)).toBe(true);
    input.basis.reviewRevision = 90;
    expect(original.payload.basis.reviewRevision).toBe(2);
    const defects = [{ id: id(9), summary: "Seal" }, { id: id(8), summary: "Frame" }];
    const failure = freezeReviewOriginal(id(4), { action: "fail", basis, data: { note: "Inspect", defects } });
    defects[0].id = id(99);
    expect(failure.payload).toMatchObject({ data: { defects: [{ id: id(8), summary: "Frame" }, { id: id(9), summary: "Seal" }] } });
  });
  it("canonicalizes UUID spelling before persistence and refuses duplicate identities after normalization", () => {
    const lower = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", upper = lower.toUpperCase();
    const p: ReviewPayload = { action: "fail", basis: { ...basis, unitId: upper, factId: upper }, data: { note: "Fix", defects: [{ id: upper, summary: "Seal" }] } };
    expect(freezeReviewOriginal(upper, p)).toMatchObject({ commandId: lower, payload: { basis: { unitId: lower, factId: lower }, data: { defects: [{ id: lower }] } } });
    p.data.defects.push({ id: lower, summary: "Same defect" });
    expect(() => freezeReviewOriginal(upper, p)).toThrow();
    expect(() => freezeReviewOriginal(upper, { action: "claim_resolved", basis, data: { note: null, defectIds: [upper, lower] } })).toThrow();
  });
  it.each(["commandId", "unitId", "action", "reviewRevision", "generation", "submissionId"])("rejects receipt bound to wrong %s", field => {
    const bad = { ...receipt(), [field]: field === "action" ? "pass" : ["reviewRevision", "generation"].includes(field) ? 99 : id(99) };
    expect(() => bindReviewReceipt(bad, freezeReviewOriginal(id(4), payload()))).toThrow();
  });
  it("checks submit, reopen, and both lawful claim transition shapes", () => {
    const original = (action: "submit" | "reopen" | "claim_resolved") => freezeReviewOriginal(id(4), action === "claim_resolved"
      ? { action, basis, data: { note: null, defectIds: [id(9)] } } : { action, basis, data: { note: null } });
    expect(bindReviewReceipt({ ...receipt(), action: "submit", generation: 5, submissionId: id(5) }, original("submit"))).toBeTruthy();
    expect(() => bindReviewReceipt({ ...receipt(), action: "submit", generation: 5 }, original("submit"))).toThrow();
    expect(bindReviewReceipt({ ...receipt(), action: "reopen", generation: 5, submissionId: null }, original("reopen"))).toBeTruthy();
    expect(bindReviewReceipt({ ...receipt(), action: "claim_resolved" }, original("claim_resolved"))).toBeTruthy();
    expect(bindReviewReceipt({ ...receipt(), action: "claim_resolved", generation: 5, submissionId: id(5) }, original("claim_resolved"))).toBeTruthy();
    expect(() => bindReviewReceipt({ ...receipt(), action: "claim_resolved", generation: 5 }, original("claim_resolved"))).toThrow();
  });
  it("never erases earlier unknown delivery with a later known refusal or held attempt", () => {
    const prior = { purpose: "deliver", token: id(10), startedAt: 0, leaseUntil: REVIEW_LEASE_MS, outcome: "unknown", sqlState: null };
    for (const outcome of ["refused", "held"]) {
      const parsed = parseReviewJournalRecord({ ...row(), attempts: [prior, { ...prior, purpose: "deliver", token: id(11), outcome, sqlState: outcome === "refused" ? "23514" : null }] });
      expect(reviewDeliveryState(parsed)).toBe("unknown");
      expect(reviewDeliveryState(parseReviewJournalRecord({ ...parsed, receipt: receipt() }))).toBe("recorded");
    }
  });
  it("treats a crashed pending lease as unknown and rejects malformed persisted history", () => {
    const attempt = { purpose: "deliver", token: id(10), startedAt: 0, leaseUntil: REVIEW_LEASE_MS, outcome: "pending", sqlState: null };
    expect(reviewDeliveryState(parseReviewJournalRecord({ ...row(), attempts: [attempt] }))).toBe("unknown");
    for (const attempts of [[{ ...attempt, leaseUntil: 3 }], [attempt, { ...attempt, purpose: "deliver", token: id(11) }], [{ ...attempt, outcome: "refused" }], [{ ...attempt, outcome: "recorded" }]]) {
      expect(() => parseReviewJournalRecord({ ...row(), attempts })).toThrow();
    }
    expect(() => parseReviewJournalRecord({ ...row(), unexpected: "private view" })).toThrow();
  });
});


describe("strict original evidence and permanent cancellation", () => {
  it("rejects older unmarked records instead of assuming their first attempt never dispatched", () => {
    const old: Record<string, unknown> = row(); delete old.durability;
    expect(() => parseReviewJournalRecord(old)).toThrow();
    expect(() => parseReviewJournalRecord({ ...row(), durability: "relaxed" })).toThrow();
  });
  it("retains every uncertain attempt behind an exactly bound cancellation receipt", () => {
    const original = freezeReviewOriginal(id(4), payload());
    const cancellation = { protocolVersion: 1, commandId: id(4), action: original.payload.action, unitId: id(1),
      recordedAt: "2026-10-04T10:00:00Z", outcome: "cancelled", original: original.payload };
    const saved = parseReviewJournalRecord({ ...row(), attempts: [{ token: id(10), purpose: "deliver", startedAt: 0,
      leaseUntil: REVIEW_LEASE_MS, outcome: "unknown", sqlState: null }], receipt: cancellation });
    expect(reviewDeliveryState(saved)).toBe("cancelled"); expect(saved.attempts[0].outcome).toBe("unknown");
    expect(() => bindReviewReceipt({ ...cancellation, original: { ...original.payload, basis: { ...basis, reviewRevision: 99 } } }, original)).toThrow();
  });
});
