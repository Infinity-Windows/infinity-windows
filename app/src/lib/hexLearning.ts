import { supabase } from "./supabase";
import { discardFailed, enqueue, listFailed } from "./offline/outbox";
import { isMissingFunction } from "./schemaErrors";
import { sessionUserIs } from "./fieldAsk";
import { normalizeLearning, type LearningContent, type LearningHeading, type ReviewerLookup } from "../../../supabase/functions/_shared/learningTools";
import type { BridgeResult } from "../../../supabase/functions/_shared/hexReviewBridge";

/**
 * Lesson write-ups on existing Hex-Portal cases, their named review and their
 * supervisor approval (20261026000000_hex_learning_review.sql). Every read and
 * write is an RPC that re-checks the caller; nothing here decides who may see,
 * approve or send.
 *
 * Drafts go through the durable outbox, bound to the account that wrote them,
 * so a dead zone keeps them ("saved on this phone"). Sending, deciding and
 * withdrawing are online only, and every one carries the account that tapped
 * (p_actor): if the phone signed in as someone else in between, the server
 * refuses it rather than writing under the new account.
 */

export type ReviewState = "draft" | "submitted" | "changes_requested" | "approved" | "withdrawn";
export interface ReviewPerson { id: string; name: string }
export type DeliveryStatus = "pending" | "needs_link" | "pilot_paused" | "failed" | "delivered" | "removed_remote";
export interface LearningDelivery {
  revision: number; status: DeliveryStatus; attempts: number; last_attempt_at: string | null; last_error: string | null;
  receipt_id: string | null; received_at: string | null;
}
export interface LearningWithdrawal {
  status: "pending" | "failed" | "removed"; reason: string; withdrawn_at: string; withdrawn_by: ReviewPerson | null; attempts: number;
  last_error: string | null; receipt_id: string | null; received_at: string | null; withdrawal_event_id: string;
}
export interface LearningReview {
  id: string; case_id: string; project_id: string; state: ReviewState; revision: number;
  job: { name: string; job_code: string | null } | null; unit_id: string | null; unit_label: string; question: string; request_id: string | null;
  author: ReviewPerson; reviewer: (ReviewPerson & { available: boolean; can_approve: boolean }) | null;
  content: LearningContent; missing: LearningHeading[];
  submitted_at: string | null; decided_at: string | null; decided_by: ReviewPerson | null; decided_as_oversight: boolean;
  created_via: "form" | "ask"; created_at: string; updated_at: string; last_note: string | null;
  approved_revision: number | null; approval_event_id: string | null;
  delivery: LearningDelivery | null; withdrawal: LearningWithdrawal | null;
}
export interface LearningHistoryEntry {
  revision: number; action: "draft_saved" | "submitted" | "reassigned" | "forwarded" | "changes_requested" | "approved" | "withdrawn"; state: ReviewState;
  actor: ReviewPerson | null; reviewer: ReviewPerson | null; oversight: boolean; note: string; content: LearningContent; at: string;
}
export interface LearningReviewDetail extends LearningReview {
  case: { question: string; answer: string; unit_label: string; created_at: string };
  outcomes: { outcome: "resolved" | "needs-help"; explanation: string; created_at: string }[];
  /** Every field message the write-up was built from, in order; the words are the
   * originals and the recording paths are the server's, not a client's. */
  sources: { id: string; input_kind: "text" | "voice"; transcript: string; sent_at: string; audio_path: string | null }[];
  history: LearningHistoryEntry[];
  viewer: { is_author: boolean; is_reviewer: boolean; can_approve: boolean; can_oversee: boolean; can_retry: boolean; can_withdraw: boolean; can_send_withdrawal: boolean };
}

/** The server has not been updated with this feature yet: screens show empty. */
export class LearningUnavailable extends Error {
  constructor() { super("learning_review_unavailable"); this.name = "LearningUnavailable"; }
}
const guard = (error: unknown): never => { throw isMissingFunction(error) ? new LearningUnavailable() : error; };

