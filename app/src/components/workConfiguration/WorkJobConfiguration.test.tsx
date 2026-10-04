// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkConfigurationRejectedError } from "../../lib/workConfiguration/model";
const ME = "00000000-0000-4000-8000-000000000001", JOB = "00000000-0000-4000-8000-000000000050", OTHER = "00000000-0000-4000-8000-000000000051";
const MENU = "00000000-0000-4000-8000-000000000100", FORE = "00000000-0000-4000-8000-000000000003", GRANT = "00000000-0000-4000-8000-000000000200";
let viewer: string | null = ME, generation = 1, role = "owner", preview = false, online = true;
const listeners = new Set<() => void>();
const choices = vi.fn(), grants = vi.fn(), people = vi.fn(), select = vi.fn(), give = vi.fn(), revoke = vi.fn();
vi.mock("../../lib/useEffectiveRole", () => ({ useEffectiveRole: () => ({ realRole: role, effectiveRole: preview ? "installer" : role, isPreviewing: preview }) }));
vi.mock("../../lib/offline/useWeakSignal", () => ({ useConnection: () => ({ online }) }));
vi.mock("../../lib/i18n", () => ({ useLanguage: () => ({ lang: "en" }) }));
vi.mock("../../lib/install/api", () => ({ listProfiles: (...args: unknown[]) => people(...args) }));
vi.mock("../../lib/signedIn", () => ({
  signedInUserId: () => viewer, signInGeneration: () => generation,
  subscribeSignedIn: (cb: () => void) => { listeners.add(cb); return () => { listeners.delete(cb); }; },
  signInMark: () => ({ userId: viewer, generation }),
  stillSignedInAs: (mark: { userId: string | null; generation: number }, who: string) => mark.userId === who && mark.generation === generation && viewer === who,
}));
vi.mock("../../lib/workConfiguration/api", () => ({
  fetchJobMenuChoices: (...args: unknown[]) => choices(...args), fetchJobCapabilityGrants: (...args: unknown[]) => grants(...args),
  selectJobMenu: (...args: unknown[]) => select(...args), grantJobCapability: (...args: unknown[]) => give(...args), revokeJobCapability: (...args: unknown[]) => revoke(...args),
  isWorkConfigurationRejected: (error: unknown) => error instanceof WorkConfigurationRejectedError,
}));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const { WorkJobConfiguration } = await import("./WorkJobConfiguration");
const snapshot = (projectId = JOB, revision = 2) => ({ protocolVersion: 1, projectId, asOf: "2026-11-08T12:00:00Z", currentRevision: revision,
  currentSelection: { revision, menuVersionId: MENU }, choices: [{ menuVersionId: MENU, version: 1, labelEn: "Published menu", labelEs: "Menú publicado", publishedAt: "2026-11-08T12:00:00Z", effectiveFrom: "2026-11-08T12:00:00Z" }] });
