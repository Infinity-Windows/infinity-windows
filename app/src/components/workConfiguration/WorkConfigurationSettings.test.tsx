// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkConfigurationRejectedError } from "../../lib/workConfiguration/model";
const JOB = "3cc5b810-45e0-4445-a115-efa98f8efad3";
const ME = "00000000-0000-4000-8000-0000000000e2";
const VERSION = "00000000-0000-4000-8000-0000000000c1";
let viewer: string | null = ME;
let generation = 1;
let role: "owner" | "supervisor" | "installer" = "owner";
let preview = false;
let online = true;
const listeners = new Set<() => void>();
const fetchConfig = vi.fn();
const draftActivity = vi.fn();
const publishActivity = vi.fn();
const draftMenu = vi.fn();
const publishMenu = vi.fn();
const retireActivity = vi.fn();
const retireMenu = vi.fn();
vi.mock("../../lib/useEffectiveRole", () => ({ useEffectiveRole: () => ({ realRole: role, effectiveRole: preview ? "installer" : role, isPreviewing: preview, isLoading: false }) }));
vi.mock("../../lib/offline/useWeakSignal", () => ({ useConnection: () => ({ online, weak: false }) }));
vi.mock("../../lib/signedIn", () => ({
  signedInUserId: () => viewer, signInGeneration: () => generation,
  subscribeSignedIn: (cb: () => void) => { listeners.add(cb); return () => { listeners.delete(cb); }; },
  signInMark: () => ({ userId: viewer, generation }),
  stillSignedInAs: (mark: { userId: string | null; generation: number }, who: string) => mark.userId === who && mark.generation === generation && viewer === who,
}));
vi.mock("../../lib/workConfiguration/api", () => ({
  fetchWorkConfiguration: (...args: unknown[]) => fetchConfig(...args),
  isWorkConfigurationRejected: (error: unknown) => error instanceof WorkConfigurationRejectedError,
  proposeActivityDraft: (...args: unknown[]) => draftActivity(...args),
  proposeMenuDraft: (...args: unknown[]) => draftMenu(...args),
  publishActivityVersion: (...args: unknown[]) => publishActivity(...args),
  publishMenuVersion: (...args: unknown[]) => publishMenu(...args),
  retireActivity: (...args: unknown[]) => retireActivity(...args),
  retireMenu: (...args: unknown[]) => retireMenu(...args),
}));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const { WorkConfigurationSettings } = await import("./WorkConfigurationSettings");
function snapshot(revision = 2) {
  return {
    protocolVersion: 1, role: "company", asOf: "2026-11-08T12:00:00Z", projectId: null, currentSelection: null,
    activities: [{ code: "shimming", definitionId: JOB, retiredAt: null, versions: [{ versionId: VERSION, version: 1, scope: "specific", labelEn: "Shimming", labelEs: "Calzar", machineSelection: false, typedFields: [], publishedAt: "2026-11-08T12:00:00Z", effectiveFrom: "2026-11-08T12:00:00Z", eligibleNow: true }] }],
    menus: [], drafts: [{ kind: "activity", code: "shimming", revision, draftId: VERSION, body: { scope: "specific", labelEn: "Shimming", labelEs: "Calzar", machineSelection: false, typedFields: [] }, proposedBy: ME, createdAt: "2026-11-08T12:00:00Z" }],
  };
}
let container: HTMLElement;
let root: Root;
let qc: QueryClient;
async function flush() { await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); }); }
async function render() {
  await act(async () => { root.render(<QueryClientProvider client={qc}><WorkConfigurationSettings /></QueryClientProvider>); });
  await flush();
}
function button(text: string): HTMLButtonElement {
  const el = [...container.querySelectorAll("button")].find(b => b.textContent?.trim() === text);
  if (!el) throw Error(`Missing ${text}`);
  return el as HTMLButtonElement;
}
async function click(text: string) { await act(async () => { button(text).click(); }); await flush(); }
function input(label: string, scope = ".wc-editor"): HTMLInputElement {
  const parent = container.querySelector(scope);
  const node = [...(parent?.querySelectorAll("label") ?? [])].find(x => x.textContent?.startsWith(label))?.querySelector("input");
  if (!node) throw Error(`Missing input ${label}`);
  return node;
}
async function changeInput(node: HTMLInputElement, value: string) {
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(node, value); node.dispatchEvent(new Event("input", { bubbles: true })); node.dispatchEvent(new Event("change", { bubbles: true })); });
}
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
beforeEach(() => {
  viewer = ME; generation++; role = "owner"; preview = false; online = true;
  fetchConfig.mockReset().mockResolvedValue(snapshot());
  draftActivity.mockReset().mockResolvedValue({ revision: 3 });
  publishActivity.mockReset().mockResolvedValue({ version: 2 });
  draftMenu.mockReset(); publishMenu.mockReset(); retireActivity.mockReset(); retireMenu.mockReset();
  qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); qc.clear(); listeners.clear(); });
