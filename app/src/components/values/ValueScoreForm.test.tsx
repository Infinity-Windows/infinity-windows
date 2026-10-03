// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ValuesDraftRow } from "../../lib/offline/outboxStore";

const m = vi.hoisted(() => ({ load: vi.fn(), save: vi.fn(), subscribe: vi.fn(), enqueue: vi.fn(), hash: vi.fn() }));
vi.mock("../../lib/values/receiptContract", async (original) => ({
  ...(await original<typeof import("../../lib/values/receiptContract")>()), hashValuesSubmission: m.hash,
}));
vi.mock("../../lib/values/drafts", async (original) => ({
  ...(await original<typeof import("../../lib/values/drafts")>()),
  loadValuesDraft: m.load, saveValuesDraft: m.save,
}));
vi.mock("../../lib/offline/outbox", () => ({ subscribe: m.subscribe, enqueueValuesSubmit: m.enqueue }));
import { ValueScoreForm } from "./ValueScoreForm";
import { rememberSignedIn } from "../../lib/signedIn";
import { VALUE_SLUGS } from "../../lib/values/rubric";

const draft = (ownerId = "owner-a"): ValuesDraftRow => ({
  id: `${ownerId}:assignment`, ownerId, assignmentId: "assignment", requestId: "request",
  rubricVersion: 1, scores: { fullsend: 7 }, comment: "", status: "editing", updatedAt: 1,
});
let root: Root;
let host: HTMLDivElement;
let changed: (() => void) | null;
let stored: ValuesDraftRow | null;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  for (const fn of Object.values(m)) fn.mockReset();
  changed = null;
  stored = null;
  m.load.mockResolvedValue(draft());
  m.save.mockImplementation(async (row: ValuesDraftRow) => { stored = row; });
  m.subscribe.mockImplementation((cb: () => void) => { changed = cb; return () => { changed = null; }; });
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); rememberSignedIn(null); });

async function mount(ownerId = "owner-a") {
  await act(async () => root.render(<ValueScoreForm ownerId={ownerId} assignmentId="assignment" rubricVersion={1} onDone={() => undefined} />));
}
async function clickScore(section: number, score: number) {
  const cards = host.querySelectorAll("section.detail-card");
  const button = cards[section].querySelectorAll("button")[score - 1] as HTMLButtonElement;
  await act(async () => button.click());
}

it("ignores a stale outbox refresh after an edit, including the next edit", async () => {
  await mount();
  let finish!: (row: ValuesDraftRow) => void;
  const oldRead = new Promise<ValuesDraftRow>((resolve) => { finish = resolve; });
  m.load.mockReturnValueOnce(oldRead);
  await act(async () => changed?.());
  await clickScore(0, 9);
  expect(stored?.scores.fullsend).toBe(9);
  await act(async () => finish(draft()));
  expect((host.querySelectorAll("section.detail-card")[0].querySelectorAll("button")[8] as HTMLButtonElement).className).toContain("active-pill");
  await clickScore(1, 8);
  expect(stored?.scores).toMatchObject({ fullsend: 9, ownership: 8 });
});

it("recovers from one failed save and never claims saved before a commit", async () => {
  await mount();
  let fail!: (error: Error) => void;
  m.save.mockImplementationOnce(() => new Promise<void>((_resolve, reject) => { fail = reject; }));
  await clickScore(0, 9);
  expect(host.textContent).toContain("Saving draft");
  expect(host.textContent).not.toContain("Draft saved on this phone");
  await act(async () => fail(new Error("quota")));
  expect(host.textContent).toContain("Retry save");
  expect(host.textContent).not.toContain("Draft saved on this phone");
  m.save.mockImplementation(async (row: ValuesDraftRow) => { stored = row; });
  const retry = [...host.querySelectorAll("button")].find((b) => b.textContent === "Retry save")!;
  await act(async () => retry.click());
  expect(stored?.scores.fullsend).toBe(9);
  expect(host.textContent).toContain("Draft saved on this phone");
});

