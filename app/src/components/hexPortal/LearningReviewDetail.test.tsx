// @vitest-environment happy-dom
//
// The review detail mounted under StrictMode (as the app renders it): an
// approval's recorded receipt and a withdrawal's pending removal must reach the
// screen, and each contributing message keeps its own original words and
// recording control. Server calls are mocked; nothing is sent.
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ get: vi.fn(), decide: vi.fn(), deliver: vi.fn(), withdraw: vi.fn(), sendWithdrawal: vi.fn(), find: vi.fn(), memo: vi.fn() }));
vi.mock("../../lib/hexLearning", async (orig) => ({
  ...(await orig<typeof import("../../lib/hexLearning")>()),
  getLearningReview: m.get, decideLearningReview: m.decide, deliverLearningReview: m.deliver, withdrawLearningReview: m.withdraw,
  sendLearningWithdrawal: m.sendWithdrawal, findReviewers: m.find,
}));
vi.mock("../../lib/fieldAsk", () => ({ memoPlaybackUrl: m.memo, sessionUserIs: vi.fn(async () => true) }));

import { LearningReviewDetail } from "./LearningReviewDetail";
import { emptyLearningContent } from "../../../../supabase/functions/_shared/learningTools";
import type { LearningReviewDetail as Detail } from "../../lib/hexLearning";

const content = { ...emptyLearningContent(), issue: "Leak", what_happened: "Corner leaked", impact: "Redo", lesson_learned: "Fold first", preventive_action: "Check" };
const detail = (over: Partial<Detail> = {}): Detail => ({
  id: "rev-1", case_id: "case-1", project_id: "job", state: "submitted", revision: 5, job: { name: "Deck", job_code: "DECK" }, unit_id: null, unit_label: "16",
  question: "q", request_id: "req-1", author: { id: "author", name: "Ana" }, reviewer: { id: "sup", name: "Sam", available: true, can_approve: true },
  content, missing: [], submitted_at: null, decided_at: null, decided_by: null, decided_as_oversight: false, created_via: "ask", created_at: "", updated_at: "",
  last_note: null, approved_revision: null, approval_event_id: null, delivery: null, withdrawal: null,
  case: { question: "What happened?", answer: "Original answer", unit_label: "16", created_at: "" }, outcomes: [],
  sources: [
    { id: "req-1", input_kind: "voice", transcript: "First words", sent_at: "2026-09-23T15:00:00Z", audio_path: "author/req-1/memo.webm" },
    { id: "req-2", input_kind: "voice", transcript: "Second words", sent_at: "2026-09-23T15:05:00Z", audio_path: "author/req-2/memo.webm" },
  ],
  history: [], viewer: { is_author: false, is_reviewer: true, can_approve: true, can_oversee: true, can_retry: false, can_withdraw: false, can_send_withdrawal: false },
  ...over,
});

let root: Root, host: HTMLDivElement;
beforeEach(() => {
  for (const f of Object.values(m)) f.mockReset();
  m.find.mockResolvedValue({ status: "not_named", match: null, choices: [] });
  m.memo.mockResolvedValue(null);
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

const mount = async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => root.render(<StrictMode><QueryClientProvider client={client}><LearningReviewDetail reviewId="rev-1" actorId="sup" /></QueryClientProvider></StrictMode>));
};
const button = (text: RegExp) => [...host.querySelectorAll("button")].find((b) => text.test(b.textContent ?? ""))!;
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

