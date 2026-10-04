// @vitest-environment happy-dom
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rememberSignedIn, signInGeneration } from "../signedIn";
import { ViewAsRoleContext, type ViewAsRoleValue } from "../viewAsRoleContext";
import type { ReviewReply } from "./protocol";
const read = vi.fn();
vi.mock("./api", () => ({ fetchUnitReview: (...args: unknown[]) => read(...args) }));
const { useUnitReviewRead } = await import("./useUnitReviewRead");
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const OWNER = id(1), UNIT = id(2);
const value = (revision = 1): ReviewReply => ({ protocolVersion: 1, asOf: "2026-10-04T12:00:00Z", availability: "available", review: {
  basis: { unitId: UNIT, unitRevision: 1, factId: id(3), factRevision: 1, scopeToken: "ur1:" + "a".repeat(64), reviewRevision: revision, submissionId: null, generation: 0 },
  basisStatus: "current", capabilities: { verifyDimensions: false, submit: false, pass: false, fail: false, claimResolved: false, reopen: false },
  observation: null, dimensionVerification: { state: "unverified", verificationId: null },
  qc: { state: "not_submitted", acceptance: "not_accepted", lifecycle: "unproven", qcAccepted: false },
  work: { availability: "unavailable", activeCount: null, pendingCount: null }, defects: [],
} });
const preview: ViewAsRoleValue = { previewRole: null, previewPerson: null, canPreview: true, canPreviewPerson: true, setPreviewRole() {}, setPreviewPerson() {} };
let root: Root, host: HTMLDivElement, connected: boolean, foreground: boolean;
let latest: ReturnType<typeof useUnitReviewRead>;
type Props = { unit?: string | null; context?: string | null; enabled?: boolean; view?: ViewAsRoleValue; strict?: boolean };
function View({ unit = UNIT, context = "job-a:visit-1", enabled = true }: Props) {
  latest = useUnitReviewRead(unit, context, enabled);
  return <span>{latest.state}</span>;
}
async function render(props: Props = {}) {
  await act(async () => {
    const child = <ViewAsRoleContext.Provider value={props.view ?? preview}><View {...props} /></ViewAsRoleContext.Provider>;
    root.render(props.strict ? <StrictMode>{child}</StrictMode> : child);
  });
}
async function environment(online: boolean, visible = true) {
  await act(async () => { connected = online; foreground = visible; window.dispatchEvent(new Event(online ? "online" : "offline")); document.dispatchEvent(new Event("visibilitychange")); });
}
function deferred() { let resolve!: (reply: ReviewReply) => void; const promise = new Promise<ReviewReply>(yes => { resolve = yes; }); return { promise, resolve }; }
function revision() { const reply = latest.data?.value; return reply?.availability === "available" ? reply.review.basis?.reviewRevision : undefined; }
beforeEach(() => {
  connected = true; foreground = true;
  Object.defineProperty(navigator, "onLine", { configurable: true, get: () => connected });
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => foreground ? "visible" : "hidden" });
  rememberSignedIn({ user: { id: OWNER } }); read.mockReset().mockResolvedValue(value());
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount()); host.remove(); rememberSignedIn(null); vi.useRealTimers();
  delete (navigator as unknown as { onLine?: boolean }).onLine;
  delete (document as unknown as { visibilityState?: string }).visibilityState;
});
describe("fresh private unit inspection", () => {
  it("binds the real login and survives StrictMode effect replay", async () => {
    await render({ strict: true }); expect(revision()).toBe(1);
    expect(read).toHaveBeenLastCalledWith(UNIT, { userId: OWNER, generation: signInGeneration() }, expect.any(Function));
  });
  it.each([{ unit: null }, { unit: "invalid" }, { context: null }, { context: " " }, { enabled: false },
    { view: { ...preview, previewRole: "installer" as const } }, { view: { ...preview, previewPerson: { id: id(9), name: "Preview", role: "installer" } } }])("blocks an inadmissible view %j", async props => {
    await render(props); expect(latest.state).toBe("blocked"); expect(latest.data).toBeUndefined(); expect(read).not.toHaveBeenCalled();
  });
  it("hides old data immediately on refresh and keeps refused refresh unavailable", async () => {
    await render(); const pending = deferred(); read.mockReturnValueOnce(pending.promise);
    let refresh!: Promise<void>; await act(async () => { refresh = latest.refresh(); });
    expect(latest.state).toBe("loading"); expect(latest.data).toBeUndefined();
    await act(async () => { pending.resolve({ protocolVersion: 1, asOf: "2026-10-04T12:00:01Z", availability: "unavailable", review: null }); await refresh; });
    expect(latest.state).toBe("unavailable"); expect(latest.data).toBeUndefined();
    read.mockRejectedValueOnce(Error("revoked")); await act(async () => { await latest.refresh(); });
    expect(latest.state).toBe("unavailable");
  });
  it("rejects a late response after another unit or job route lifetime is selected", async () => {
    const pending = deferred(); read.mockReturnValueOnce(pending.promise); await render();
    const admission = read.mock.calls[0][2] as () => boolean;
    await render({ unit: id(8), context: "job-b:visit-1" }); expect(admission()).toBe(false);
    await act(async () => { pending.resolve(value(999)); }); expect(revision()).toBe(1);
    const old = deferred(); read.mockReturnValueOnce(old.promise); await render({ context: "job-a:visit-2" });
    await render({ context: "job-a:visit-3" }); await act(async () => { old.resolve(value(998)); }); expect(revision()).toBe(1);
  });
  it("rejects old reads after same-person logout/login ABA", async () => {
    const pending = deferred(); read.mockReturnValueOnce(pending.promise); await render(); const generation = signInGeneration();
    await act(async () => { rememberSignedIn(null); rememberSignedIn({ user: { id: OWNER } }); });
    expect(signInGeneration()).toBeGreaterThan(generation);
    await act(async () => { pending.resolve(value(999)); }); expect(revision()).toBe(1);
  });
  it("erases evidence during preview and never revives its old in-flight response", async () => {
    await render(); const pending = deferred(); read.mockReturnValueOnce(pending.promise);
    await act(async () => { void latest.refresh(); });
    await render({ view: { ...preview, previewRole: "foreman" } }); expect(latest.data).toBeUndefined();
    await render(); await act(async () => { pending.resolve(value(999)); }); expect(revision()).toBe(1);
  });
  it("hides evidence offline/background and reads fresh on return", async () => {
    await render(); await environment(false); expect(latest.state).toBe("blocked"); expect(latest.data).toBeUndefined();
    read.mockResolvedValue(value(2)); await environment(true); expect(revision()).toBe(2);
    await environment(true, false); expect(latest.data).toBeUndefined(); read.mockResolvedValue(value(3));
    await environment(true); expect(revision()).toBe(3);
  });
  it("only allows the newest concurrent refresh to publish", async () => {
    await render(); const first = deferred(), second = deferred(); read.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    await act(async () => { void latest.refresh(); void latest.refresh(); });
    await act(async () => { second.resolve(value(2)); }); expect(revision()).toBe(2);
    await act(async () => { first.resolve(value(999)); }); expect(revision()).toBe(2);
  });
  it("refreshes on foreground focus and its bounded timer without writing", async () => {
    vi.useFakeTimers(); await render(); read.mockResolvedValue(value(2));
    await act(async () => { window.dispatchEvent(new Event("focus")); }); expect(revision()).toBe(2);
    read.mockResolvedValue(value(3)); await act(async () => { await vi.advanceTimersByTimeAsync(30_000); }); expect(revision()).toBe(3);
  });
  it("invalidates the read admission after unmount", async () => {
    const pending = deferred(); read.mockReturnValueOnce(pending.promise); await render();
    const admission = read.mock.calls[0][2] as () => boolean; expect(admission()).toBe(true);
    act(() => root.unmount()); root = createRoot(host); expect(admission()).toBe(false);
    await act(async () => { pending.resolve(value(999)); });
  });
});
