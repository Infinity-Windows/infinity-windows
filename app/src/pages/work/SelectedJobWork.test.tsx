// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rememberSignedIn } from "../../lib/signedIn";
import type { ProjectActivityViewProps } from "../../components/work/ProjectActivityView";
import type { Snapshot } from "../../lib/workActivity/protocol";
import type { SelectedJobWorkProps } from "./SelectedJobWork";

const ID = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
const OWNER = ID(1), DEVICE = ID(2), JOB = ID(3), COMMAND = ID(4);
const at = "2026-10-04T06:00:00.000000Z";
let seen: ProjectActivityViewProps | null = null;
const m = vi.hoisted(() => ({
  device: vi.fn(), head: vi.fn(), save: vi.fn(), dispatch: vi.fn(),
  snapshot: vi.fn(), catalog: vi.fn(), unit: vi.fn(),
}));
vi.mock("../../components/work/ProjectActivityView", () => ({
  ProjectActivityView: (props: ProjectActivityViewProps) => {
    seen = props;
    return <div data-testid="mock-view">
      <span>{props.catalog.status}:{String(props.catalog.capturable)}</span>
      <button onClick={props.onBreak}>Break</button><button onClick={props.onClockOut}>Clock out</button>
      <button onClick={props.onSchedule}>Schedule</button><button onClick={props.onAsk}>Ask</button>
      <button onClick={props.onOpenClock}>Clock</button>
    </div>;
  },
}));
vi.mock("../../lib/workActivity/device", () => ({ getActivityDeviceId: () => m.device() }));
vi.mock("../../lib/workActivity/journal", () => ({ getCurrentActivityCommand: () => m.head() }));
vi.mock("../../lib/workActivity/saveTap", () => ({ saveActivityTap: (...args: unknown[]) => m.save(...args) }));
vi.mock("../../lib/workActivity/dispatch", () => ({ dispatchSavedActivityCommand: (...args: unknown[]) => m.dispatch(...args) }));
vi.mock("../../lib/workActivity/useActivityReads", () => ({
  useActivitySnapshot: (...args: unknown[]) => m.snapshot(...args),
  useActivityUnitBasis: (...args: unknown[]) => m.unit(...args),
}));
vi.mock("../../lib/workActivity/useActivityCatalog", () => ({
  useActivityCatalog: (...args: unknown[]) => m.catalog(...args),
}));
const { SelectedJobWork } = await import("./SelectedJobWork");
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement, root: Root, props: SelectedJobWorkProps;
const snapshot: Snapshot = { protocolVersion: 1, asOf: at, deviceId: DEVICE,
  capability: { mode: "active", reasonCode: null },
  observation: { id: ID(5), revision: 0, lastTransitionId: null, issuedAt: at,
    expiresAt: "2026-10-04T07:00:00.000000Z", shiftRef: null, currentGeneration: null, currentHeadCommandId: null },
  stream: null, state: { revision: 0, lastTransitionId: null, integrity: "clean", status: "off_clock",
    choiceRequired: false, actions: { canEstablishStream: true, canSwitch: false, canFinishSetup: false, canStop: false },
    shift: null, activity: null } };
const record = { encodingVersion: 2, commandId: COMMAND, ownerId: OWNER, payload: { deviceId: DEVICE }, uncertain: false, receipt: null };
function base(): SelectedJobWorkProps {
  return { project: { id: JOB, name: "Job A" }, units: [], featureEnabled: true, previewDisabled: false,
    paidSeconds: null, setupAllocation: null, onAddUnit: vi.fn(), onOpenClock: vi.fn(), onBreak: vi.fn(),
    onClockOut: vi.fn(), onSchedule: vi.fn(), onAsk: vi.fn() };
}
async function render(changes: Partial<SelectedJobWorkProps> = {}) {
  props = { ...props, ...changes };
  await act(async () => { root.render(<SelectedJobWork {...props} />); await Promise.resolve(); });
  await act(async () => { await Promise.resolve(); });
}
function button(label: string) { return [...host.querySelectorAll("button")].find((b) => b.textContent === label)!; }
async function click(label: string) { await act(async () => button(label).click()); }
beforeEach(() => {
  rememberSignedIn({ user: { id: OWNER } }); seen = null;
  for (const fn of Object.values(m)) fn.mockReset();
  m.device.mockResolvedValue(DEVICE); m.head.mockResolvedValue(null);
  m.snapshot.mockImplementation((_id: string | null, enabled: boolean) => ({
    state: enabled ? "ready" : "blocked", data: enabled ? { value: snapshot, requestStartedAt: performance.now(), login: { userId: OWNER, generation: 1 } } : undefined,
    refresh: vi.fn(async () => {}),
  }));
  m.catalog.mockImplementation((_job: string, _unit: string | null, enabled: boolean) => ({
    state: enabled ? "ready" : "blocked", data: enabled ? { value: { availability: "available", selection: null, unit: null }, requestStartedAt: performance.now() } : undefined,
    refresh: vi.fn(async () => {}),
  }));
  m.unit.mockReturnValue({ state: "blocked", data: undefined, refresh: vi.fn(async () => {}) });
  props = base(); host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); rememberSignedIn(null); });
