// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Project } from "../../lib/types";
import type { CostCode } from "../../lib/timeclock";
const projects: Project[] = [
  { id: "b", job_code: "BLACK22", name: "Black Desert", address: null, status: "active" },
  { id: "c", job_code: "PECAN14", name: "Pecan", address: null, status: "active" },
];
const codes: CostCode[] = [{ id: "general", code: "000", label: "General", active: true, is_general: true }];
const start = vi.fn();
vi.mock("../../lib/api", () => ({ listProjects: async () => projects }));
vi.mock("../../lib/costCodes", () => ({ getClockCostCodesForProject: async () => codes }));
vi.mock("../../lib/i18n", () => ({ useT: () => (key: string) => key }));
vi.mock("../../lib/timeclock", () => ({
  listRecentJobs: async () => [], isOnTheClock: () => false,
  elapsedWorkSeconds: () => 0, formatClock: () => "", mintPunch: () => { throw new Error("Unexpected punch in picker-only test"); },
}));
vi.mock("../../lib/work/startShift", () => ({ startShiftOrQueue: (...args: unknown[]) => start(...args) }));
vi.mock("../clock/ToolboxSignCard", () => ({ ToolboxSignCard: () => null }));
vi.mock("../clock/ToolboxSignStatus", () => ({ ToolboxSignStatus: () => null }));
vi.mock("../voice/VoiceControl", () => ({ VoiceControl: () => null }));
import { ClockStrip, type ClockStripProps } from "./ClockStrip";
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root;
let host: HTMLDivElement;
let client: QueryClient;
let props: ClockStripProps;
const choice = vi.fn();
function render() { act(() => root.render(<QueryClientProvider client={client}><ClockStrip {...props} /></QueryClientProvider>)); }
function button(text: string) {
  const found = Array.from(host.querySelectorAll("button")).find((b) => b.textContent === text);
  if (!found) throw new Error(`Missing button ${text}`);
  return found;
}
function pick(id: string) {
  const row = Array.from(host.querySelectorAll<HTMLButtonElement>(".ws-list-item")).find((b) => b.textContent?.includes(id));
  if (!row) throw new Error(`Missing project ${id}`);
  act(() => row.click());
}
beforeEach(() => {
  start.mockClear(); choice.mockClear();
  client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } } });
  client.setQueryData(["projects"], projects); client.setQueryData(["recentJobs", "me"], []);
  for (const id of ["all", "b", "c"]) client.setQueryData(["clockCostCodes", id], codes);
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  props = {
    profileId: "me", shift: null, clockKnown: true, todayJobId: "b", scheduleSettled: true,
    talk: null, gate: { talkExists: false, signedToday: true, ruleActive: false },
    toolboxDone: { data: null, isSuccess: true, pending: false, refused: false },
    onShiftChanged: vi.fn(), scheduleIntent: { kind: "selected", projectId: "b" }, onExplicitProjectChoice: choice,
  }; render();
});
afterEach(() => { act(() => root.unmount()); client.clear(); host.remove(); });
describe("real ClockStrip and JobPickSheet project-choice boundary", () => {
  it("explicit re-selection of the displayed project answers choose without starting a shift", () => {
    expect(host.querySelector(".ws-clock-pick-job")?.textContent).toContain("BLACK22");
    props = { ...props, scheduleIntent: { kind: "choose" }, todayJobId: null }; render();
    expect(host.querySelector(".ws-clock-pick-job")?.textContent).not.toContain("BLACK22");
    act(() => host.querySelector<HTMLButtonElement>('[data-testid="ws-start-day"]')!.click()); pick("BLACK22");
    expect(choice).toHaveBeenCalledExactlyOnceWith("b"); expect(start).not.toHaveBeenCalled();
  });
  it("a second explicit choice is reported after the intent block has ended", () => {
    act(() => button("work.clock.change").click()); pick("PECAN14");
    expect(choice).toHaveBeenCalledExactlyOnceWith("c");
    // Manual phase removes the clock block but still owns Work's job context.
    props = { ...props, scheduleIntent: null, todayJobId: "c" }; render(); pick("BLACK22");
    expect(choice.mock.calls).toEqual([["c"], ["b"]]);
    expect(host.querySelector(".ws-clock-pick-job")?.textContent).toContain("BLACK22");
    expect(start).not.toHaveBeenCalled();
  });
});
