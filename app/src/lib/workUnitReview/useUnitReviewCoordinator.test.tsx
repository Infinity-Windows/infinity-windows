// @vitest-environment happy-dom
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { rememberSignedIn, signInMark } from "../signedIn";
import { createSensitivePreviewLifetime, ViewAsRoleContext, type ViewAsRoleValue } from "../viewAsRoleContext";
import { createUnitReviewSelectionSource, useUnitReviewCoordinator, type UnitReviewSelection } from "./useUnitReviewCoordinator";
import type { ReviewReply } from "./protocol";
import { UnitReviewCoordinator, type ReviewCoordinatorDependencies } from "./coordinator";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const OWNER = id(1), UNIT = id(2), JOB = id(3);
const view = (): ReviewReply => ({ protocolVersion: 1, asOf: "2026-10-04T12:00:00Z", availability: "available", review: {
  basis: { unitId: UNIT, unitRevision: 1, factId: id(4), factRevision: 1, scopeToken: `ur1:${"a".repeat(64)}`, reviewRevision: 0, submissionId: null, generation: 0 }, basisStatus: "current",
  observation: { observerId: id(5), source: "estimated", widthDecimal: "1", heightDecimal: "72", unit: "in", sourceReference: "private" },
  capabilities: { verifyDimensions: true, submit: true, pass: false, fail: false, claimResolved: false, reopen: false }, dimensionVerification: { state: "unverified", verificationId: null },
  qc: { state: "not_submitted", acceptance: "not_accepted", lifecycle: "unproven", qcAccepted: false }, work: { availability: "available", activeCount: 0, pendingCount: 0 }, defects: [],
} });
let root: Root, host: HTMLDivElement, latest: ReturnType<typeof useUnitReviewCoordinator>;
let source: ReturnType<typeof createUnitReviewSelectionSource>, seam: ReturnType<typeof createSensitivePreviewLifetime>;
let deps: Partial<ReviewCoordinatorDependencies>, input: UnitReviewSelection;
let role = "owner", stamp = 0;
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; };
function Reader() { latest = useUnitReviewCoordinator(source, deps); return <span>{latest.inspection.kind}</span>; }
async function mount(withSeam = true) {
  const preview: ViewAsRoleValue = { previewRole: null, previewPerson: null, canPreview: true, canPreviewPerson: true, setPreviewRole() {}, setPreviewPerson() {}, sensitiveLifetime: withSeam ? seam : undefined };
  await act(async () => root.render(<StrictMode><ViewAsRoleContext.Provider value={preview}><Reader /></ViewAsRoleContext.Provider></StrictMode>));
}
beforeEach(() => {
  role = "owner"; stamp = 0; rememberSignedIn({ user: { id: OWNER } });
  Object.defineProperty(navigator, "onLine", { configurable: true, value: true }); Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  source = createUnitReviewSelectionSource(); input = { login: signInMark(), realRole: "owner", selectedJobId: JOB, selectedUnitId: UNIT, binding: { unitId: UNIT, projectId: JOB }, admitted: () => true }; source.select(input);
  seam = createSensitivePreviewLifetime(() => ({ stamp: String(stamp), ownerId: OWNER, role, ready: true }), false);
  deps = { read: vi.fn().mockImplementation(async () => view()), journal: vi.fn().mockResolvedValue([]), receipt: vi.fn().mockResolvedValue({ protocolVersion: 1, availability: "unavailable", receipt: null }), send: vi.fn(), cancel: vi.fn(), reserve: vi.fn() };
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); rememberSignedIn(null); vi.restoreAllMocks(); vi.useRealTimers(); });
it("survives StrictMode and mount/check are receipt-only with no cached view", async () => {
  await mount(); expect(latest.inspection.kind).toBe("ready"); expect(deps.send).not.toHaveBeenCalled(); expect(deps.cancel).not.toHaveBeenCalled();
  await act(async () => { await latest.refresh(); }); expect(latest.inspection.kind).toBe("ready"); expect(deps.send).not.toHaveBeenCalled();
});
it("fails closed without the new preview authority seam", async () => { await mount(false); expect(latest.inspection.kind).toBe("held"); expect(deps.read).not.toHaveBeenCalled(); });
it.each(["preview", "person", "role", "owner", "selection", "offline", "visibility"])("invalidates a late read and captured callback through %s ABA", async boundary => {
  await mount(); const old = latest, pending = deferred<ReviewReply>(); vi.mocked(deps.read!).mockReturnValueOnce(pending.promise);
  let checking!: Promise<void>; await act(async () => { checking = old.refresh(); });
  const admission = vi.mocked(deps.read!).mock.calls.at(-1)![2]!;
  await act(async () => {
    if (boundary === "preview" || boundary === "person") { seam.previewChanged(true); seam.previewChanged(false); }
    if (boundary === "role") { role = "installer"; stamp++; seam.authorityChanged(); role = "owner"; stamp++; seam.authorityChanged(); }
    if (boundary === "owner") { rememberSignedIn(null); rememberSignedIn({ user: { id: OWNER } }); source.select({ ...input, login: signInMark() }); }
    if (boundary === "selection") { source.invalidate(); source.select(input); }
    if (boundary === "offline") { window.dispatchEvent(new Event("offline")); window.dispatchEvent(new Event("online")); }
    if (boundary === "visibility") { document.dispatchEvent(new Event("visibilitychange")); document.dispatchEvent(new Event("visibilitychange")); }
  });
  expect(admission()).toBe(false); expect(old.current()).toBe(false);
  await act(async () => { pending.resolve(view()); await checking; await old.author({ action: "submit", basis: view().availability === "available" ? (view() as Extract<ReviewReply, {availability:"available"}>).review.basis : null, data: { note: "late" } }); });
  expect(deps.reserve).not.toHaveBeenCalled(); expect(deps.send).not.toHaveBeenCalled();
});
it("requires exact selected job/unit binding and live source admission", async () => {
  source.select({ ...input, binding: { unitId: UNIT, projectId: id(99) } }); await mount(); expect(deps.read).not.toHaveBeenCalled();
  await act(async () => source.select(input)); expect(latest.inspection.kind).toBe("ready");
  input.admitted = () => false; expect(latest.current()).toBe(true); // Frozen selection keeps its original callback.
  await act(async () => source.select(input)); expect(latest.inspection.kind).toBe("held");
});
it("duplicate reservation created=false never auto-delivers", async () => {
  await mount(); vi.mocked(deps.reserve!).mockImplementation(async (_login, original) => ({ created: false, record: { ...original } as never }));
  const r = view() as Extract<ReviewReply, {availability:"available"}>;
  await act(async () => { await latest.author({ action: "submit", basis: r.review.basis, data: { note: "same decision" } }); });
  expect(deps.reserve).toHaveBeenCalledTimes(1); expect(deps.send).not.toHaveBeenCalled();
});
it("stops between durable save and send if the source lifetime ends", async () => {
  await mount(); vi.mocked(deps.reserve!).mockImplementation(async (_login, original) => { source.invalidate(); return { created: true, record: { ...original } as never }; });
  const r = view() as Extract<ReviewReply, {availability:"available"}>;
  await act(async () => { await latest.author({ action: "submit", basis: r.review.basis, data: { note: null } }); });
  expect(deps.send).not.toHaveBeenCalled(); expect(latest.inspection.kind).toBe("held");
});
it("rejects a final late result after unmount", async () => {
  await mount(); const old = latest, pending = deferred<ReviewReply>(); vi.mocked(deps.read!).mockReturnValueOnce(pending.promise);
  let checking!: Promise<void>; await act(async () => { checking = old.refresh(); }); act(() => root.unmount());
  expect(old.current()).toBe(false); await act(async () => { pending.resolve(view()); await checking; });
  root = createRoot(host); expect(deps.send).not.toHaveBeenCalled();
});

