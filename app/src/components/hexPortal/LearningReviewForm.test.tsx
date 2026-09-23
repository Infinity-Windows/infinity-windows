// @vitest-environment happy-dom
//
// The author's form mounted for real: EN/ES headings, one save at a time,
// typing during a save is never overwritten, and Send submits only the exact
// revision and words on screen. The server calls are mocked; sendCheck is real.
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  saveDraft: vi.fn(), submit: vi.fn(), get: vi.fn(), failed: vi.fn(), find: vi.fn(), drain: vi.fn(), saveCase: vi.fn(), supersede: vi.fn(), session: vi.fn(),
}));
vi.mock("../../lib/hexLearning", async (orig) => ({
  ...(await orig<typeof import("../../lib/hexLearning")>()),
  saveLearningDraft: m.saveDraft, submitLearningReview: m.submit, getLearningReview: m.get, draftSaveFailed: m.failed, findReviewers: m.find,
  supersedeFailedDrafts: m.supersede,
}));
vi.mock("../../lib/fieldAsk", () => ({ sessionUserIs: m.session }));
vi.mock("../../lib/offline/outbox", () => ({ drain: m.drain }));
vi.mock("../../lib/hexPortal", () => ({ saveLearningCase: m.saveCase }));
vi.mock("../voice/VoiceTextarea", () => ({ VoiceTextarea: (p: React.TextareaHTMLAttributes<HTMLTextAreaElement>) => <textarea {...p} /> }));

import { LearningReviewForm } from "./LearningReviewForm";
import { LanguageContext } from "../../lib/i18n/context";
import { emptyLearningContent, type LearningContent } from "../../../../supabase/functions/_shared/learningTools";
import type { LearningReview } from "../../lib/hexLearning";

const complete: LearningContent = { ...emptyLearningContent(), issue: "Leak", what_happened: "Corner leaked", impact: "Redo", lesson_learned: "Fold first", preventive_action: "Add a check", unknown: [] };
const review = (over: Partial<LearningReview> = {}) => ({
  id: "rev-1", case_id: "case-1", project_id: "job", state: "draft", revision: 1, job: null, unit_id: null, unit_label: "", question: "q", request_id: null,
  author: { id: "author", name: "Ana" }, reviewer: null, content: complete, missing: [], submitted_at: null, decided_at: null, decided_by: null,
  decided_as_oversight: false, created_via: "form", created_at: "", updated_at: "", last_note: null, approved_revision: null, approval_event_id: null,
  delivery: null, withdrawal: null, ...over,
}) as LearningReview;
const exactFrank = { status: "exact" as const, match: { id: "frank", name: "Frank", role: "foreman" as const, exact: true }, choices: [], said: "Frank" };

