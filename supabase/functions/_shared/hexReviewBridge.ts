/**
 * Sending an approved lesson to the Hex-Portal archive, and taking one back
 * (.scratch/ai-learning-review/BRIDGE-CONTRACT.md). Pure and injectable — no
 * Deno, no global fetch — so the app's Vitest suite drives the whole exchange.
 *
 * The rules this keeps:
 *  - It runs only when a person taps (approval, Retry, Withdraw), as that
 *    person: every proof is read with their own JWT, which Hexcore re-checks.
 *    There is no stored owner credential and no background sender.
 *  - Before sending, the packet must prove THIS caller, THIS exact supervisor
 *    approval and a 64-hex fingerprint. After the receiver answers, the packet
 *    is read again and must be unchanged, or nothing is recorded.
 *  - Only a response that repeats the exact ids, revision and fingerprint with
 *    a receipt id and time is "delivered". HTTP 200 alone is not; needs_link and
 *    pilot_paused are answers, never receipts.
 *  - The recorders are service-only database functions that re-check the
 *    approval (and refuse a withdrawn lesson) before writing anything.
 */

export const HEX_REVIEWS_URL = "https://hexcore-observatory.ammonson17.chatgpt.site/api/hex-portal/reviews";
export const HEX_WITHDRAW_URL = `${HEX_REVIEWS_URL}/withdraw`;
export const MAX_REQUEST_BYTES = 2000;
export const MAX_RESPONSE_BYTES = 8000;
export const RECEIVER_TIMEOUT_MS = 12000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const isUuid = (v: unknown): v is string => typeof v === "string" && UUID.test(v);
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const exactKeys = (o: Record<string, unknown>, keys: string[]) => Object.keys(o).length === keys.length && keys.every((k) => k in o);
const isInstant = (v: unknown): v is string => typeof v === "string" && v.length <= 40 && Number.isFinite(Date.parse(v));
const isReceipt = (v: unknown): v is string => typeof v === "string" && v.length >= 1 && v.length <= 200;

export type BridgeRequest =
  | { version: 1; kind: "deliver"; actorId: string; caseId: string; revision: number; approvalEventId: string }
  | { version: 1; kind: "withdraw"; actorId: string; caseId: string; withdrawalEventId: string };

/** The phone's request, exactly, or null. */
export function parseBridgeRequest(body: unknown): BridgeRequest | null {
  if (!isObject(body) || body.version !== 1 || !isUuid(body.actorId) || !isUuid(body.caseId)) return null;
  if (body.kind === "deliver" && exactKeys(body, ["version", "kind", "actorId", "caseId", "revision", "approvalEventId"])
      && Number.isSafeInteger(body.revision) && (body.revision as number) > 0 && isUuid(body.approvalEventId)) {
    return body as BridgeRequest;
  }
  if (body.kind === "withdraw" && exactKeys(body, ["version", "kind", "actorId", "caseId", "withdrawalEventId"]) && isUuid(body.withdrawalEventId)) {
    return body as BridgeRequest;
  }
  return null;
}

export const SECTION_KEYS = ["issue", "whatHappened", "impact", "lessonLearned", "preventiveAction"] as const;
export type SectionKey = (typeof SECTION_KEYS)[number];
const isRole = (v: unknown) => v === "supervisor" || v === "owner";
const isCount = (v: unknown) => v === null || (typeof v === "number" && Number.isSafeInteger(v) && v >= 0);

export interface ReviewPacket {
  version: 1; caseId: string; projectId: string; revision: number; reviewerId: string; reviewerRole: "supervisor" | "owner";
  approvalEventId: string; approvedAt: string; revisionFingerprint: string; status: "approved"; authorId: string; unitLabel: string | null;
  callerId: string; deliveryAuthorized: true; sections: Record<SectionKey, string | null>;
  unknownFields?: SectionKey[]; selfReportedImpact?: { minutes: number | null; costCents: number | null };
}

/**
 * The approved snapshot's own consistency: exactly the five sections; a null
 * section only where the author said Unknown, or Impact given only as
 * self-reported minutes/cost. Nothing missing is ever invented or dropped.
 */
function sectionsConsistent(p: Record<string, unknown>): boolean {
  const sections = p.sections, unknown = p.unknownFields ?? [], impact = p.selfReportedImpact;
  if (!isObject(sections) || !exactKeys(sections, [...SECTION_KEYS])) return false;
  if (!Array.isArray(unknown) || unknown.some((k) => !SECTION_KEYS.includes(k as SectionKey)) || new Set(unknown).size !== unknown.length) return false;
  if (impact !== undefined && !(isObject(impact) && exactKeys(impact, ["minutes", "costCents"]) && isCount(impact.minutes) && isCount(impact.costCents))) return false;
  const quantified = isObject(impact) && (impact.minutes !== null || impact.costCents !== null);
  return SECTION_KEYS.every((k) => {
    const v = sections[k];
    if (typeof v === "string") return v.length > 0 && !unknown.includes(k);
    return v === null && (unknown.includes(k) || (k === "impact" && quantified));
  });
}

