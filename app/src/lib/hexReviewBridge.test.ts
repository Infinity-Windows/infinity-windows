// The Hex-Portal delivery and withdrawal exchange (BRIDGE-CONTRACT.md) with
// injected RPCs and receiver. No network, no database, no Hexcore.
import { describe, expect, it } from "vitest";
import {
  HEX_REVIEWS_URL, HEX_WITHDRAW_URL, deliveryBody, parseBridgeRequest, readDeliveryResponse, readWithdrawalResponse, reviewPacketProof, runBridge,
  withdrawalBody, withdrawalPacketProof, type BridgeDeps, type ReviewPacket, type WithdrawalPacket,
} from "../../../supabase/functions/_shared/hexReviewBridge";
import contract from "../../../scripts/fixtures/hex-learning-contract.json";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ME = id(1), OTHER = id(2), SUP = id(3), CASE = id(10), EVENT = id(20), WEVENT = id(30);
const FP = "a".repeat(64);
const packet = (over: Partial<ReviewPacket> = {}): ReviewPacket => ({
  version: 1, caseId: CASE, projectId: id(40), revision: 5, reviewerId: SUP, reviewerRole: "supervisor", approvalEventId: EVENT,
  approvedAt: "2026-09-23T17:00:00.123456+00:00", revisionFingerprint: FP, status: "approved", authorId: ME, unitLabel: "16", callerId: ME,
  deliveryAuthorized: true, sections: { issue: "Leak", whatHappened: "Corner", impact: "Redo", lessonLearned: "Fold first", preventiveAction: "Check" },
  unknownFields: [], selfReportedImpact: { minutes: null, costCents: null }, ...over,
});
const deliver = { version: 1 as const, kind: "deliver" as const, actorId: ME, caseId: CASE, revision: 5, approvalEventId: EVENT };
const receipt = { status: "delivered", receiptId: "hex-1", receivedAt: "2026-09-23T18:00:00Z", caseId: CASE, revision: 5, approvalEventId: EVENT, revisionFingerprint: FP };

function harness(opts: { packets?: unknown[]; response?: { status: number; body: unknown } | "throw"; configured?: boolean; record?: string; wpacket?: unknown }) {
  const calls: { kind: string; name: string; args: unknown }[] = [];
  const packets = [...(opts.packets ?? [packet(), packet()])];
  const deps: BridgeDeps = {
    configured: opts.configured ?? true,
    callerRpc: async (name, args) => {
      calls.push({ kind: "caller", name, args });
      if (name === "hex_portal_withdrawal_packet") return { data: opts.wpacket ?? null, error: opts.wpacket ? null : { message: "not current" } };
      const next = packets.shift();
      return next === undefined ? { data: null, error: { message: "not current" } } : { data: next, error: null };
    },
    serviceRpc: async (name, args) => {
      calls.push({ kind: "service", name, args });
      return { data: opts.record ?? (args as { p_outcome: string }).p_outcome, error: null };
    },
    post: async (url, body) => {
      calls.push({ kind: "post", name: url, args: body });
      if (opts.response === "throw") throw new Error("offline");
      const r = opts.response ?? { status: 200, body: receipt };
      return { status: r.status, text: r.body === null ? null : JSON.stringify(r.body) };
    },
  };
  return { deps, calls, recorded: () => calls.find((c) => c.kind === "service")?.args as Record<string, unknown> | undefined };
}

describe("the phone's request", () => {
  it("is exact: version, kind, uuids and no extra keys", () => {
    expect(parseBridgeRequest(deliver)).toEqual(deliver);
    expect(parseBridgeRequest({ ...deliver, version: 2 })).toBeNull();
    expect(parseBridgeRequest({ ...deliver, reviewerId: SUP })).toBeNull();
    expect(parseBridgeRequest({ ...deliver, revision: 0 })).toBeNull();
    expect(parseBridgeRequest({ ...deliver, caseId: "x" })).toBeNull();
    expect(parseBridgeRequest({ version: 1, kind: "withdraw", actorId: ME, caseId: CASE, withdrawalEventId: WEVENT })).not.toBeNull();
    expect(parseBridgeRequest(null)).toBeNull();
  });
  it("sends exactly the contract body", () => {
    expect(Object.keys(deliveryBody(packet())).sort()).toEqual(["approvalEventId", "caseId", "reviewerId", "revision", "version"]);
  });
});

describe("packet proof", () => {
  it("requires this caller, this approval, a supervisor/owner approver and a 64-hex fingerprint", () => {
    const want = { callerId: ME, caseId: CASE, revision: 5, approvalEventId: EVENT };
    expect(reviewPacketProof(packet(), want)).not.toBeNull();
    for (const bad of [{ callerId: OTHER }, { revision: 4 }, { approvalEventId: id(99) }, { deliveryAuthorized: false as never }, { reviewerRole: "foreman" as never },
      { revisionFingerprint: "A".repeat(64) }, { status: "pending" as never }]) {
      expect(reviewPacketProof(packet(bad), want)).toBeNull();
    }
    // A supervisor/owner who explicitly approved their own write-up (issues/08).
    expect(reviewPacketProof(packet({ reviewerId: ME, authorId: ME, reviewerRole: "owner" }), want)).not.toBeNull();
  });
});