describe("dormant selected-job orchestration", () => {
  it("keeps independent clock and navigation controls through unavailable RPC and preview", async () => {
    m.snapshot.mockReturnValue({ state: "unavailable", data: undefined, refresh: vi.fn() });
    await render();
    expect(host.textContent).toContain("unavailable");
    await click("Break"); await click("Clock out"); await click("Schedule"); await click("Ask"); await click("Clock");
    expect(props.onBreak).toHaveBeenCalledOnce(); expect(props.onClockOut).toHaveBeenCalledOnce();
    expect(props.onSchedule).toHaveBeenCalledOnce(); expect(props.onAsk).toHaveBeenCalledOnce();
    await render({ previewDisabled: true });
    expect(seen?.catalog.capturable).toBe(false);
    expect(m.device).toHaveBeenCalledTimes(1);
  });
  it("requires a human reaffirmation before any stream command", async () => {
    await render();
    expect(m.save).not.toHaveBeenCalled();
    expect(button("Reaffirm activity stream")).toBeTruthy();
    m.save.mockResolvedValue({ kind: "held", reason: "expired_observation" });
    await click("Reaffirm activity stream");
    expect(m.save.mock.calls[0][2]).toEqual({ kind: "establish_stream", previousGeneration: null, previousHeadCommandId: null });
    expect(m.dispatch).not.toHaveBeenCalled();
  });
  it("waits for durable save before dispatch and locks further taps on unknown", async () => {
    let commit!: (value: unknown) => void;
    m.save.mockImplementation(() => new Promise((resolve) => { commit = resolve; }));
    m.dispatch.mockResolvedValue({ kind: "unknown" });
    await render();
    await act(async () => { button("Reaffirm activity stream").click(); });
    expect(m.dispatch).not.toHaveBeenCalled();
    await act(async () => { commit({ kind: "saved", record }); await Promise.resolve(); });
    expect(m.dispatch).toHaveBeenCalledWith(DEVICE, COMMAND, expect.any(Object), "first_attempt");
    expect(seen?.activityPending).toBe(true);
    expect(button("Check receipt and retry original request")).toBeTruthy();
    await click("Check receipt and retry original request");
    expect(m.dispatch).toHaveBeenLastCalledWith(DEVICE, COMMAND, expect.any(Object), "retry_original");
  });
  it("drops late device resolution across logout and navigation", async () => {
    let release!: (id: string) => void;
    m.device.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    await render();
    await act(async () => { rememberSignedIn(null); release(DEVICE); await Promise.resolve(); });
    expect(m.snapshot.mock.calls.at(-1)?.[1]).toBe(false);
    expect(m.save).not.toHaveBeenCalled();
    await render({ project: { id: ID(9), name: "Other job" } });
    expect(seen?.project.id).toBe(ID(9));
  });
  it("looks up an uncertain saved head on remount and never sends a second attempt automatically", async () => {
    m.head.mockResolvedValue({ ...record, uncertain: true });
    m.dispatch.mockResolvedValue({ kind: "held", reason: "receipt_unknown" });
    await render();
    expect(m.dispatch).toHaveBeenCalledWith(DEVICE, COMMAND, expect.any(Object), "first_attempt");
    expect(m.save).not.toHaveBeenCalled();
    expect(seen?.activityPending).toBe(true);
    await click("Check receipt and retry original request");
    expect(m.dispatch).toHaveBeenLastCalledWith(DEVICE, COMMAND, expect.any(Object), "retry_original");
  });
  it("offers only a human-initiated new generation beside an uncertain original", async () => {
    const original = { ...record, uncertain: true };
    m.head.mockResolvedValue(original);
    m.dispatch.mockResolvedValue({ kind: "held", reason: "receipt_unknown" });
    m.save.mockResolvedValue({ kind: "held", reason: "needs_reaffirmation" });
    await render();
    expect(m.save).not.toHaveBeenCalled();
    expect(button("Reaffirm activity stream")).toBeTruthy();
    await click("Reaffirm activity stream");
    expect(m.save.mock.calls[0][2]).toEqual({ kind: "establish_stream", previousGeneration: null, previousHeadCommandId: null });
    expect(original).toMatchObject({ commandId: COMMAND, uncertain: true, receipt: null });
    expect(m.dispatch).toHaveBeenCalledTimes(1); // receipt lookup only, no automatic retry
  });
  it("hides private activity details offline while leaving clock controls available", async () => {
    await render();
    m.snapshot.mockReturnValue({ state: "blocked", data: undefined, refresh: vi.fn() });
    m.catalog.mockReturnValue({ state: "blocked", data: undefined, refresh: vi.fn() });
    await render();
    expect(seen?.catalog.capturable).toBe(false);
    expect(seen?.running).toBeNull();
    await click("Clock out"); await click("Break");
    expect(props.onClockOut).toHaveBeenCalledOnce(); expect(props.onBreak).toHaveBeenCalledOnce();
  });
  it("blocks activity actions when the durable journal cannot be read", async () => {
    m.head.mockRejectedValue(Error("storage"));
    await render();
    expect(host.textContent).toContain("unavailable");
    expect(button("Reaffirm activity stream")).toBeUndefined();
    expect(m.save).not.toHaveBeenCalled();
  });
  it("refuses to dispatch an old saved tap after sign-out during the native save", async () => {
    let commit!: (value: unknown) => void;
    m.save.mockImplementation(() => new Promise((resolve) => { commit = resolve; }));
    await render();
    await act(async () => { button("Reaffirm activity stream").click(); });
    await act(async () => { rememberSignedIn(null); commit({ kind: "saved", record }); await Promise.resolve(); });
    expect(m.dispatch).not.toHaveBeenCalled();
    expect(seen?.catalog.capturable).toBe(false);
  });
  it("passes exact published IDs and answers into the save boundary", async () => {
    const selected = { selectionId: ID(10), selectionRevision: 3, menuVersionId: ID(11), eligibleNow: true,
      activities: [{ definitionId: ID(12), definitionVersionId: ID(13), position: 0, enabled: true,
        scope: "general", labelEn: "Frame", labelEs: "Marco", machineSelection: false,
        typedFields: [], eligibleNow: true, ineligibleReason: null }] };
    m.catalog.mockImplementation((_job: string, _unit: string | null, enabled: boolean) => ({
      state: enabled ? "ready" : "blocked", data: enabled ? { value: { availability: "available", selection: selected, unit: null } } : undefined,
      refresh: vi.fn(async () => {}),
    }));
    const active = { ...snapshot, observation: { ...snapshot.observation!, revision: 1,
      currentGeneration: ID(14), currentHeadCommandId: COMMAND },
      stream: { clientGeneration: ID(14), headSequence: 0, headCommandId: COMMAND, headAfterRevision: 1, status: "active" as const },
      state: { ...snapshot.state!, revision: 1, actions: { canEstablishStream: false, canSwitch: true, canFinishSetup: false, canStop: false } } };
    m.snapshot.mockImplementation((_id: string | null, enabled: boolean) => ({
      state: enabled ? "ready" : "blocked", data: enabled ? { value: active, requestStartedAt: performance.now(), login: { userId: OWNER, generation: 1 } } : undefined,
      refresh: vi.fn(async () => {}),
    }));
    m.head.mockResolvedValue({ ...record, receipt: { status: "applied", afterRevision: 1 } });
    m.save.mockResolvedValue({ kind: "held", reason: "expired_observation" });
    await render();
    expect(seen?.catalog.capturable).toBe(true);
    await act(async () => { await seen!.onStartActivity({ projectId: JOB, selectionId: ID(10), selectionRevision: 3,
      menuVersionId: ID(11), definitionVersionId: ID(13), scope: "general", unit: null, machineKind: null,
      values: { note: "exact" } }); });
    expect(m.save.mock.calls[0][2]).toEqual({ kind: "switch", projectId: JOB, selectionId: ID(10), selectionRevision: 3,
      menuVersionId: ID(11), definitionVersionId: ID(13), scope: "general", unit: null, machineKind: null,
      values: { note: "exact" } });
  });
  it("permits explicit setup allocation from an unassigned existing shift", async () => {
    const setup = { ...snapshot, observation: { ...snapshot.observation!, revision: 1,
      shiftRef: { kind: "shift" as const, id: ID(20) }, currentGeneration: ID(21), currentHeadCommandId: COMMAND },
      stream: { clientGeneration: ID(21), headSequence: 0, headCommandId: COMMAND, headAfterRevision: 1, status: "active" as const },
      state: { ...snapshot.state!, revision: 1, status: "setup" as const,
        actions: { canEstablishStream: false, canSwitch: false, canFinishSetup: true, canStop: false },
        shift: { id: ID(20), clockInCommandId: null, clockInAt: at, breakStartedAt: null,
          breakType: null, status: "open" as const,
          project: { visibility: "unassigned" as const, id: null, name: null, jobCode: null } } } };
    m.snapshot.mockImplementation((_id: string | null, enabled: boolean) => ({
      state: enabled ? "ready" : "blocked", data: enabled ? { value: setup, requestStartedAt: performance.now(), login: { userId: OWNER, generation: 1 } } : undefined,
      refresh: vi.fn(async () => {}),
    }));
    m.head.mockResolvedValue({ ...record, receipt: { status: "applied", afterRevision: 1 } });
    m.save.mockResolvedValue({ kind: "held", reason: "expired_observation" });
    await render({ setupAllocation: { projectId: JOB, costCodeId: ID(22) } });
    expect(button("Finish paid setup")).toBeTruthy();
    await click("Finish paid setup");
    expect(m.save.mock.calls[0][2]).toEqual({ kind: "finish_setup", projectId: JOB, costCodeId: ID(22) });
  });
  it("fails closed when a save returns an ambiguous exception", async () => {
    m.save.mockRejectedValue(Error("commit outcome unknown"));
    await render();
    await click("Reaffirm activity stream");
    expect(m.dispatch).not.toHaveBeenCalled();
    expect(seen?.catalog.capturable).toBe(false);
    expect(button("Reaffirm activity stream")).toBeUndefined();
  });
});
