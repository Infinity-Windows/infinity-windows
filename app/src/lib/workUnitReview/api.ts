import { clientWithToken, supabase } from "../supabase";
import { signInMark, stillSignedInAs, type SignInMark } from "../signedIn";
import { uuid } from "../workConfiguration/model";
import { parseUnitReviewPayload, parseUnitReviewStoredReceipt, parseUnitReviewReceiptReply, parseUnitReviewReply,
  type ReviewPayload, type ReviewReceipt, type ReviewCancellation, type ReviewReceiptReply, type ReviewReply } from "./protocol";

export class UnitReviewUnavailableError extends Error {
  constructor() { super("Unit review is unavailable. Refresh before another action."); this.name = "UnitReviewUnavailableError"; }
}
export type ReviewAttempt = { kind: "applied"; receipt: ReviewReceipt }
  | { kind: "cancelled"; receipt: ReviewCancellation }
  | { kind: "attempt_refused"; sqlState: "23514" | "42501" }
  | { kind: "held" }
  | { kind: "unknown" };
const online = () => typeof navigator === "undefined" || navigator.onLine !== false;
const current = (mark: SignInMark) => !!mark.userId && stillSignedInAs(mark, mark.userId);
async function token(mark: SignInMark): Promise<string> {
  if (!current(mark) || !online()) throw new UnitReviewUnavailableError();
  const { data, error } = await supabase.auth.getSession();
  if (error || !data.session?.access_token || data.session.user.id !== mark.userId || !current(mark) || !online()) throw new UnitReviewUnavailableError();
  return data.session.access_token;
}
/** Fresh read only. The caller owns preview/navigation admission and must not
 * persist this permission-checked view or replace an unavailable result. */
export async function fetchUnitReview(unitId: string, login: SignInMark = signInMark(), admission: () => boolean = () => true): Promise<ReviewReply> {
  try {
    uuid(unitId); const mark = { ...login };
    if (!admission()) throw new UnitReviewUnavailableError();
    const access = await token(mark), client = clientWithToken(access);
    if (!current(mark) || !online() || !admission()) throw new UnitReviewUnavailableError();
    const { data, error } = await client.rpc("work_unit_review_read", { p_unit_id: unitId });
    if (error || !current(mark) || !online() || !admission()) throw new UnitReviewUnavailableError();
    return parseUnitReviewReply(data, unitId);
  } catch { throw new UnitReviewUnavailableError(); }
}
/** No UUID minting, fallback, retries or optimistic currentness. An applied
 * receipt is historical evidence; the caller must fetch the latest review.
 * Refusal applies only to THIS attempt and cannot erase earlier uncertainty. */
export function submitUnitReview(commandId: string, payload: ReviewPayload, login: SignInMark,
  admission: () => boolean): Promise<ReviewAttempt> {
  return sendOriginal("work_unit_review_command", commandId, payload, login, admission);
}
/** Deliberate permanent closure of this UUID, or its existing applied receipt.
 * A held/unknown response never proves cancellation. Never call from polling. */
export function cancelUnitReview(commandId: string, payload: ReviewPayload, login: SignInMark,
  admission: () => boolean): Promise<ReviewAttempt> {
  return sendOriginal("work_unit_review_cancel", commandId, payload, login, admission);
}
async function sendOriginal(rpc: "work_unit_review_command" | "work_unit_review_cancel", commandId: string, payload: ReviewPayload,
  login: SignInMark, admission: () => boolean): Promise<ReviewAttempt> {
  uuid(commandId); const original = parseUnitReviewPayload(payload), mark = { ...login };
  let dispatched = false;
  try {
    if (!admission()) return { kind: "held" };
    const access = await token(mark), client = clientWithToken(access);
    if (!current(mark) || !online() || !admission()) return { kind: "held" };
    dispatched = true;
    const { data, error } = await client.rpc(rpc, {
      p_command_id: commandId, p_protocol_version: 1, p_payload: original,
    });
    if (!current(mark) || !admission()) return { kind: "unknown" };
    if (error) {
      const descriptor = typeof error === "object" ? Object.getOwnPropertyDescriptor(error, "code") : undefined;
      if (descriptor && "value" in descriptor && (descriptor.value === "23514" || descriptor.value === "42501"))
        return { kind: "attempt_refused", sqlState: descriptor.value };
      return { kind: "unknown" };
    }
    const receipt = parseUnitReviewStoredReceipt(data, commandId, original);
    return receipt.outcome === "cancelled" ? { kind: "cancelled", receipt } : { kind: "applied", receipt };
  } catch { return { kind: dispatched ? "unknown" : "held" }; }
}
/** A missing/hidden receipt remains unavailable, not a proof of non-delivery.
 * Reading it never sends the saved decision again. */
export async function fetchUnitReviewReceipt(commandId: string, login: SignInMark,
  admission: () => boolean = () => true): Promise<ReviewReceiptReply> {
  try {
    uuid(commandId); const mark = { ...login };
    if (!admission()) throw new UnitReviewUnavailableError();
    const access = await token(mark), client = clientWithToken(access);
    if (!current(mark) || !online() || !admission()) throw new UnitReviewUnavailableError();
    const { data, error } = await client.rpc("work_unit_review_command_receipt", { p_command_id: commandId });
    if (error || !current(mark) || !admission()) throw new UnitReviewUnavailableError();
    return parseUnitReviewReceiptReply(data, commandId);
  } catch { throw new UnitReviewUnavailableError(); }
}