it("checks the live parent source at final await even without a React rerender", async () => {
  let allowed = true; source.select({ ...input, admitted: () => allowed }); await mount();
  const old = latest, pending = deferred<ReviewReply>(); vi.mocked(deps.read!).mockReturnValueOnce(pending.promise);
  let checking!: Promise<void>; await act(async () => { checking = old.refresh(); });
  allowed = false; expect(old.current()).toBe(false);
  await act(async () => { pending.resolve(view()); await checking; });
  expect(deps.send).not.toHaveBeenCalled();
});
it("requires a fresh exact unit selection even if the selected job is unchanged", async () => {
  await mount(); const old = latest;
  await act(async () => source.select({ ...input, selectedUnitId: id(8), binding: { unitId: UNIT, projectId: JOB } }));
  expect(old.current()).toBe(false); expect(latest.inspection.kind).toBe("held");
});

it("retains only safe storage-failure status when the initial journal read fails", async () => {
  vi.mocked(deps.journal!).mockRejectedValue(new Error("Private storage details")); await mount();
  expect(latest.inspection.kind).toBe("held"); expect(latest.notice).toBe("storage_unavailable");
  expect(deps.send).not.toHaveBeenCalled();
});

it("catches an unexpected initial refresh rejection without exposing a stale inspection", async () => {
  vi.spyOn(UnitReviewCoordinator.prototype, "refresh").mockRejectedValue(new Error("Unexpected private details"));
  await mount(); expect(latest.inspection.kind).toBe("held"); expect(latest.notice).toBe("unavailable");
});