describe("company Settings configuration", () => {
  it("retains unresolved request across preview/navigation and a later refused retry without shared mutation variables", async () => {
    await render(); await click("Shimming shimming");
    draftActivity.mockRejectedValueOnce(Error("unknown network outcome")).mockRejectedValueOnce(new WorkConfigurationRejectedError()).mockResolvedValue({ revision: 3 });
    await click("Save proposal"); const original = draftActivity.mock.calls[0][0];
    preview = true; await render(); expect(container.textContent).not.toContain("Shimming");
    preview = false; await render(); expect(container.textContent).toContain("Retry exact request");
    await click("Retry exact request"); expect(container.textContent).toContain("Retry exact request");
    expect(button("New activity").disabled).toBe(true); expect(draftActivity.mock.calls[1][0]).toBe(original);
    expect(qc.getMutationCache().getAll()).toHaveLength(0);
    await click("Retry exact request"); expect(draftActivity.mock.calls[2][0]).toBe(original);
    expect(container.textContent).not.toContain("Retry exact request");
  });
  it("queries only real owner/supervisor, never preview or installer, and removes its private key on boundary", async () => {
    role = "installer"; await render(); expect(fetchConfig).not.toHaveBeenCalled(); expect(container.textContent).not.toContain("Shimming");
    role = "supervisor"; await render(); expect(fetchConfig).toHaveBeenCalledWith(null); expect(container.textContent).toContain("Shimming");
    expect(button("New activity")).toBeDefined();
    await click("Shimming shimming");
    expect(container.textContent).toContain("Save proposal"); expect(container.textContent).not.toContain("Publish new version");
    preview = true; await render();
    expect(container.textContent).not.toContain("Shimming");
    expect(qc.getQueryCache().findAll({ queryKey: ["workConfigurationCompany"] })).toHaveLength(0);
    const count = fetchConfig.mock.calls.length;
    role = "owner"; await render(); expect(fetchConfig).toHaveBeenCalledTimes(count);
  });
  it("hides data offline and keeps unknown intent for exact retry with the original UUID", async () => {
    await render(); await click("Shimming shimming");
    const request = deferred<unknown>(); draftActivity.mockReturnValueOnce(request.promise).mockResolvedValue({ revision: 3 });
    await click("Save proposal");
    expect(draftActivity).toHaveBeenCalledTimes(1);
    const first = draftActivity.mock.calls[0][0] as { commandId: string; expectedRevision: number; labelEn: string };
    expect(first.expectedRevision).toBe(2); expect(first.labelEn).toBe("Shimming");
    expect(button("Save proposal").disabled).toBe(true);
    const label = input("English label");
    expect(label.disabled).toBe(true);
    await changeInput(label, "Changed after send");
    expect(first.labelEn).toBe("Shimming");
    online = false; await render(); expect(container.textContent).not.toContain("Shimming");
    await act(async () => request.reject(new Error("network unknown"))); await flush();
    online = true; await render();
    expect(container.textContent).toContain("Retry exact request");
    await click("Retry exact request");
    expect(draftActivity).toHaveBeenCalledTimes(2);
    expect(draftActivity.mock.calls[1][0]).toBe(first);
    expect(draftActivity.mock.calls[1][0].commandId).toBe(first.commandId);
  });
  it("refreshes a confirmed stale revision before allowing a new command", async () => {
    await render(); await click("Shimming shimming");
    draftActivity.mockRejectedValueOnce(new WorkConfigurationRejectedError()).mockResolvedValue({ revision: 4 });
    fetchConfig.mockResolvedValueOnce(snapshot(3));
    await click("Save proposal"); await flush();
    expect(fetchConfig).toHaveBeenCalledTimes(2);
    expect(button("Save proposal").disabled).toBe(true);
    await click("Reload editor");
    await click("Save proposal");
    expect(draftActivity.mock.calls[0][0].expectedRevision).toBe(2);
    expect(draftActivity.mock.calls[1][0].expectedRevision).toBe(3);
    expect(draftActivity.mock.calls[0][0].commandId).not.toBe(draftActivity.mock.calls[1][0].commandId);
  });
  it("keeps an open editor bound to its original version until explicitly reloaded", async () => {
    await render(); await click("Shimming shimming");
    const fresh = snapshot(3);
    fresh.activities[0].versions.push({ ...fresh.activities[0].versions[0], versionId: "00000000-0000-4000-8000-0000000000c2", version: 2, labelEn: "Updated shimming" });
    const query = qc.getQueryCache().findAll({ queryKey: ["workConfigurationCompany"] })[0];
    await act(async () => { qc.setQueryData(query.queryKey, fresh); }); await flush();
    expect(container.textContent).toContain("changed since you opened it");
    expect(button("Publish new version").disabled).toBe(true);
    expect(publishActivity).not.toHaveBeenCalled();
    await click("Reload editor");
    await click("Publish new version");
    expect(publishActivity.mock.calls[0][0].expectedLatestVersion).toBe(2);
    expect(publishActivity.mock.calls[0][0].labelEn).toBe("Shimming");
  });
  it("shows every typed field control and freezes a menu using published stable IDs", async () => {
    await render(); await click("Shimming shimming"); await click("Add field");
    const types = [...container.querySelectorAll('.wc-subcard select option')].map(o => o.getAttribute("value"));
    expect(types).toEqual(["text", "number", "boolean", "single_select", "multi_select"]);
    await click("New menu");
    await changeInput(input("Stable code"), "standard_install");
    await changeInput(input("English label"), "Standard install");
    await changeInput(input("Spanish label"), "Instalación estándar");
    const select = container.querySelector('.wc-menu-add select') as HTMLSelectElement;
    await act(async () => { select.value = "shimming"; select.dispatchEvent(new Event("change", { bubbles: true })); });
    await click("Add");
    expect(container.textContent).toContain(VERSION);
    await click("Publish new version");
    expect(publishMenu).toHaveBeenCalledTimes(1);
    expect(publishMenu.mock.calls[0][0].items).toEqual([{ definitionId: JOB, versionId: VERSION, enabled: true, position: 0 }]);
  });
  it("keeps a denied company read as an error, never an empty catalog", async () => {
    fetchConfig.mockRejectedValueOnce(new WorkConfigurationRejectedError());
    await render();
    expect(container.textContent).toContain("Current configuration is unavailable");
    expect(container.textContent).not.toContain("New activity");
    expect(container.textContent).not.toContain("No activities");
  });
  it("drops a late mutation error when identity changes", async () => {
    await render(); await click("Shimming shimming");
    const request = deferred<unknown>(); draftActivity.mockReturnValueOnce(request.promise);
    await click("Save proposal");
    viewer = null; generation++; listeners.forEach(cb => cb()); await render();
    await act(async () => request.reject(new Error("late transport failure"))); await flush();
    expect(container.textContent).not.toContain("Outcome unknown");
    expect(qc.getQueryCache().findAll({ queryKey: ["workConfigurationCompany"] })).toHaveLength(0);
  });
  it("discards late private read/error after sign-out and removes exact query", async () => {
    const read = deferred<unknown>(); fetchConfig.mockReturnValueOnce(read.promise);
    await render();
    viewer = null; generation++; listeners.forEach(cb => cb()); await render();
    await act(async () => read.resolve(snapshot())); await flush();
    expect(container.textContent).not.toContain("Shimming");
    expect(qc.getQueryCache().findAll({ queryKey: ["workConfigurationCompany"] })).toHaveLength(0);
  });
});