it("ignores a late draft read from the previous account", async () => {
  let finishA!: (row: ValuesDraftRow) => void;
  m.load.mockImplementationOnce(() => new Promise<ValuesDraftRow>((resolve) => { finishA = resolve; }));
  await mount("owner-a");
  m.load.mockResolvedValue(draft("owner-b"));
  await mount("owner-b");
  await act(async () => finishA({ ...draft("owner-a"), scores: { fullsend: 9 } }));
  await clickScore(1, 8);
  expect(stored?.ownerId).toBe("owner-b");
  expect(stored?.scores).toMatchObject({ fullsend: 7, ownership: 8 });
});

it("finishes every promised revision after close and reopens only after those writes", async () => {
  await mount();
  let finishFirst!: () => void;
  m.save.mockImplementationOnce((row: ValuesDraftRow) => new Promise<void>((resolve) => {
    finishFirst = () => { stored = row; resolve(); };
  }));
  await clickScore(0, 9);
  await clickScore(1, 8);
  expect(m.save).toHaveBeenCalledTimes(1);
  await act(async () => root.render(null));
  m.load.mockImplementation(async () => stored ?? draft());
  await mount();
  expect(host.textContent).toContain("Opening saved review");
  await act(async () => finishFirst());
  expect(m.save).toHaveBeenCalledTimes(2);
  expect(stored?.scores).toMatchObject({ fullsend: 9, ownership: 8 });
  const cards = host.querySelectorAll("section.detail-card");
  expect(cards[0].querySelectorAll("button")[8].className).toContain("active-pill");
  expect(cards[1].querySelectorAll("button")[7].className).toContain("active-pill");
});

it("finishes A's queued saves without changing B's form or calling its onDone", async () => {
  await mount();
  let finishFirst!: () => void;
  m.save.mockImplementationOnce((row: ValuesDraftRow) => new Promise<void>((resolve) => {
    finishFirst = () => { stored = row; resolve(); };
  }));
  await clickScore(0, 9);
  await clickScore(1, 8);
  m.load.mockResolvedValue(draft("owner-b"));
  await mount("owner-b");
  await act(async () => finishFirst());
  expect(stored?.ownerId).toBe("owner-a");
  expect(stored?.scores).toMatchObject({ fullsend: 9, ownership: 8 });
  expect(host.textContent).not.toContain("Draft saved on this phone");
  await clickScore(1, 6);
  expect(stored?.ownerId).toBe("owner-b");
  expect(stored?.scores).toMatchObject({ fullsend: 7, ownership: 6 });
});

it("locks the latest persisted snapshot throughout a delayed hash and queues that exact revision", async () => {
  const ownerId = "00000000-0000-4000-8000-000000000001";
  const assignmentId = "00000000-0000-4000-8000-000000000002";
  const requestId = "00000000-0000-4000-8000-000000000003";
  rememberSignedIn({ user: { id: ownerId } });
  m.load.mockResolvedValue({ ...draft(ownerId), id: `${ownerId}:${assignmentId}`, assignmentId, requestId,
    scores: Object.fromEntries(VALUE_SLUGS.map((slug) => [slug, 7])),
  });
  let finishHash!: (digest: string) => void;
  m.hash.mockImplementation(() => new Promise<string>((resolve) => { finishHash = resolve; }));
  await act(async () => root.render(<ValueScoreForm ownerId={ownerId} assignmentId={assignmentId} rubricVersion={1} onDone={() => undefined} />));
  await clickScore(0, 9);
  expect(stored?.scores.fullsend).toBe(9);
  await act(async () => (host.querySelector("button.action-btn") as HTMLButtonElement).click());
  expect(m.hash).toHaveBeenCalledTimes(1);
  expect((host.querySelector("textarea") as HTMLTextAreaElement).disabled).toBe(true);
  expect([...host.querySelectorAll("section.detail-card button")].every((button) => (button as HTMLButtonElement).disabled)).toBe(true);
  await clickScore(0, 2);
  await act(async () => finishHash("a".repeat(64)));
  expect(stored?.scores.fullsend).toBe(9);
  expect(stored?.status).toBe("queued");
  expect(m.enqueue).toHaveBeenCalledTimes(1);
  expect(m.enqueue.mock.calls[0][0]).toMatchObject({ requestId, assignmentId, raterId: ownerId,
    scores: expect.arrayContaining([{ slug: "fullsend", score: 9 }]), digest: "a".repeat(64),
  });
});