/** The packet proves this caller and this exact supervisor/owner approval, or it is refused.
 * The approver may be the author (explicit own approval, issues/08); the role
 * proof is what matters, never a foreman review. */
export function reviewPacketProof(p: unknown, want: { callerId: string; caseId: string; revision: number; approvalEventId: string }): ReviewPacket | null {
  if (!isObject(p)) return null;
  const ok = p.version === 1 && p.status === "approved" && p.deliveryAuthorized === true && p.callerId === want.callerId
    && p.caseId === want.caseId && p.revision === want.revision && p.approvalEventId === want.approvalEventId
    && isUuid(p.projectId) && isUuid(p.authorId) && isUuid(p.reviewerId) && isRole(p.reviewerRole)
    && isInstant(p.approvedAt) && (p.unitLabel === null || typeof p.unitLabel === "string")
    && typeof p.revisionFingerprint === "string" && HEX64.test(p.revisionFingerprint) && sectionsConsistent(p);
  return ok ? (p as unknown as ReviewPacket) : null;
}

export const WITHDRAWAL_PACKET_KEYS = ["version", "caseId", "projectId", "withdrawalEventId", "withdrawnAt", "withdrawnBy", "withdrawnByRole",
  "callerId", "callerRole", "withdrawalAuthorized", "revisionFingerprint"] as const;
export interface WithdrawalPacket {
  version: 1; caseId: string; projectId: string; withdrawalEventId: string; withdrawnAt: string; withdrawnBy: string;
  withdrawnByRole: "supervisor" | "owner"; callerId: string; callerRole: "supervisor" | "owner"; withdrawalAuthorized: true; revisionFingerprint: string;
}

/** withdrawnBy/Role are history; callerId/callerRole prove the CURRENT
 * supervisor or owner completing removal. The old actors need not be current. */
export function withdrawalPacketProof(p: unknown, want: { callerId: string; caseId: string; withdrawalEventId: string }): WithdrawalPacket | null {
  if (!isObject(p)) return null;
  const ok = exactKeys(p, [...WITHDRAWAL_PACKET_KEYS]) && p.version === 1 && p.withdrawalAuthorized === true && p.callerId === want.callerId
    && isRole(p.callerRole) && p.caseId === want.caseId && p.withdrawalEventId === want.withdrawalEventId && isUuid(p.projectId)
    && isUuid(p.withdrawnBy) && isRole(p.withdrawnByRole) && isInstant(p.withdrawnAt)
    && typeof p.revisionFingerprint === "string" && HEX64.test(p.revisionFingerprint);
  return ok ? (p as unknown as WithdrawalPacket) : null;
}

/** The request body, exactly as the contract lists it. */
export const deliveryBody = (p: ReviewPacket) =>
  ({ version: 1, caseId: p.caseId, revision: p.revision, reviewerId: p.reviewerId, approvalEventId: p.approvalEventId });
export const withdrawalBody = (p: WithdrawalPacket) => ({ version: 1, caseId: p.caseId, withdrawalEventId: p.withdrawalEventId });

export type DeliveryOutcome =
  | { outcome: "delivered" | "removed_remote"; receiptId: string; receivedAt: string }
  | { outcome: "needs_link" | "pilot_paused" }
  | { outcome: "failed"; error: string };

/** What the receiver said, checked against the packet that was sent. */
export function readDeliveryResponse(httpStatus: number, body: unknown, p: ReviewPacket): DeliveryOutcome {
  if (httpStatus !== 200 || !isObject(body)) return { outcome: "failed", error: "receiver_error" };
  if (body.status === "delivered") {
    const exact = body.caseId === p.caseId && body.revision === p.revision && body.approvalEventId === p.approvalEventId
      && body.revisionFingerprint === p.revisionFingerprint && isReceipt(body.receiptId) && isInstant(body.receivedAt);
    return exact ? { outcome: "delivered", receiptId: body.receiptId as string, receivedAt: body.receivedAt as string } : { outcome: "failed", error: "receipt_mismatch" };
  }
  if ((body.status === "needs_link" || body.status === "pilot_paused") && exactKeys(body, ["status"])) return { outcome: body.status };
  // A Hexcore owner removed it on their side: terminal, never an archive delivery.
  if (body.status === "withdrawn") {
    return body.caseId === p.caseId && isReceipt(body.receiptId) && isInstant(body.receivedAt)
      ? { outcome: "removed_remote", receiptId: body.receiptId as string, receivedAt: body.receivedAt as string }
      : { outcome: "failed", error: "receipt_mismatch" };
  }
  return { outcome: "failed", error: "unexpected_response" };
}

export type WithdrawalOutcome = { outcome: "removed"; receiptId: string; receivedAt: string } | { outcome: "failed"; error: string };

export function readWithdrawalResponse(httpStatus: number, body: unknown, p: WithdrawalPacket): WithdrawalOutcome {
  if (httpStatus !== 200 || !isObject(body)) return { outcome: "failed", error: "receiver_error" };
  const exact = body.status === "withdrawn" && body.caseId === p.caseId && body.withdrawalEventId === p.withdrawalEventId
    && isReceipt(body.receiptId) && isInstant(body.receivedAt);
  return exact ? { outcome: "removed", receiptId: body.receiptId as string, receivedAt: body.receivedAt as string } : { outcome: "failed", error: "receipt_mismatch" };
}