describe("review detail under StrictMode", () => {
  it("stops the original recording and removes its signed source when leaving the actor's screen", async () => {
    m.get.mockResolvedValue(detail());
    m.memo.mockResolvedValue("blob:synthetic-recording");
    await mount(); await settle();
    await act(async () => { button(/Play recording 1/).click(); });
    const audio = host.querySelector("audio")!;
    expect(audio).toBeTruthy();
    expect(audio.getAttribute("src")).toBe("blob:synthetic-recording");
    const pause = vi.spyOn(audio, "pause");
    const load = vi.spyOn(audio, "load");
    await act(async () => { root.render(<div />); });
    expect(pause).toHaveBeenCalledOnce();
    expect(load).toHaveBeenCalledOnce();
    expect(audio.getAttribute("src")).toBeNull();
    expect(host.querySelector("audio")).toBeNull();
  });

  it("lists every contributing message with its own original words and recording control", async () => {
    m.get.mockResolvedValue(detail());
    await mount(); await settle();
    expect(host.textContent).toContain("First words"); expect(host.textContent).toContain("Second words");
    expect(button(/Play recording 1/)).toBeTruthy(); expect(button(/Play recording 2/)).toBeTruthy();
  });

  it("an approval shows the receipt the server recorded, not a guess", async () => {
    m.get.mockResolvedValue(detail());
    const approved = detail({ state: "approved", approved_revision: 6, approval_event_id: "ev", revision: 6 });
    m.decide.mockResolvedValue(approved);
    m.deliver.mockResolvedValue({ status: "delivered", receiptId: "r-1", receivedAt: "2026-09-23T18:00:00Z" });
    await mount(); await settle();
    m.get.mockResolvedValue({ ...approved, delivery: { revision: 6, status: "delivered", attempts: 1, last_attempt_at: null, last_error: null, receipt_id: "r-1", received_at: "2026-09-23T18:00:00Z" },
      viewer: { ...approved.viewer, can_retry: true, can_withdraw: true } });
    await act(async () => { button(/Approve for archive/).click(); });
    await settle();
    expect(m.decide).toHaveBeenCalledWith("sup", "rev-1", expect.any(String), 5, { kind: "approve" }, "", false);
    expect(host.textContent).toContain("Received by Hex-Portal for learning review");
    expect(host.textContent).toContain("r-1");
  });

  it("a waiting-for-link answer says so and keeps Retry", async () => {
    m.get.mockResolvedValue(detail({ state: "approved", approved_revision: 5, approval_event_id: "ev",
      delivery: { revision: 5, status: "needs_link", attempts: 1, last_attempt_at: null, last_error: null, receipt_id: null, received_at: null },
      viewer: { is_author: true, is_reviewer: false, can_approve: false, can_oversee: false, can_retry: true, can_withdraw: false, can_send_withdrawal: false } }));
    await mount(); await settle();
    expect(host.textContent).toContain("waiting for job connection");
    expect(button(/Retry sending/)).toBeTruthy();
    expect(host.textContent).not.toContain("Received by Hex-Portal");
  });

  it("a withdrawal shows it is withdrawn here and removal is not yet confirmed", async () => {
    const approved = detail({ state: "approved", approved_revision: 5, approval_event_id: "ev",
      viewer: { is_author: false, is_reviewer: false, can_approve: true, can_oversee: true, can_retry: true, can_withdraw: true, can_send_withdrawal: false } });
    m.get.mockResolvedValue(approved);
    const withdrawal = { status: "pending" as const, reason: "Detail changed", withdrawn_at: "2026-09-23T19:00:00Z", withdrawn_by: { id: "sup", name: "Sam" }, attempts: 0,
      last_error: null, receipt_id: null, received_at: null, withdrawal_event_id: "wev" };
    m.withdraw.mockResolvedValue({ ...approved, state: "withdrawn", withdrawal });
    m.sendWithdrawal.mockResolvedValue({ status: "failed" });
    await mount(); await settle();
    const reason = [...host.querySelectorAll("textarea")].at(-1)!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(reason, "Detail changed");
      reason.dispatchEvent(new Event("input", { bubbles: true }));
    });
    m.get.mockResolvedValue({ ...approved, state: "withdrawn", withdrawal, viewer: { ...approved.viewer, can_withdraw: false, can_send_withdrawal: true } });
    await act(async () => { button(/^Withdraw from Hex-Portal$/).click(); });
    await settle();
    expect(m.withdraw).toHaveBeenCalledWith("sup", "rev-1", expect.any(String), 5, "Detail changed");
    expect(host.textContent).toContain("Withdrawn here — removal from Hex-Portal not confirmed yet.");
    expect(button(/Retry removal/)).toBeTruthy();
  });
});