let host: HTMLDivElement, root: Root, client: QueryClient;
const flush = async () => act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
async function render(job = JOB) { await act(async () => root.render(<QueryClientProvider client={client}><WorkJobConfiguration projectId={job} /></QueryClientProvider>)); await flush(); }
function button(label: string) { const b = [...host.querySelectorAll("button")].find(b => b.textContent === label); if (!b) throw Error(label); return b; }
async function click(label: string) { await act(async () => button(label).click()); await flush(); }
async function choose(label: string, value: string) { const s = [...host.querySelectorAll("label")].find(l => l.textContent?.startsWith(label))?.querySelector("select"); if (!s) throw Error(label); await act(async () => { s.value = value; s.dispatchEvent(new Event("change", { bubbles: true })); }); await flush(); }
function deferred() { let resolve!: (value: unknown) => void, reject!: (error: unknown) => void; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
beforeEach(() => {
  viewer = ME; generation++; role = "owner"; preview = false; online = true;
  Object.defineProperty(navigator, "onLine", { configurable: true, get: () => online });
  choices.mockReset().mockImplementation(async (job: string) => snapshot(job));
  grants.mockReset().mockResolvedValue({ protocolVersion: 1, projectId: JOB, grants: [] });
  people.mockReset().mockResolvedValue([{ id: FORE, role: "foreman", active: true, display_name: "Foreman One" }]);
  select.mockReset().mockResolvedValue({ revision: 3 }); give.mockReset().mockResolvedValue({}); revoke.mockReset().mockResolvedValue({});
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } }); host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); client.clear(); listeners.clear(); });
describe("exact-job configuration panel", () => {
  it("blocks a remounted panel while the original request is in flight and accepts its late valid receipt", async () => {
    await render(); await choose("Published menu", MENU); const reply = deferred(); select.mockReturnValueOnce(reply.promise);
    await click("Use this menu"); await render(OTHER); await render(JOB);
    expect(button("Retry same request").disabled).toBe(true); await click("Retry same request"); expect(select).toHaveBeenCalledTimes(1);
    await act(async () => reply.resolve({ revision: 3 })); await flush();
    expect(host.textContent).not.toContain("Retry same request"); expect(select).toHaveBeenCalledTimes(1);
  });
  it("retains unknown job command through navigation and later refusal until a receipt arrives", async () => {
    await render(); await choose("Published menu", MENU);
    select.mockRejectedValueOnce(Error("unknown")).mockRejectedValueOnce(new WorkConfigurationRejectedError()).mockResolvedValue({ revision: 3 });
    await click("Use this menu"); const original = select.mock.calls[0][0];
    await render(OTHER); expect(host.textContent).not.toContain("Retry same request");
    await render(JOB); expect(host.textContent).toContain("Retry same request");
    await click("Retry same request"); expect(button("Use this menu").disabled).toBe(true); expect(select.mock.calls[1][0]).toBe(original);
    await click("Retry same request"); expect(select.mock.calls[2][0]).toBe(original); expect(host.textContent).not.toContain("Retry same request");
  });
  it("makes no private reads for installer, preview or offline, and limits foreman to chooser", async () => {
    role = "installer"; await render(); expect(choices).not.toHaveBeenCalled();
    role = "owner"; preview = true; await render(); expect(choices).not.toHaveBeenCalled();
    preview = false; online = false; await render(); expect(choices).not.toHaveBeenCalled(); expect(grants).not.toHaveBeenCalled();
    online = true; role = "foreman"; await render(); expect(choices).toHaveBeenCalledWith(JOB); expect(grants).not.toHaveBeenCalled(); expect(people).not.toHaveBeenCalled(); expect(host.textContent).not.toContain("Foreman permissions");
  });
  it("retains original UUID and revision after unknown outcome, blocks other changes and avoids duplicate taps", async () => {
    await render(); await choose("Published menu", MENU);
    const request = deferred(); select.mockReturnValueOnce(request.promise).mockResolvedValue({ revision: 3 });
    await click("Use this menu"); expect(select).toHaveBeenCalledTimes(1); expect(button("Use this menu").disabled).toBe(true);
    await click("Use this menu"); expect(select).toHaveBeenCalledTimes(1);
    const original = select.mock.calls[0][0]; expect(original.expectedCurrentRevision).toBe(2);
    await act(async () => request.reject(Error("network"))); await flush();
    expect(host.textContent).toContain("result is unknown"); await click("Retry same request");
    expect(select).toHaveBeenCalledTimes(2); expect(select.mock.calls[1][0]).toBe(original);
  });
  it("requires refresh after confirmed refusal and creates a fresh intent only after confirmation", async () => {
    await render(); await choose("Published menu", MENU); select.mockRejectedValueOnce(new WorkConfigurationRejectedError()); await click("Use this menu");
    expect(host.textContent).toContain("attempt was refused"); expect(host.textContent).not.toContain("Retry same request");
    choices.mockResolvedValue(snapshot(JOB, 3)); await click("Refresh records"); await choose("Published menu", MENU); await click("Use this menu");
    expect(select.mock.calls[0][0].expectedCurrentRevision).toBe(2); expect(select.mock.calls[1][0].expectedCurrentRevision).toBe(3);
    expect(select.mock.calls[1][0].commandId).not.toBe(select.mock.calls[0][0].commandId);
  });
  it("does not silently rebase a selected menu after an automatic revision refresh", async () => {
    await render(); await choose("Published menu", MENU); choices.mockResolvedValue(snapshot(JOB, 3));
    await act(async () => { await client.refetchQueries({ queryKey: ["workJobMenuChoices"] }); }); await flush();
    expect(button("Use this menu").disabled).toBe(true); expect(host.textContent).toContain("selection changed"); expect(select).not.toHaveBeenCalled();
  });
  it("removes old-job and account private queries and discards late reads and responses", async () => {
    const old = deferred(); choices.mockReturnValueOnce(old.promise); await render(); await render(OTHER);
    await act(async () => old.resolve(snapshot())); await flush(); expect(choices).toHaveBeenCalledWith(OTHER);
    expect(client.getQueryCache().findAll({ queryKey: ["workJobMenuChoices"] }).every(q => q.queryKey[3] === OTHER)).toBe(true);
    await choose("Published menu", MENU); const reply = deferred(); select.mockReturnValueOnce(reply.promise); await click("Use this menu");
    viewer = null; generation++; await act(async () => { for (const cb of listeners) cb(); }); await render(OTHER);
    await act(async () => reply.resolve({ revision: 3 })); await flush(); expect(host.textContent).toBe("");
    expect(client.getQueryCache().findAll({ queryKey: ["workJobMenuChoices"] })).toHaveLength(0);
  });
  it("uses actual grant ID to revoke and limits granting to a selected active foreman", async () => {
    grants.mockResolvedValue({ protocolVersion: 1, projectId: JOB, grants: [{ grantId: GRANT, profileId: FORE, capability: "dimensions_edit", grantedAt: "2026-11-08T12:00:00Z", revokedAt: null }] });
    await render(); await click("Revoke permission"); expect(revoke.mock.calls[0][0]).toMatchObject({ projectId: JOB, profileId: FORE, capability: "dimensions_edit", expectedGrantId: GRANT });
    await choose("Foreman", FORE); await choose("Permission", "menu_select"); await click("Grant permission"); expect(give.mock.calls[0][0]).toMatchObject({ projectId: JOB, profileId: FORE, capability: "menu_select" });
  });
});
