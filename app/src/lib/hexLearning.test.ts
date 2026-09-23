// Client wrappers for lesson write-ups: actor binding, exact-preview Send and
// schema-missing fallback. Supabase and the outbox are mocked; nothing is sent.
import { beforeEach, describe, expect, it, vi } from "vitest";

const { rpc, invoke, getSession, enqueue, listFailed, discardFailed } = vi.hoisted(() => ({
  rpc: vi.fn(), invoke: vi.fn(), getSession: vi.fn(), enqueue: vi.fn(), listFailed: vi.fn(), discardFailed: vi.fn(),
}));
vi.mock("./supabase", () => ({ supabase: { rpc, functions: { invoke }, auth: { getSession } }, supabaseConfigured: true }));
vi.mock("./offline/outbox", () => ({ enqueue, listFailed, discardFailed }));

import {
  LearningUnavailable, OtherAccountError, decideLearningReview, deliverLearningReview, draftSaveFailed, listLearningReviews, saveLearningDraft,
  sendCheck, submitLearningReview, supersedeFailedDrafts, withdrawLearningReview,
} from "./hexLearning";
import { emptyLearningContent } from "../../../supabase/functions/_shared/learningTools";

const signedIn = (id: string) => getSession.mockResolvedValue({ data: { session: { user: { id } } } });
const content = { ...emptyLearningContent(), issue: "Leak", what_happened: "Corner leaked", unknown: ["impact", "lesson_learned", "preventive_action"] as never };

beforeEach(() => {
  rpc.mockReset().mockResolvedValue({ data: { id: "r", revision: 3 }, error: null });
  invoke.mockReset().mockResolvedValue({ data: { status: "needs_link" }, error: null });
  enqueue.mockReset().mockResolvedValue("entry-1");
  listFailed.mockReset().mockResolvedValue([]);
  signedIn("reviewer-a");
});

describe("actor binding", () => {
  it("every mutation names the account that tapped", async () => {
    await submitLearningReview("reviewer-a", "r", "act", 2, "rev");
    await decideLearningReview("reviewer-a", "r", "act", 3, { kind: "forward", to: "sup" }, "ok", false);
    await withdrawLearningReview("reviewer-a", "r", "act", 5, "reason");
    for (const [, args] of rpc.mock.calls) expect(args).toMatchObject({ p_actor: "reviewer-a" });
    expect(rpc.mock.calls[1][1]).toMatchObject({ p_decision: "forward", p_forward_to: "sup" });
  });
  it("a different signed-in account is refused before any request", async () => {
    signedIn("supervisor-b");
    await expect(decideLearningReview("reviewer-a", "r", "act", 3, { kind: "approve" }, "", false)).rejects.toBeInstanceOf(OtherAccountError);
    await expect(deliverLearningReview("reviewer-a", { case_id: "c", approved_revision: 5, approval_event_id: "e" })).rejects.toBeInstanceOf(OtherAccountError);
    expect(rpc).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
  });
  it("a switch after the session check still carries the original actor, so the server can refuse it", async () => {
    // The phone reports reviewer A, then B's token is used for the RPC: the
    // request still says p_actor = A, which the database compares to auth.uid().
    let calls = 0;
    getSession.mockImplementation(async () => ({ data: { session: { user: { id: calls++ === 0 ? "reviewer-a" : "supervisor-b" } } } }));
    rpc.mockResolvedValueOnce({ data: null, error: { code: "42501", message: "This was started under another sign-in. Nothing was changed." } });
    await expect(decideLearningReview("reviewer-a", "r", "act", 3, { kind: "approve" }, "", false)).rejects.toMatchObject({ code: "42501" });
    expect(rpc.mock.calls[0][1]).toMatchObject({ p_actor: "reviewer-a" });
  });
  it("queued drafts carry the author as p_actor too", async () => {
    await saveLearningDraft({ actorId: "author", reviewId: "r", caseId: "c", expectedRevision: 1, content, via: "form" }, "case-entry");
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({ op: "hex_learning_draft", dependsOn: "case-entry",
      payload: expect.objectContaining({ actorId: "author", args: expect.objectContaining({ p_actor: "author", p_expected_revision: 1 }) }) }));
  });
  it("delivery asks the edge function as the tapping person, with the exact approval", async () => {
    await deliverLearningReview("reviewer-a", { case_id: "c", approved_revision: 5, approval_event_id: "e" });
    expect(invoke).toHaveBeenCalledWith("hex-portal-review", expect.objectContaining({ body: { version: 1, actorId: "reviewer-a", kind: "deliver", caseId: "c", revision: 5, approvalEventId: "e" } }));
  });
});

describe("exact preview Send", () => {
  it("regression: viewed rev 1, another tab made rev 3, the local save against 1 failed — Send must not submit rev 3", async () => {
    listFailed.mockResolvedValue([{ op: "hex_learning_draft", payload: { args: { p_review: "r" } } }]);
    const failed = await draftSaveFailed("r");
    const verdict = sendCheck({ expected: 2, reviewed: content, latest: { revision: 3, content: { ...content, issue: "Other tab" } }, failedSave: failed });
    expect(failed).toBe(true);
    expect(verdict).toBe("conflict");
  });
  it("a higher revision is a conflict even with identical words and no failure", () => {
    expect(sendCheck({ expected: 2, reviewed: content, latest: { revision: 3, content }, failedSave: false })).toBe("conflict");
  });
  it("same revision, different words is a conflict; still-queued is wait; exact is submit", () => {
    expect(sendCheck({ expected: 2, reviewed: content, latest: { revision: 2, content: { ...content, issue: "Changed" } }, failedSave: false })).toBe("conflict");
    expect(sendCheck({ expected: 2, reviewed: content, latest: { revision: 1, content }, failedSave: false })).toBe("wait_sync");
    expect(sendCheck({ expected: 2, reviewed: content, latest: { revision: 2, content: { ...content, unknown: [...content.unknown].reverse() } }, failedSave: false })).toBe("submit");
  });
  it("an unreadable queue is not clear to send", async () => {
    listFailed.mockRejectedValue(new Error("idb"));
    expect(await draftSaveFailed("r")).toBe(true);
  });
});

describe("before the migration reaches the server", () => {
  it("a missing function reads as not available, not a crash", async () => {
    rpc.mockResolvedValue({ data: null, error: { code: "PGRST202", message: "Could not find the function public.hex_learning_list" } });
    await expect(listLearningReviews("mine")).rejects.toBeInstanceOf(LearningUnavailable);
  });
});

describe("Show the latest version supersedes only this author's failed saves of this write-up", () => {
  it("leaves queued work, other write-ups and other accounts alone, and returns the words set aside", async () => {
    const entry = (id: string, actorId: string, review: string, issue: string) => ({ id, op: "hex_learning_draft", payload: { actorId, args: { p_review: review, p_content: { issue } } } });
    listFailed.mockResolvedValue([entry("mine", "author", "r", "Set aside"), entry("other-review", "author", "r2", "x"), entry("other-person", "someone", "r", "y"),
      { id: "photo", op: "photo_upload", payload: { actorId: "author", args: { p_review: "r" } } }]);
    discardFailed.mockReset().mockResolvedValue(undefined);
    expect(await supersedeFailedDrafts("r", "author")).toEqual([{ issue: "Set aside" }]);
    expect(discardFailed.mock.calls).toEqual([["mine"]]);
  });
});
