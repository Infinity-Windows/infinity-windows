// @vitest-environment happy-dom
import { act, StrictMode, Suspense } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rememberSignedIn } from "../../lib/signedIn";
import { createSensitivePreviewLifetime, ViewAsRoleContext } from "../../lib/viewAsRoleContext";
import { createUnitReviewSelectionSource } from "../../lib/workUnitReview/selection";
import { parseUnitContributorsReply } from "../../lib/workUnitContributions/protocol";
import corpus from "../../lib/workUnitContributions/__fixtures__/sourceMatchedWire.json";
import { SelectedUnitContributors } from "./SelectedUnitContributors";

const rpc = vi.hoisted(() => ({ catalog: vi.fn(), unit: vi.fn(), contributors: vi.fn(), profile: vi.fn() }));
vi.mock("../../lib/install/api", () => ({ getRealProfile: rpc.profile }));
vi.mock("../../lib/workActivity/catalogApi", () => ({ fetchActivityCatalog: rpc.catalog }));
vi.mock("../../lib/workActivity/api", () => ({ fetchActivityUnitBasis: rpc.unit }));
vi.mock("../../lib/workUnitContributions/api", () => ({ fetchUnitContributors: rpc.contributors }));
vi.mock("../../components/work/UnitContributorsPanel", () => ({ UnitContributorsPanel: ({ read, onCheck, disabled, busy }: {
  read: { state: string; data: unknown }; onCheck: () => void; disabled: boolean; busy: boolean;
}) => <section><button onClick={onCheck} disabled={disabled || busy}>Check people</button>
  <p>{read.data ? "private contributor names" : read.state}</p></section> }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const ACTOR = "00000000-0000-4000-8000-000000250002", PROJECT = "00000000-0000-4000-8000-000000250010";
const UNIT = "00000000-0000-4000-8000-000000250030";
const unit = { id: UNIT, projectId: PROJECT, incarnationEpoch: 0 };
const reply = parseUnitContributorsReply(corpus.calls[0].reply, { actorId: ACTOR, projectId: PROJECT, unitId: UNIT, unitIncarnation: "0" });
let host: HTMLDivElement, root: Root, qc: QueryClient;
let preview: ReturnType<typeof createSensitivePreviewLifetime>;
let allowed: boolean, enabled: boolean, revision: number, selected: string | null, strict: boolean, suspension: Promise<void> | null;
let parentSource: ReturnType<typeof createUnitReviewSelectionSource>;
const admission = () => allowed;
function Reader() {
  if (suspension) throw suspension;
  return <SelectedUnitContributors projectId={PROJECT} unitId={selected} selectionRevision={revision}
    enabled={enabled} admitted={admission} locale="en" invalidationSource={parentSource} />;
}
async function render() {
  await act(async () => {
    const child = <QueryClientProvider client={qc}><ViewAsRoleContext.Provider value={{ previewRole: null,
      previewPerson: null, canPreview: false, canPreviewPerson: false, setPreviewRole: () => {}, setPreviewPerson: () => {},
      sensitiveLifetime: preview }}><Suspense fallback={<p>waiting</p>}><Reader /></Suspense></ViewAsRoleContext.Provider></QueryClientProvider>;
    root.render(strict ? <StrictMode>{child}</StrictMode> : child);
  });
}
async function check() { await act(async () => host.querySelector<HTMLButtonElement>("button")!.click()); }
function pending<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { resolve, promise }; }
beforeEach(() => {
  rememberSignedIn({ user: { id: ACTOR } });
  Object.defineProperty(navigator, "onLine", { value: true, configurable: true });
  allowed = enabled = true; revision = 1; selected = UNIT; strict = false; suspension = null;
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(["myRealProfile"], { id: ACTOR, role: "supervisor", retired_at: null });
  preview = createSensitivePreviewLifetime(() => {
    const state = qc.getQueryState<{ id: string; role: string }>(["myRealProfile"]);
    return { stamp: JSON.stringify([state?.dataUpdateCount, state?.status, state?.isInvalidated]),
      ownerId: state?.data?.id ?? null, role: state?.data?.role ?? null,
      ready: state?.status === "success" && !state.isInvalidated };
  }, false);
  parentSource = createUnitReviewSelectionSource();
  rpc.profile.mockReset().mockResolvedValue({ id: ACTOR, role: "supervisor", retired_at: null });
  rpc.catalog.mockReset().mockResolvedValue({ availability: "available", projectId: PROJECT, unit: structuredClone(unit) });
  rpc.unit.mockReset().mockResolvedValue({ availability: "available", unit: structuredClone(unit) });
  rpc.contributors.mockReset().mockResolvedValue(reply);
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); qc.clear(); host.remove(); rememberSignedIn(null); vi.useRealTimers(); });

