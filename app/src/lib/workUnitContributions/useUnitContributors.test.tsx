// @vitest-environment happy-dom
import { act, StrictMode, Suspense, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rememberSignedIn, signInMark } from "../signedIn";
import { ViewAsRoleContext, createSensitivePreviewLifetime } from "../viewAsRoleContext";
import { createUnitReviewSelectionSource } from "../workUnitReview/selection";
import { useUnitContributors } from "./useUnitContributors";
import { parseUnitContributorsReply, type UnitContributorsReply } from "./protocol";
import type { UnitContributorsScope } from "./api";
import corpus from "./__fixtures__/sourceMatchedWire.json";

const fetch = vi.hoisted(() => vi.fn());
vi.mock("./api", () => ({ fetchUnitContributors: fetch }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const ACTOR = "00000000-0000-4000-8000-000000250002";
const PROJECT = "00000000-0000-4000-8000-000000250010";
const UNIT = "00000000-0000-4000-8000-000000250030";
const SCOPE = { projectId: PROJECT, unitId: UNIT, unitIncarnation: "0" };
const reply = parseUnitContributorsReply(corpus.calls[0].reply, { actorId: ACTOR, ...SCOPE });
const unavailable: UnitContributorsReply = { protocolVersion: 1, availability: "unavailable", contributors: null };
let root: Root, host: HTMLDivElement, qc: QueryClient;
let source: ReturnType<typeof createUnitReviewSelectionSource>, preview: ReturnType<typeof createSensitivePreviewLifetime>;
let allowed: boolean, revision: number, scope: UnitContributorsScope | null, strict: boolean;
let suspension: Promise<void> | null;
let closeStartup: boolean;
let result: ReturnType<typeof useUnitContributors>;
const parent = () => allowed;
function Reader() {
  result = useUnitContributors(scope, source, parent, revision);
  useLayoutEffect(() => { if (closeStartup) allowed = false; });
  if (suspension) throw suspension;
  return <div>{result.data ? "private unit data" : "hidden"}</div>;
}
async function render() {
  await act(async () => {
    const reader = <QueryClientProvider client={qc}><ViewAsRoleContext.Provider value={{
      previewRole: null, previewPerson: null, canPreview: false, canPreviewPerson: false,
      setPreviewRole: () => {}, setPreviewPerson: () => {}, sensitiveLifetime: preview,
    }}><Suspense fallback={<div>waiting</div>}><Reader /></Suspense></ViewAsRoleContext.Provider></QueryClientProvider>;
    root.render(strict ? <StrictMode>{reader}</StrictMode> : reader);
  });
}
function select() {
  source.select({ login: signInMark(), realRole: "supervisor", selectedJobId: PROJECT, selectedUnitId: UNIT,
    binding: { projectId: PROJECT, unitId: UNIT }, admitted: parent });
}
function held<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { resolve, promise };
}
beforeEach(() => {
  rememberSignedIn({ user: { id: ACTOR } });
  Object.defineProperty(window.navigator, "onLine", { value: true, configurable: true });
  allowed = true; revision = 1; scope = { ...SCOPE }; strict = false; suspension = null; closeStartup = false;
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(["myRealProfile"], { id: ACTOR, role: "supervisor", retired_at: null });
  preview = createSensitivePreviewLifetime(() => {
    const state = qc.getQueryState<{ id: string; role: string }>(["myRealProfile"]);
    return { stamp: JSON.stringify([state?.dataUpdateCount, state?.status, state?.isInvalidated]),
      ownerId: state?.data?.id ?? null, role: state?.data?.role ?? null,
      ready: state?.status === "success" && !state.isInvalidated };
  }, false);
  source = createUnitReviewSelectionSource(); select();
  fetch.mockReset().mockResolvedValue(reply);
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); qc.clear(); host.remove(); rememberSignedIn(null); vi.useRealTimers(); });