// ---------------------------------------------------------------------------
// The exchange
// ---------------------------------------------------------------------------
type Rpc = (name: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: unknown }>;
export interface BridgeDeps {
  /** As the calling person (their JWT). */
  callerRpc: Rpc;
  /** Service role: only the two recorders. */
  serviceRpc: Rpc;
  /** Posts JSON with the transport secret and the caller's JWT; returns status and a size-capped body (null if over the cap). */
  post: (url: string, body: unknown) => Promise<{ status: number; text: string | null }>;
  /** Whether the server-side transport secret exists; nothing is sent without it. */
  configured: boolean;
}

/** What the database recorded (not what the receiver claimed), plus this attempt's receipt when it carried one. */
export interface BridgeResult {
  status: "delivered" | "removed_remote" | "removed" | "needs_link" | "pilot_paused" | "failed" | "not_current" | "not_configured";
  receiptId?: string; receivedAt?: string;
}

const parse = (text: string | null): unknown => {
  if (text === null) return null;
  try { return JSON.parse(text); } catch { return null; }
};

/** One tap's delivery or withdrawal, for the verified caller. */
export async function runBridge(deps: BridgeDeps, req: BridgeRequest, verifiedUserId: string): Promise<BridgeResult> {
  if (req.actorId !== verifiedUserId) return { status: "not_current" };
  if (req.kind === "deliver") {
    const want = { callerId: verifiedUserId, caseId: req.caseId, revision: req.revision, approvalEventId: req.approvalEventId };
    const readPacket = async () => {
      const { data, error } = await deps.callerRpc("hex_portal_review_packet", { p_case_id: req.caseId, p_revision: req.revision, p_approval_event_id: req.approvalEventId });
      return error ? null : reviewPacketProof(data, want);
    };
    const before = await readPacket();
    if (!before) return { status: "not_current" };
    if (!deps.configured) return { status: "not_configured" };
    let answer: DeliveryOutcome;
    try {
      const res = await deps.post(HEX_REVIEWS_URL, deliveryBody(before));
      answer = readDeliveryResponse(res.status, parse(res.text), before);
    } catch {
      answer = { outcome: "failed", error: "receiver_unreachable" };
    }
    // A receipt counts only if the approval it names is still exactly current.
    if (answer.outcome === "delivered" || answer.outcome === "removed_remote") {
      const after = await readPacket();
      if (!after || after.revisionFingerprint !== before.revisionFingerprint || after.reviewerId !== before.reviewerId) {
        answer = { outcome: "failed", error: "changed_during_delivery" };
      }
    }
    const { data, error } = await deps.serviceRpc("hex_learning_record_delivery", {
      p_case_id: before.caseId, p_revision: before.revision, p_approval_event_id: before.approvalEventId, p_fingerprint: before.revisionFingerprint,
      p_caller: verifiedUserId, p_outcome: answer.outcome,
      p_receipt_id: "receiptId" in answer ? answer.receiptId : null, p_received_at: "receivedAt" in answer ? answer.receivedAt : null,
      p_error: answer.outcome === "failed" ? answer.error : null,
    });
    if (error) return { status: "not_current" };
    // The database's word: a lesson already delivered or removed stays so.
    const recorded = data as BridgeResult["status"];
    return recorded === answer.outcome && "receiptId" in answer ? { status: recorded, receiptId: answer.receiptId, receivedAt: answer.receivedAt } : { status: recorded };
  }
  const want = { callerId: verifiedUserId, caseId: req.caseId, withdrawalEventId: req.withdrawalEventId };
  const { data: wp, error: wpError } = await deps.callerRpc("hex_portal_withdrawal_packet", { p_case_id: req.caseId, p_withdrawal_event_id: req.withdrawalEventId });
  const proof = wpError ? null : withdrawalPacketProof(wp, want);
  if (!proof) return { status: "not_current" };
  if (!deps.configured) return { status: "not_configured" };
  let answer: WithdrawalOutcome;
  try {
    const res = await deps.post(HEX_WITHDRAW_URL, withdrawalBody(proof));
    answer = readWithdrawalResponse(res.status, parse(res.text), proof);
  } catch {
    answer = { outcome: "failed", error: "receiver_unreachable" };
  }
  const { data, error } = await deps.serviceRpc("hex_learning_record_withdrawal", {
    p_case_id: proof.caseId, p_withdrawal_event_id: proof.withdrawalEventId, p_caller: verifiedUserId, p_outcome: answer.outcome,
    p_receipt_id: answer.outcome === "removed" ? answer.receiptId : null, p_received_at: answer.outcome === "removed" ? answer.receivedAt : null,
    p_error: answer.outcome === "failed" ? answer.error : null,
  });
  if (error) return { status: "not_current" };
  const recorded = data as BridgeResult["status"];
  return recorded === "removed" && answer.outcome === "removed" ? { status: recorded, receiptId: answer.receiptId, receivedAt: answer.receivedAt } : { status: recorded };
}