describe("manual selected-unit contributor consumer", () => {
  it("mount and ordinary renders do not read; Check obtains independent incarnation before one contributor RPC", async () => {
    await render(); await render(); expect(rpc.catalog).not.toHaveBeenCalled(); expect(rpc.contributors).not.toHaveBeenCalled();
    await check(); expect(rpc.catalog).toHaveBeenCalledOnce(); expect(rpc.unit).toHaveBeenCalledOnce();
    expect(rpc.contributors).toHaveBeenCalledOnce(); expect(rpc.contributors.mock.calls[0][0]).toEqual({ projectId: PROJECT, unitId: UNIT, unitIncarnation: "0" });
    expect(host.textContent).toContain("private contributor names");
  });
  it.each(["foreman", "installer", "partner"])("does not offer named reports to %s", async role => {
    qc.setQueryData(["myRealProfile"], { id: ACTOR, role, retired_at: null });
    await render(); expect(host.querySelector("button")).toBeNull(); expect(rpc.catalog).not.toHaveBeenCalled();
  });
  it("does not show or read with the feature off or no selected unit", async () => {
    enabled = false; await render(); expect(host.textContent).toBe("");
    enabled = true; selected = null; await render(); expect(host.textContent).toBe(""); expect(rpc.catalog).not.toHaveBeenCalled();
  });
  it("a late catalog across equal-ID selection ABA cannot reach a unit or people read", async () => {
    const held = pending<unknown>(); rpc.catalog.mockReturnValueOnce(held.promise);
    await render(); await check(); revision += 2; await render();
    await act(async () => held.resolve({ availability: "available", projectId: PROJECT, unit }));
    expect(rpc.unit).not.toHaveBeenCalled(); expect(rpc.contributors).not.toHaveBeenCalled();
    await check(); expect(rpc.contributors).toHaveBeenCalledOnce();
  });
  it("a late unit reply after parent admission closes cannot open names", async () => {
    const held = pending<unknown>(); rpc.unit.mockReturnValueOnce(held.promise);
    await render(); await check(); allowed = false;
    await act(async () => held.resolve({ availability: "available", unit }));
    expect(rpc.contributors).not.toHaveBeenCalled(); expect(host.textContent).not.toContain("private contributor names");
  });
  it("catalog/unit incarnation disagreement refuses instead of trusting the contributor reply", async () => {
    rpc.unit.mockResolvedValueOnce({ availability: "available", unit: { ...unit, incarnationEpoch: 1 } });
    await render(); await check(); expect(rpc.contributors).not.toHaveBeenCalled(); expect(host.textContent).toContain("unavailable");
  });
  it("completed names disappear across selection changes and return only after Check", async () => {
    await render(); await check(); revision++; await render();
    expect(host.textContent).not.toContain("private contributor names"); expect(rpc.contributors).toHaveBeenCalledOnce();
    await check(); expect(rpc.contributors).toHaveBeenCalledTimes(2);
  });
  it.each(["focus", "pagehide", "offline"])("%s discards completed data without an automatic read", async event => {
    await render(); await check();
    if (event === "offline") Object.defineProperty(navigator, "onLine", { value: false, configurable: true });
    act(() => window.dispatchEvent(new Event(event)));
    await render(); expect(host.textContent).not.toContain("private contributor names"); expect(rpc.contributors).toHaveBeenCalledOnce();
    if (event === "pagehide") act(() => window.dispatchEvent(new Event("pageshow")));
    if (event === "offline") {
      Object.defineProperty(navigator, "onLine", { value: true, configurable: true });
      act(() => window.dispatchEvent(new Event("online")));
    }
    await render(); expect(rpc.contributors).toHaveBeenCalledOnce();
    await check(); expect(rpc.contributors).toHaveBeenCalledTimes(2);
  });
  it("profile refetch and preview ABA close a pending Check before it reaches people", async () => {
    const held = pending<unknown>(); rpc.catalog.mockReturnValueOnce(held.promise);
    await render(); await check();
    act(() => { preview.previewChanged(true); preview.previewChanged(false); qc.setQueryData(["myRealProfile"], { id: ACTOR, role: "supervisor", retired_at: null }); });
    await act(async () => held.resolve({ availability: "available", projectId: PROJECT, unit }));
    expect(rpc.contributors).not.toHaveBeenCalled();
  });
  it("uses the earlier profile deadline and never extends names from a late reply", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    qc.setQueryData(["myRealProfile"], { id: ACTOR, role: "supervisor", retired_at: null }, { updatedAt: Date.now() - 29_000 });
    await render(); await check(); expect(host.textContent).toContain("private contributor names");
    act(() => vi.advanceTimersByTime(1001)); expect(host.textContent).not.toContain("private contributor names"); expect(rpc.contributors).toHaveBeenCalledOnce();
  });
  it("StrictMode starts nothing automatically and sends only one checked read", async () => {
    strict = true; await render(); expect(rpc.catalog).not.toHaveBeenCalled();
    await check(); expect(rpc.contributors).toHaveBeenCalledOnce();
  });
  it("a real remount and a Suspense return both require another deliberate Check", async () => {
    await render(); await check(); const wait = pending<void>(); suspension = wait.promise; await render();
    suspension = null; await act(async () => wait.resolve()); await render();
    expect(host.textContent).not.toContain("private contributor names"); expect(rpc.contributors).toHaveBeenCalledOnce();
    await check(); expect(rpc.contributors).toHaveBeenCalledTimes(2);
    await act(async () => root.render(null)); await render(); expect(host.textContent).not.toContain("private contributor names");
    expect(rpc.contributors).toHaveBeenCalledTimes(2); await check(); expect(rpc.contributors).toHaveBeenCalledTimes(3);
  });
  it("refreshes a 31-second-old profile on the same explicit Check", async () => {
    qc.setQueryData(["myRealProfile"], { id: ACTOR, role: "supervisor", retired_at: null }, { updatedAt: Date.now() - 31000 });
    await render(); await check();
    expect(rpc.profile).toHaveBeenCalledOnce(); expect(rpc.contributors).toHaveBeenCalledOnce();
    expect(host.textContent).toContain("private contributor names");
  });
  it.each(["selection", "preview", "auth", "parent"])("rejects a late profile refresh across %s ABA", async cause => {
    qc.setQueryData(["myRealProfile"], { id: ACTOR, role: "supervisor", retired_at: null }, { updatedAt: Date.now() - 31000 });
    const held = pending<{ id: string; role: string; retired_at: null }>(); rpc.profile.mockReturnValueOnce(held.promise);
    await render(); await check();
    await act(async () => {
      if (cause === "selection") { revision += 2; }
      if (cause === "preview") { preview.previewChanged(true); preview.previewChanged(false); }
      if (cause === "auth") { rememberSignedIn(null); rememberSignedIn({ user: { id: ACTOR } }); }
      if (cause === "parent") { parentSource.invalidate(); }
    });
    await render(); await act(async () => held.resolve({ id: ACTOR, role: "supervisor", retired_at: null }));
    expect(rpc.catalog).not.toHaveBeenCalled(); expect(rpc.contributors).not.toHaveBeenCalled();
    expect(qc.getQueryState(["myRealProfile"])!.dataUpdatedAt).toBeLessThan(Date.now() - 30000);
  });
  it("erases names immediately on imperative parent invalidation without a parent render", async () => {
    await render(); await check(); expect(host.textContent).toContain("private contributor names");
    act(() => parentSource.invalidate()); expect(host.textContent).not.toContain("private contributor names");
    expect(rpc.contributors).toHaveBeenCalledOnce();
  });
  it("keeps a failed Check unavailable instead of changing its message at the deadline", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    rpc.catalog.mockRejectedValue(Error("failed")); await render(); await check();
    expect(host.textContent).toContain("unavailable"); act(() => vi.advanceTimersByTime(31000));
    expect(host.textContent).toContain("unavailable");
  });

});