describe("one deliberate private contributor snapshot", () => {
  it("binds independently known incarnation and shows one frozen reply without a query cache", async () => {
    await render(); expect(result.data).toEqual(reply.contributors);
    expect(fetch).toHaveBeenCalledOnce(); expect(fetch.mock.calls[0][0]).toEqual(SCOPE);
    expect(qc.getQueryCache().findAll()).toHaveLength(1);
  });
  it("does not read until the parent provides a deliberately checked scope", async () => {
    scope = null; await render(); expect(fetch).not.toHaveBeenCalled();
    scope = { ...SCOPE }; await render(); expect(fetch).toHaveBeenCalledOnce();
  });
  it("does not restart on equivalent inline scope objects or unrelated renders", async () => {
    await render(); scope = { ...SCOPE }; await render(); expect(fetch).toHaveBeenCalledOnce();
    expect(result.data).toEqual(reply.contributors);
  });
  it("a missing basis cannot reopen the same Check when it returns", async () => {
    await render(); scope = null; await render(); expect(result.data).toBeNull();
    scope = { ...SCOPE }; await render(); expect(result.data).toBeNull(); expect(fetch).toHaveBeenCalledOnce();
    revision++; await render(); expect(fetch).toHaveBeenCalledTimes(2); expect(result.data).toEqual(reply.contributors);
  });
  it("another unit consumes the current Check and requires a new revision", async () => {
    await render();
    const otherUnit = "00000000-0000-4000-8000-000000250031";
    scope = { ...SCOPE, unitId: otherUnit };
    act(() => source.select({ login: signInMark(), realRole: "supervisor", selectedJobId: PROJECT, selectedUnitId: otherUnit,
      binding: { projectId: PROJECT, unitId: otherUnit }, admitted: parent }));
    await render(); expect(result.data).toBeNull(); expect(fetch).toHaveBeenCalledOnce();
    revision++; await render(); expect(fetch).toHaveBeenCalledTimes(2); expect(fetch.mock.calls[1][0]).toEqual(scope);
  });
  it("a rebuilt unit consumes the current Check even when its ID stays the same", async () => {
    await render(); scope = { ...SCOPE, unitIncarnation: "1" }; await render();
    expect(result.data).toBeNull(); expect(fetch).toHaveBeenCalledOnce();
    revision++; await render(); expect(fetch).toHaveBeenCalledTimes(2); expect(fetch.mock.calls[1][0]).toEqual(scope);
  });
  it("world changes during a missing basis stay blocked until a fresh Check", async () => {
    await render(); scope = null; await render();
    act(() => { source.invalidate(); select(); preview.previewChanged(true); preview.previewChanged(false); });
    scope = { ...SCOPE }; await render(); expect(result.data).toBeNull(); expect(fetch).toHaveBeenCalledOnce();
    revision++; await render(); expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("a fresh Check during a missing basis opens once when its new scope arrives", async () => {
    await render(); scope = null; revision++; await render();
    scope = { ...SCOPE }; await render(); expect(fetch).toHaveBeenCalledTimes(2); expect(result.data).toEqual(reply.contributors);
  });
  it("authority closing before startup sends no RPC and still consumes Check", async () => {
    closeStartup = true; await render(); expect(fetch).not.toHaveBeenCalled(); expect(result.data).toBeNull();
    closeStartup = false; allowed = true; await render(); expect(fetch).not.toHaveBeenCalled(); expect(result.data).toBeNull();
    revision++; await render(); expect(fetch).toHaveBeenCalledOnce(); expect(result.data).toEqual(reply.contributors);
  });
  it("keeps unavailable distinct from zero", async () => {
    fetch.mockResolvedValue(unavailable); await render(); expect(result.state).toBe("unavailable"); expect(result.data).toBeNull();
  });
  it.each(["foreman", "installer", "partner"])("never opens named employee data for %s", async role => {
    qc.setQueryData(["myRealProfile"], { id: ACTOR, role, retired_at: null });
    await render(); expect(fetch).not.toHaveBeenCalled(); expect(result.data).toBeNull();
  });
  it.each(["foreign", "retired", "stale"])("holds a %s actual profile", async kind => {
    qc.setQueryData(["myRealProfile"], { id: kind === "foreign" ? UNIT : ACTOR, role: "supervisor",
      retired_at: kind === "retired" ? "2026-10-04T00:00:00Z" : null },
    { updatedAt: kind === "stale" ? Date.now() - 30_001 : Date.now() });
    await render(); expect(fetch).not.toHaveBeenCalled(); expect(result.data).toBeNull();
  });
  it("discards a response across unit selection ABA and requires another Check", async () => {
    const response = held<UnitContributorsReply>(); fetch.mockReturnValueOnce(response.promise);
    await render(); act(() => { source.invalidate(); select(); });
    await act(async () => response.resolve(reply)); expect(result.data).toBeNull(); expect(fetch).toHaveBeenCalledOnce();
    revision++; await render(); expect(fetch).toHaveBeenCalledTimes(2); expect(result.data).toEqual(reply.contributors);
  });
  it("checks live parent authority at the final await and never later revives the reply", async () => {
    const response = held<UnitContributorsReply>(); fetch.mockReturnValueOnce(response.promise);
    await render(); allowed = false; await act(async () => response.resolve(reply));
    expect(result.data).toBeNull(); allowed = true; await render(); expect(result.data).toBeNull(); expect(fetch).toHaveBeenCalledOnce();
  });
  it("erases completed data when admission closes and stays held until an explicit Check", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    await render(); expect(host.textContent).toBe("private unit data");
    allowed = false; act(() => vi.advanceTimersByTime(1000)); expect(host.textContent).toBe("hidden");
    allowed = true; await render(); expect(result.data).toBeNull(); expect(fetch).toHaveBeenCalledOnce();
    revision++; await render(); expect(result.data).toEqual(reply.contributors); expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("profile invalidation and refetch do not automatically send another private read", async () => {
    await render(); act(() => { void qc.invalidateQueries({ queryKey: ["myRealProfile"], refetchType: "none" }); });
    expect(result.data).toBeNull();
    act(() => qc.setQueryData(["myRealProfile"], { id: ACTOR, role: "supervisor", retired_at: null }));
    await render(); expect(result.data).toBeNull(); expect(fetch).toHaveBeenCalledOnce();
    revision++; await render(); expect(result.data).toEqual(reply.contributors);
  });
  it.each(["offline", "background"])("%s closes data; return does not replay a read", async kind => {
    await render();
    if (kind === "offline") Object.defineProperty(window.navigator, "onLine", { value: false, configurable: true });
    act(() => window.dispatchEvent(new Event(kind === "offline" ? "offline" : "pagehide")));
    expect(result.data).toBeNull();
    if (kind === "offline") Object.defineProperty(window.navigator, "onLine", { value: true, configurable: true });
    act(() => window.dispatchEvent(new Event(kind === "offline" ? "online" : "pageshow")));
    await render(); expect(result.data).toBeNull(); expect(fetch).toHaveBeenCalledOnce();
    revision++; await render(); expect(result.data).toEqual(reply.contributors);
  });
  it("preview ABA and login ABA both erase names without another read", async () => {
    await render(); act(() => { preview.previewChanged(true); preview.previewChanged(false); });
    expect(result.data).toBeNull(); expect(fetch).toHaveBeenCalledOnce();
    revision++; await render(); expect(result.data).not.toBeNull();
    act(() => { rememberSignedIn(null); rememberSignedIn({ user: { id: ACTOR } }); });
    expect(result.data).toBeNull(); expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("expires at request start rather than extending the lifetime for a slow response", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    const response = held<UnitContributorsReply>(); fetch.mockReturnValueOnce(response.promise);
    await render(); act(() => vi.advanceTimersByTime(29_000)); await act(async () => response.resolve(reply));
    expect(result.data).not.toBeNull(); act(() => vi.advanceTimersByTime(1001));
    expect(result.data).toBeNull(); expect(fetch).toHaveBeenCalledOnce();
  });
  it("uses the earlier profile expiry rather than keeping names until the read deadline", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    qc.setQueryData(["myRealProfile"], { id: ACTOR, role: "supervisor", retired_at: null }, { updatedAt: Date.now() - 29_000 });
    await render(); expect(result.data).not.toBeNull(); act(() => vi.advanceTimersByTime(1001));
    expect(result.data).toBeNull(); expect(fetch).toHaveBeenCalledOnce();
  });
  it("Suspense reactivation cannot repeat a completed Check", async () => {
    await render(); const wait = held<void>(); suspension = wait.promise; await render();
    expect(host.textContent).toContain("waiting");
    suspension = null; await act(async () => wait.resolve()); await render();
    expect(result.data).toBeNull(); expect(fetch).toHaveBeenCalledOnce();
    revision++; await render(); expect(fetch).toHaveBeenCalledTimes(2); expect(result.data).toEqual(reply.contributors);
  });
  it("a replaced QueryClient requires a fresh Check even with identical profile metadata", async () => {
    await render(); const old = qc;
    const state = old.getQueryState(["myRealProfile"]);
    qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryData(["myRealProfile"], state?.data, { updatedAt: state?.dataUpdatedAt });
    await render(); expect(result.data).toBeNull(); expect(fetch).toHaveBeenCalledOnce(); old.clear();
    revision++; await render(); expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("StrictMode sends only the surviving startup read", async () => {
    strict = true; await render(); expect(result.data).toEqual(reply.contributors);
    expect(fetch).toHaveBeenCalledOnce(); expect(fetch.mock.calls[0][2]()).toBe(true);
  });
});
