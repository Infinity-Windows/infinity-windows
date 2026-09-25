// @vitest-environment happy-dom
//
// The buttons under an Ask reply (K2.4): shown only when they fit the real
// clock, the tap is the change, and the line under them is the receipt.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TimeShift } from "../../lib/timeclock";

const clock = vi.hoisted(() => ({ shift: null as TimeShift | null, refreshed: 0, opened: 0 }));
vi.mock("../../lib/clockContext", () => ({
  useClock: () => ({ shift: clock.shift, refresh: () => { clock.refreshed += 1; }, profileId: "p1", loading: false, isOpen: false, openClock: () => {}, closeClock: () => {} }),
  openClockGlobally: () => { clock.opened += 1; },
}));
vi.mock("../../lib/queryClient", async () => {
  const { QueryClient } = await import("@tanstack/react-query");
  return { queryClient: new QueryClient() };
});
vi.mock("../../lib/i18n/context", () => ({
  useLanguage: () => ({ lang: "en", t: (k: string) => k, setLang: () => {}, needsChoice: false }),
}));

import { ClockButtons } from "./ClockButtons";
import type { OneTapDeps } from "../../lib/clockOneTap";

const open = (): TimeShift => ({
  id: "00000000-0000-4000-8000-000000000501", profile_id: "p1", project_id: "j1", cost_code_id: null,
  clock_in_at: "2026-09-23T13:00:00Z", clock_out_at: null, break_seconds: 0, break_started_at: null,
  injured: null, time_confirmed: null, status: "open", created_at: "2026-09-23T13:00:00Z",
});
const calls: string[] = [];
const deps: OneTapDeps = {
  startBreak: async (_id, type) => { calls.push(`start:${type}`); },
  endBreak: async () => { calls.push("end"); },
  queueBreakStart: async () => { calls.push("queue-start"); },
  queueBreakStop: async () => { calls.push("queue-end"); },
  shouldQueue: () => false,
  resolveShiftRef: () => null,
  mintPunch: () => ({ clientId: "9b2f0c14-7d3a-4e51-8a06-3f2c9d1e4b77", tappedAt: "2026-09-23T17:00:00.000Z", clockCheckedAt: null, clockSkewMs: null }),
};

let root: Root | null = null;
let host: HTMLDivElement | null = null;
const settle = async () => { for (let i = 0; i < 4; i += 1) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
const mount = async (buttons: Parameters<typeof ClockButtons>[0]["buttons"]) => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => { root!.render(<ClockButtons buttons={buttons} deps={deps} />); });
  await settle();
};
const button = (text: string) => [...host!.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === text) ?? null;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  clock.shift = open(); clock.refreshed = 0; clock.opened = 0; calls.length = 0;
});
afterEach(() => { act(() => root?.unmount()); host?.remove(); root = null; host = null; });

describe("one-tap clock buttons", () => {
  it("offers lunch and rest when the AI heard no type, and the tap is the change, with a receipt", async () => {
    await mount([{ action: "start_break", break_type: null }]);
    expect(button("Start lunch break")).not.toBeNull();
    expect(button("Start rest break")).not.toBeNull();
    await act(async () => button("Start lunch break")!.click());
    await settle();
    expect(calls).toEqual(["start:lunch"]);
    expect(clock.refreshed).toBe(1);
    expect(host!.textContent).toContain("On break — saved in Forge.");
  });

  it("says plainly when the person is not clocked in, and offers the job clock instead", async () => {
    clock.shift = null;
    await mount([{ action: "start_break", break_type: "lunch" }]);
    expect(button("Start break")).toBeNull();
    expect(host!.textContent).toContain("You're not clocked in");
    await act(async () => button("Open job clock")!.click());
    expect(clock.opened).toBe(1);
    expect(calls).toEqual([]);
  });

  it("clock out opens the job clock rather than skipping its questions", async () => {
    await mount([{ action: "clock_out", break_type: null }]);
    await act(async () => button("Open job clock to clock out")!.click());
    await settle();
    expect(clock.opened).toBe(1);
    expect(calls).toEqual([]);
    expect(host!.textContent).toContain("The job clock is open");
  });

  it("renders nothing for no buttons", async () => {
    await mount([]);
    expect(host!.innerHTML).toBe("");
  });
});