/** Another screen changed the write-up first; nothing was written. */
export const isStaleRevision = (error: unknown) => (error as { hint?: string } | null)?.hint === "stale_revision";

export async function listLearningReviews(scope: "mine" | "assigned" | "oversight", projectId?: string | null): Promise<LearningReview[]> {
  const { data, error } = await supabase.rpc("hex_learning_list", { p_scope: scope, p_project: projectId ?? null });
  if (error) guard(error);
  return (data ?? []) as LearningReview[];
}

export async function getLearningReview(id: string): Promise<LearningReviewDetail> {
  const { data, error } = await supabase.rpc("hex_learning_get", { p_review: id });
  if (error) guard(error);
  return data as LearningReviewDetail;
}

/** submit: the author choosing; forward: the named reviewer choosing a
 * supervisor/owner; reassign: a supervisor/owner recovering a stuck write-up. */
export async function findReviewers(projectId: string, name: string, purpose: "submit" | "forward" | "reassign" = "submit", reviewId?: string): Promise<ReviewerLookup> {
  const { data, error } = await supabase.rpc("hex_learning_reviewers", { p_project: projectId, p_name: name.slice(0, 100), p_review: reviewId ?? null, p_purpose: purpose });
  if (error) guard(error);
  return data as ReviewerLookup;
}

export interface DraftSave {
  actorId: string; reviewId: string; caseId: string; expectedRevision: number; content: LearningContent;
  requestId?: string | null; sourceRequestIds?: string[] | null; unitId?: string | null; via: "form" | "ask";
}
/** Queue one save. The action id is fixed now, so every retry is the same save. */
export function saveLearningDraft(d: DraftSave, dependsOn?: string): Promise<string> {
  return enqueue({
    op: "hex_learning_draft",
    dependsOn,
    payload: {
      actorId: d.actorId,
      args: {
        p_review: d.reviewId, p_action: crypto.randomUUID(), p_case: d.caseId, p_expected_revision: d.expectedRevision,
        p_content: d.content, p_request: d.requestId ?? null, p_unit: d.unitId ?? null, p_via: d.via, p_actor: d.actorId,
        p_sources: d.sourceRequestIds?.length ? d.sourceRequestIds : null,
      },
    },
  });
}

/** Did a queued save of this write-up dead-letter (e.g. stale against another screen)? */
export async function draftSaveFailed(reviewId: string): Promise<boolean> {
  try {
    return (await listFailed()).some((e) => e.op === "hex_learning_draft" && (e.payload.args as { p_review?: string } | undefined)?.p_review === reviewId);
  } catch {
    return true; // unknown is not "clear to send"
  }
}

/**
 * The author chose "Show the latest version": their own failed saves of THIS
 * write-up are superseded and leave the stuck queue, so later saves and Send
 * are not blocked forever. Only failed entries, only this review, only this
 * author — nothing queued, nothing of anyone else's. Returns the words dropped,
 * newest first, so the screen can still show them for copying.
 */
export async function supersedeFailedDrafts(reviewId: string, actorId: string): Promise<LearningContent[]> {
  const mine = (await listFailed()).filter((e) => e.op === "hex_learning_draft" && e.payload.actorId === actorId
    && (e.payload.args as { p_review?: string } | undefined)?.p_review === reviewId);
  for (const e of mine) await discardFailed(e.id);
  return mine.map((e) => (e.payload.args as { p_content: LearningContent }).p_content);
}

const sameContent = (a: LearningContent, b: LearningContent) => {
  try { return JSON.stringify(normalizeLearning(a)) === JSON.stringify(normalizeLearning(b)); } catch { return false; }
};
/**
 * Send submits only the exact write-up the author is looking at: the server
 * must hold exactly the revision this screen expects, with exactly this content,
 * and no save of it may have failed. A higher revision from another screen is
 * a conflict to review, never a newer version to send unseen.
 */