let root: Root, host: HTMLDivElement;
beforeEach(() => {
  for (const f of Object.values(m)) f.mockReset();
  m.drain.mockResolvedValue(undefined); m.failed.mockResolvedValue(false); m.saveCase.mockResolvedValue("case-entry");
  m.supersede.mockResolvedValue([]); m.session.mockResolvedValue(true);
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

const mount = async (el: React.ReactElement) => { await act(async () => root.render(el)); };
const button = (text: RegExp) => [...host.querySelectorAll("button")].find((b) => text.test(b.textContent ?? ""))!;
const click = async (b: HTMLElement) => { await act(async () => { b.click(); }); };
function type(el: HTMLTextAreaElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("lesson write-up form", () => {
  it("shows the five headings, the missing count and explicit Unknown, in English and Spanish", async () => {
    await mount(<LearningReviewForm actorId="author" projectId="job" source={{ caseId: "case-1" }} via="form" />);
    const text = host.textContent ?? "";
    for (const h of ["Issue", "What happened", "Impact", "Lesson learned", "Preventive action"]) expect(text).toContain(h);
    expect(text).toContain("5 still needed");
    expect(host.querySelectorAll('input[type="checkbox"]').length).toBe(5);
    const es = { lang: "es" as const, t: ((k: string) => k) as never, setLang: () => undefined, needsChoice: false };
    await mount(<LanguageContext.Provider value={es}><LearningReviewForm actorId="author" projectId="job" source={{ caseId: "case-1" }} via="form" /></LanguageContext.Provider>);
    for (const h of ["Problema", "Qué pasó", "Impacto", "Lección aprendida", "Acción preventiva", "Faltan 5"]) expect(host.textContent).toContain(h);
  });

  it("one save at a time, and typing during the save stays on screen, unsaved", async () => {
    let finish!: (id: string) => void;
    m.saveDraft.mockImplementation(() => new Promise((res) => { finish = res; }));
    m.get.mockRejectedValue(new Error("offline"));
    await mount(<LearningReviewForm actorId="author" projectId="job" source={{ caseId: "case-1" }} via="form" />);
    const issue = host.querySelector("textarea")!;
    await act(async () => type(issue, "First words"));
    await click(button(/Save draft/)); await click(button(/Save draft/));
    await act(async () => type(issue, "Newer words"));
    await act(async () => finish("entry-1"));
    expect(m.saveDraft).toHaveBeenCalledTimes(1);
    expect(m.saveDraft.mock.calls[0][0]).toMatchObject({ expectedRevision: 0, content: expect.objectContaining({ issue: "First words" }) });
    expect(host.querySelector("textarea")!.value).toBe("Newer words");
    expect(host.textContent).toContain("Saved on this phone — not sent");
  });

  it("Send refuses a newer revision from another screen and a failed save: nothing is submitted", async () => {
    m.get.mockResolvedValue(review({ revision: 3, content: { ...complete, issue: "Other tab" } }));
    m.failed.mockResolvedValue(true);
    await mount(<LearningReviewForm actorId="author" projectId="job" source={{ caseId: "case-1" }} review={review()} initialReviewer={exactFrank} via="form" />);
    await click(button(/Send to Frank/));
    expect(m.submit).not.toHaveBeenCalled();
    expect(host.textContent).toContain("Nothing was sent");
    await click(button(/Show the latest version/));
    expect(host.querySelector("textarea")!.value).toBe("Other tab");
  });

  it("Send submits exactly the revision and words on screen", async () => {
    m.get.mockResolvedValue(review());
    m.submit.mockResolvedValue(review({ state: "submitted", revision: 2, reviewer: { id: "frank", name: "Frank", available: true, can_approve: false } }));
    await mount(<LearningReviewForm actorId="author" projectId="job" source={{ caseId: "case-1" }} review={review()} initialReviewer={exactFrank} via="form" />);
    await click(button(/Send to Frank/));
    expect(m.submit).toHaveBeenCalledWith("author", "rev-1", expect.any(String), 1, "frank");
    expect(host.textContent).toContain("Sent to Frank — waiting for review");
  });

  it("an ambiguous name never preselects anyone", async () => {
    const choose = { status: "choose" as const, match: null, said: "Maria", choices: [{ id: "a", name: "Maria Diaz", role: "supervisor" as const, exact: true }, { id: "b", name: "maria diaz", role: "foreman" as const, exact: true }] };
    await mount(<LearningReviewForm actorId="author" projectId="job" source={{ caseId: "case-1" }} review={review()} initialReviewer={choose} via="form" />);
    expect([...host.querySelectorAll<HTMLInputElement>('input[type="radio"]')].some((r) => r.checked)).toBe(false);
    await click(button(/Send for review/));
    expect(m.submit).not.toHaveBeenCalled();
    expect(host.textContent).toContain("Choose who reviews it.");
  });

  it("under StrictMode (as the app renders) a send still lands on screen", async () => {
    m.get.mockResolvedValue(review());
    m.submit.mockResolvedValue(review({ state: "submitted", revision: 2, reviewer: { id: "frank", name: "Frank", available: true, can_approve: false } }));
    await mount(<StrictMode><LearningReviewForm actorId="author" projectId="job" source={{ caseId: "case-1" }} review={review()} initialReviewer={exactFrank} via="form" /></StrictMode>);
    await click(button(/Send to Frank/));
    expect(host.textContent).toContain("Sent to Frank — waiting for review");
  });

  it("recovers from a stale failed save: conflict -> show latest -> edit -> save -> send the new exact revision", async () => {
    const theirs = review({ revision: 3, content: { ...complete, issue: "Other tab" } });
    m.get.mockResolvedValue(theirs);
    m.failed.mockResolvedValue(true);
    m.supersede.mockResolvedValue([{ ...complete, issue: "My set-aside words" }]);
    await mount(<StrictMode><LearningReviewForm actorId="author" projectId="job" source={{ caseId: "case-1" }} review={review()} initialReviewer={exactFrank} via="form" /></StrictMode>);
    await click(button(/Send to Frank/));
    expect(m.submit).not.toHaveBeenCalled();
    await click(button(/Show the latest version/));
    expect(m.supersede).toHaveBeenCalledWith("rev-1", "author");
    expect(host.textContent).toContain("My set-aside words");
    expect(host.querySelector("textarea")!.value).toBe("Other tab");
    // The failed chain is gone: the next save expects the server's revision and depends on nothing stale.
    m.failed.mockResolvedValue(false);
    m.saveDraft.mockResolvedValue("entry-2");
    await act(async () => type(host.querySelector("textarea")!, "Merged words"));
    await click(button(/Save draft/));
    expect(m.saveDraft).toHaveBeenLastCalledWith(expect.objectContaining({ expectedRevision: 3, content: expect.objectContaining({ issue: "Merged words" }) }), undefined);
    m.get.mockResolvedValue(review({ revision: 4, content: { ...complete, issue: "Merged words" } }));
    m.submit.mockResolvedValue(review({ state: "submitted", revision: 5, reviewer: { id: "frank", name: "Frank", available: true, can_approve: false } }));
    await click(button(/Send to Frank/));
    expect(m.submit).toHaveBeenCalledWith("author", "rev-1", expect.any(String), 4, "frank");
  });

  it("an account switch while the failed-save check is pending sends nothing", async () => {
    m.get.mockResolvedValue(review());
    let answer!: (v: boolean) => void;
    m.failed.mockImplementation(() => new Promise((res) => { answer = res; }));
    await mount(<LearningReviewForm actorId="author" projectId="job" source={{ caseId: "case-1" }} review={review()} initialReviewer={exactFrank} via="form" />);
    await click(button(/Send to Frank/));
    m.session.mockResolvedValue(false); // someone else signed in on this phone meanwhile
    await act(async () => answer(false));
    expect(m.submit).not.toHaveBeenCalled();
    expect(host.textContent).toContain("belongs to another sign-in");
  });
});
