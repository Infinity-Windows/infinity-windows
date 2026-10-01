// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { LanguageContext, type LanguageContextValue } from "../../lib/i18n/context";
import { CATALOG, translate } from "../../lib/i18n";
import { rememberSignedIn } from "../../lib/signedIn";
import { loadManualDailyLogDraft } from "../../lib/manualDailyLogDraft";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const m = vi.hoisted(() => ({ get: vi.fn(), draft: vi.fn(), file: vi.fn(), close: vi.fn() }));
vi.mock("../../lib/dailyLogs", async (orig) => ({
  ...(await orig<typeof import("../../lib/dailyLogs")>()),
  getDailyLog: m.get, buildDraftForJobDay: m.draft, fileDailyLog: m.file,
}));
vi.mock("../../lib/pwa/useSafeSurface", () => ({ useOverlayWhile: () => {} }));
vi.mock("./LogTextArea", () => ({ LogTextArea: (p: React.TextareaHTMLAttributes<HTMLTextAreaElement>) => <textarea {...p} /> }));

import { DailyLogDialog } from "./DailyLogDialog";

let host: HTMLDivElement;
let root: Root;
let client: QueryClient;
const lang: LanguageContextValue = { lang: "en", t: ((k: string) => translate(CATALOG, "en", k as keyof typeof CATALOG)) as LanguageContextValue["t"], setLang: () => {}, needsChoice: false };
const log = (revision: number) => ({ id: "log", project_id: "job", log_date: "2026-10-01", revision,
  headline: "Morning", notes: "Installed frame", day_flow: "fine", reflection: null, weather: "Clear" });
const dialog = () => <LanguageContext.Provider value={lang}><QueryClientProvider client={client}>
  <DailyLogDialog projectId="job" logDate="2026-10-01" jobLabel="Test job" onClose={m.close} />
</QueryClientProvider></LanguageContext.Provider>;
const button = (part: string) => [...host.querySelectorAll("button")].find((b) => b.textContent?.includes(part))!;
async function click(part: string) { await act(async () => { button(part).click(); }); }
async function typeNotes(value: string) {
  const el = host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Notes"]')!;
  if (!el) throw new Error(host.innerHTML.slice(0, 1800));
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function mount() {
  await act(async () => root.render(dialog()));
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
}

beforeEach(() => {
  vi.restoreAllMocks();
  localStorage.clear(); rememberSignedIn({ user: { id: "ana" } });
  for (const f of Object.values(m)) f.mockReset();
  m.get.mockResolvedValue(log(1)); m.draft.mockResolvedValue({ headline: "", notesDraft: "" });
  m.file.mockResolvedValue({ log: log(2), queued: false });
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); client.clear(); host.remove(); rememberSignedIn(null); });

it("keeps edits on the phone, offers resume, and clears them only after Save succeeds", async () => {
  await mount();
  await typeNotes("Installed frame and door");
  expect(loadManualDailyLogDraft("ana", "job", "2026-10-01")?.baseRevision).toBe(1);
  expect(host.textContent).toContain("Draft saved on this phone — not submitted");
  act(() => root.unmount()); root = createRoot(host);
  await mount();
  expect(host.textContent).toContain("Resume draft");
  await click("Resume draft");
  expect(host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Notes"]')?.value).toBe("Installed frame and door");
  await click("Save");
  expect(m.file.mock.calls[0][0]).toMatchObject({ notes: "Installed frame and door", baseRevision: 1 });
  expect(loadManualDailyLogDraft("ana", "job", "2026-10-01")).toBeNull();
});

it("keeps a stale draft and blocks Save until it is deliberately combined", async () => {
  await mount();
  await typeNotes("Installed frame and door");
  act(() => root.unmount()); root = createRoot(host);
  m.get.mockResolvedValue(log(2));
  client.clear();
  await mount();
  await click("Resume draft");
  expect(button("Save").hasAttribute("disabled")).toBe(true);
  expect(host.textContent).toContain("The shared log changed");
  expect(m.file).not.toHaveBeenCalled();
  await click("Combine with current log");
  expect(loadManualDailyLogDraft("ana", "job", "2026-10-01")?.baseRevision).toBe(2);
  expect(button("Save").hasAttribute("disabled")).toBe(false);
});

it("keeps newer typing when an earlier Save finishes", async () => {
  let finish!: (value: unknown) => void;
  m.file.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
  await mount();
  await typeNotes("First version");
  await click("Save");
  await typeNotes("Newer version");
  await act(async () => finish({ log: log(2), queued: false }));
  expect(loadManualDailyLogDraft("ana", "job", "2026-10-01")?.fields.notes).toBe("Newer version");
  expect(m.close).not.toHaveBeenCalled();
  expect(button("Save").hasAttribute("disabled")).toBe(true);
});

it("does not clear the first person's draft when sign-in changes during Save", async () => {
  let finish!: (value: unknown) => void;
  m.file.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
  await mount();
  await typeNotes("Ana's words");
  await click("Save");
  await act(async () => rememberSignedIn({ user: { id: "ben" } }));
  await act(async () => finish({ log: log(2), queued: false }));
  expect(loadManualDailyLogDraft("ana", "job", "2026-10-01")?.fields.notes).toBe("Ana's words");
  expect(host.textContent).not.toContain("Ana's words");
  expect(m.close).not.toHaveBeenCalled();
});

it("warns when the phone cannot keep a typed draft", async () => {
  await mount();
  const storageSpy = vi.spyOn(localStorage, "setItem").mockImplementation(() => { throw new Error("quota"); });
  await typeNotes("Words not stored");
  expect(host.textContent).toContain("could not save your draft");
  expect(host.textContent).not.toContain("Draft saved on this phone — not submitted");
  storageSpy.mockRestore();
});

it("discards only after a deliberate tap", async () => {
  await mount();
  await typeNotes("Unsent words");
  act(() => root.unmount()); root = createRoot(host);
  await mount();
  expect(host.textContent).toContain("Discard draft");
  await click("Discard draft");
  expect(loadManualDailyLogDraft("ana", "job", "2026-10-01")).toBeNull();
  expect(host.textContent).not.toContain("Resume draft");
});

it("requires a fresh review when an offline draft had no known server version", async () => {
  m.get.mockRejectedValue(new Error("offline"));
  await mount();
  await typeNotes("Work from dead zone");
  expect(loadManualDailyLogDraft("ana", "job", "2026-10-01")?.baseRevision).toBeNull();
  act(() => root.unmount()); root = createRoot(host);
  m.get.mockResolvedValue(log(1)); client.clear();
  await mount();
  await click("Resume draft");
  expect(button("Save").hasAttribute("disabled")).toBe(true);
  await click("Combine with current log");
  expect(loadManualDailyLogDraft("ana", "job", "2026-10-01")?.baseRevision).toBe(1);
});