export function sendCheck(i: { expected: number; reviewed: LearningContent; latest: { revision: number; content: LearningContent }; failedSave: boolean }): "submit" | "wait_sync" | "conflict" {
  if (i.failedSave || i.latest.revision > i.expected) return "conflict";
  if (i.latest.revision < i.expected) return "wait_sync";
  return sameContent(i.latest.content, i.reviewed) ? "submit" : "conflict";
}

export class OtherAccountError extends Error {
  constructor() { super("other_account"); this.name = "OtherAccountError"; }
}
/** The early check spares a round trip; p_actor is what actually stops a
 * write under an account that signed in after the tap. */
async function asActor<T>(actorId: string, name: string, args: Record<string, unknown>): Promise<T> {
  if (!(await sessionUserIs(actorId))) throw new OtherAccountError();
  const { data, error } = await supabase.rpc(name, { ...args, p_actor: actorId });
  if (error) guard(error);
  return data as T;
}

/** Send to (or, while waiting, re-send to) one exact reviewer the person tapped. */
export const submitLearningReview = (actorId: string, reviewId: string, actionId: string, expectedRevision: number, reviewerId: string) =>
  asActor<LearningReview>(actorId, "hex_learning_submit", { p_review: reviewId, p_action: actionId, p_expected_revision: expectedRevision, p_reviewer: reviewerId });

export type Decision = { kind: "approve" } | { kind: "request_changes" } | { kind: "forward"; to: string };
export const decideLearningReview = (actorId: string, reviewId: string, actionId: string, expectedRevision: number, decision: Decision, note: string, oversight: boolean) =>
  asActor<LearningReview>(actorId, "hex_learning_decide", {
    p_review: reviewId, p_action: actionId, p_expected_revision: expectedRevision, p_decision: decision.kind, p_note: note,
    p_oversight: oversight, p_forward_to: decision.kind === "forward" ? decision.to : null,
  });

export const reassignLearningReview = (actorId: string, reviewId: string, actionId: string, expectedRevision: number, reviewerId: string, reason: string) =>
  asActor<LearningReview>(actorId, "hex_learning_reassign", { p_review: reviewId, p_action: actionId, p_expected_revision: expectedRevision, p_reviewer: reviewerId, p_reason: reason });

export const withdrawLearningReview = (actorId: string, reviewId: string, actionId: string, expectedRevision: number, reason: string) =>
  asActor<LearningReview>(actorId, "hex_learning_withdraw", { p_review: reviewId, p_action: actionId, p_expected_revision: expectedRevision, p_reason: reason });

/** One delivery (or removal) attempt, as the person who tapped. The answer is
 * what the database recorded; only a receipt it stored means received. */
async function bridge(actorId: string, body: Record<string, unknown>): Promise<BridgeResult> {
  if (!(await sessionUserIs(actorId))) throw new OtherAccountError();
  const { data, error } = await supabase.functions.invoke("hex-portal-review", { body: { version: 1, actorId, ...body }, signal: AbortSignal.timeout(30000) });
  if (error) throw error;
  if (!data || typeof data.status !== "string") throw new Error("Hex-Portal did not answer. Nothing was recorded; try again.");
  return data as BridgeResult;
}
export const deliverLearningReview = (actorId: string, r: Pick<LearningReview, "case_id" | "approved_revision" | "approval_event_id">) =>
  bridge(actorId, { kind: "deliver", caseId: r.case_id, revision: r.approved_revision, approvalEventId: r.approval_event_id });
export const sendLearningWithdrawal = (actorId: string, r: Pick<LearningReview, "case_id"> & { withdrawal: Pick<LearningWithdrawal, "withdrawal_event_id"> }) =>
  bridge(actorId, { kind: "withdraw", caseId: r.case_id, withdrawalEventId: r.withdrawal.withdrawal_event_id });