describe("the pinned contract fixture (Hexcore forge-learning-review-contract v1)", () => {
  const cp = contract.reviewPacket as unknown as ReviewPacket, wp = contract.withdrawalPacket as unknown as WithdrawalPacket;
  it("parses the complete packet, with explicit Unknown and numeric-only Impact", () => {
    expect(reviewPacketProof(cp, { callerId: cp.callerId, caseId: cp.caseId, revision: cp.revision, approvalEventId: cp.approvalEventId })).not.toBeNull();
    expect(deliveryBody(cp)).toEqual(contract.deliveryRequest);
    expect(readDeliveryResponse(200, contract.deliveredResponse, cp)).toEqual({ outcome: "delivered", receiptId: "synthetic-receipt-1", receivedAt: contract.deliveredResponse.receivedAt });
    expect(readDeliveryResponse(200, contract.removedInHexcoreResponse, cp).outcome).toBe("removed_remote");
  });
  it("parses the withdrawal proof and its receipt, and sends the exact body", () => {
    const want = { callerId: wp.callerId, caseId: wp.caseId, withdrawalEventId: wp.withdrawalEventId };
    expect(withdrawalPacketProof(wp, want)).not.toBeNull();
    expect(withdrawalBody(wp)).toEqual(contract.withdrawalRequest);
    expect(readWithdrawalResponse(200, contract.withdrawnResponse, wp).outcome).toBe("removed");
    expect(readWithdrawalResponse(200, { ...contract.withdrawnResponse, caseId: ME }, wp)).toEqual({ outcome: "failed", error: "receipt_mismatch" });
  });
  it("never lets a null section through unless it is Unknown or quantified Impact", () => {
    const want = { callerId: cp.callerId, caseId: cp.caseId, revision: cp.revision, approvalEventId: cp.approvalEventId };
    const variants: Partial<ReviewPacket>[] = [
      { unknownFields: [] }, // lessonLearned null, no longer Unknown
      { selfReportedImpact: { minutes: null, costCents: null } }, // impact null with no quantity
      { sections: { ...cp.sections, extra: "x" } as never },
      { unknownFields: ["lessonLearned", "issue"] as never }, // answered heading also Unknown
      { selfReportedImpact: { minutes: -1, costCents: null } },
    ];
    for (const v of variants) expect(reviewPacketProof({ ...cp, ...v }, want)).toBeNull();
  });
  it("the withdrawal proof requires the CURRENT callerRole and the exact receiver key set", () => {
    const want = { callerId: wp.callerId, caseId: wp.caseId, withdrawalEventId: wp.withdrawalEventId };
    const { callerRole: _drop, ...noRole } = wp;
    expect(withdrawalPacketProof(noRole, want)).toBeNull();
    expect(withdrawalPacketProof({ ...wp, callerRole: "foreman" }, want)).toBeNull();
    expect(withdrawalPacketProof({ ...wp, approvedRevision: 5 }, want)).toBeNull();
    // The historical withdrawer's role stays as recorded; it is not re-proved now.
    expect(withdrawalPacketProof({ ...wp, withdrawnByRole: "supervisor", callerRole: "owner" }, want)).not.toBeNull();
  });
});

describe("receiver answers", () => {
  it("HTTP 200 alone is never a delivery", () => {
    expect(readDeliveryResponse(200, { status: "delivered" }, packet()).outcome).toBe("failed");
    expect(readDeliveryResponse(200, { ...receipt, revisionFingerprint: "b".repeat(64) }, packet())).toEqual({ outcome: "failed", error: "receipt_mismatch" });
    expect(readDeliveryResponse(200, { ...receipt, receivedAt: "yesterday" }, packet()).outcome).toBe("failed");
    expect(readDeliveryResponse(500, receipt, packet()).outcome).toBe("failed");
    expect(readDeliveryResponse(200, { status: "needs_link", receiptId: "x" }, packet()).outcome).toBe("failed");
  });
});

describe("delivery", () => {
  it("records an exact receipt after re-reading the unchanged packet", async () => {
    const h = harness({});
    expect(await runBridge(h.deps, deliver, ME)).toEqual({ status: "delivered", receiptId: "hex-1", receivedAt: "2026-09-23T18:00:00Z" });
    expect(h.calls.map((c) => `${c.kind}:${c.name}`)).toEqual([
      "caller:hex_portal_review_packet", `post:${HEX_REVIEWS_URL}`, "caller:hex_portal_review_packet", "service:hex_learning_record_delivery"]);
    expect(h.recorded()).toMatchObject({ p_outcome: "delivered", p_receipt_id: "hex-1", p_fingerprint: FP, p_caller: ME });
  });
  it("needs_link and pilot_paused are recorded without a receipt", async () => {
    for (const status of ["needs_link", "pilot_paused"]) {
      const h = harness({ packets: [packet()], response: { status: 200, body: { status } } });
      expect(await runBridge(h.deps, deliver, ME)).toEqual({ status });
      expect(h.recorded()).toMatchObject({ p_outcome: status, p_receipt_id: null });
    }
  });
  it("a packet that changed during delivery records a failure, not the receipt", async () => {
    const h = harness({ packets: [packet(), packet({ revisionFingerprint: "c".repeat(64) })] });
    expect((await runBridge(h.deps, deliver, ME)).status).toBe("failed");
    expect(h.recorded()).toMatchObject({ p_outcome: "failed", p_error: "changed_during_delivery", p_receipt_id: null });
  });
  it("a withdrawn approval in between (packet refused after) records nothing received", async () => {
    const h = harness({ packets: [packet()] });
    await runBridge(h.deps, deliver, ME);
    expect(h.recorded()).toMatchObject({ p_outcome: "failed", p_receipt_id: null });
  });
  it("another account signed in: nothing is read, sent or recorded", async () => {
    const h = harness({});
    expect(await runBridge(h.deps, deliver, OTHER)).toEqual({ status: "not_current" });
    expect(h.calls).toEqual([]);
  });
  it("a packet issued to a different caller is refused before sending", async () => {
    const h = harness({ packets: [packet({ callerId: OTHER })] });
    expect(await runBridge(h.deps, deliver, ME)).toEqual({ status: "not_current" });
    expect(h.calls.some((c) => c.kind === "post" || c.kind === "service")).toBe(false);
  });
  it("without the server transport secret nothing is sent or recorded", async () => {
    const h = harness({ configured: false });
    expect(await runBridge(h.deps, deliver, ME)).toEqual({ status: "not_configured" });
    expect(h.calls.map((c) => c.kind)).toEqual(["caller"]);
  });
  it("an unreachable or oversized receiver is a retryable failure", async () => {
    for (const response of ["throw", { status: 200, body: null }] as const) {
      const h = harness({ packets: [packet()], response });
      expect((await runBridge(h.deps, deliver, ME)).status).toBe("failed");
    }
  });
  it("a Hexcore-side removal is recorded as removed there, not delivered", async () => {
    const h = harness({ packets: [packet(), packet()], response: { status: 200, body: { status: "withdrawn", caseId: CASE, receiptId: "rm", receivedAt: "2026-09-23T19:00:00Z" } } });
    expect((await runBridge(h.deps, deliver, ME)).status).toBe("removed_remote");
  });
  it("reports what the database recorded, not what the receiver claimed", async () => {
    const h = harness({ packets: [packet()], response: { status: 200, body: { status: "needs_link" } }, record: "delivered" });
    expect(await runBridge(h.deps, deliver, ME)).toEqual({ status: "delivered" });
  });
});

describe("withdrawal", () => {
  const withdraw = { version: 1 as const, kind: "withdraw" as const, actorId: ME, caseId: CASE, withdrawalEventId: WEVENT };
  const wpacket = { version: 1, caseId: CASE, projectId: id(40), withdrawalEventId: WEVENT, withdrawnAt: "2026-09-23T20:00:00Z",
    withdrawnBy: SUP, withdrawnByRole: "supervisor", callerId: ME, callerRole: "owner", withdrawalAuthorized: true, revisionFingerprint: FP };
  it("records removal only with the exact withdrawal receipt", async () => {
    const ok = { status: "withdrawn", receiptId: "w-1", receivedAt: "2026-09-23T20:00:00Z", caseId: CASE, withdrawalEventId: WEVENT };
    const h = harness({ wpacket, response: { status: 200, body: ok } });
    expect(await runBridge(h.deps, withdraw, ME)).toEqual({ status: "removed", receiptId: "w-1", receivedAt: ok.receivedAt });
    expect(h.calls.find((c) => c.kind === "post")!.name).toBe(HEX_WITHDRAW_URL);
    expect(h.calls.find((c) => c.kind === "post")!.args).toEqual({ version: 1, caseId: CASE, withdrawalEventId: WEVENT });
    const wrong = harness({ wpacket, response: { status: 200, body: { ...ok, withdrawalEventId: EVENT } } });
    expect((await runBridge(wrong.deps, withdraw, ME)).status).toBe("failed");
    expect(wrong.recorded()).toMatchObject({ p_outcome: "failed", p_receipt_id: null });
  });
  it("a caller without a current withdrawal proof sends nothing", async () => {
    const h = harness({});
    expect(await runBridge(h.deps, withdraw, ME)).toEqual({ status: "not_current" });
    expect(h.calls.some((c) => c.kind === "post")).toBe(false);
    const foreign = harness({ wpacket: { ...wpacket, callerId: OTHER } });
    expect(await runBridge(foreign.deps, withdraw, ME)).toEqual({ status: "not_current" });
  });
});
