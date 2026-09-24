// @vitest-environment happy-dom
//
// The top-bar clock badge (K1.1): the only door to break / clock out on a
// screen that is not Work, now that the new bar has no Clock tab. Mounted for
// real: if it stops opening the clock sheet, or stops reading the shift, the
// person three screens deep has no way to their lunch.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TimeShift } from "../../lib/timeclock";

const openClock = vi.fn();
let shift: TimeShift | null = null;
vi.mock("../../lib/clockContext", () => ({
  useClock: () => ({ shift, openClock, profileId: "me", loading: false, isOpen: false, closeClock: () => {}, refresh: () => {} }),
}));

const { ClockBadge } = await import("./ClockBadge");

function mkShift(over: Partial<TimeShift> = {}): TimeShift {
  const inAt = new Date();
  inAt.setHours(7, 2, 0, 0);
  return {
    id: "s1",
    profile_id: "me",
    project_id: "p1",
    cost_code_id: "c1",
    clock_in_at: inAt.toISOString(),
    clock_out_at: null,
    break_seconds: 0,
    break_started_at: null,
    injured: null,
    time_confirmed: null,
    status: "open",
    created_at: inAt.toISOString(),
    ...over,
  } as TimeShift;
}

let root: Root | null = null;
let host: HTMLDivElement | null = null;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  openClock.mockReset();
});

function mount(): HTMLElement {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(<ClockBadge />));
  return host;
}

describe("ClockBadge", () => {
  it("renders nothing off the clock — Start day on Work is the empty state", () => {
    shift = null;
    expect(mount().querySelector(".clock-badge")).toBeNull();
  });

  it("says when the person clocked in and opens the clock sheet on tap", () => {
    shift = mkShift();
    const el = mount();
    const btn = el.querySelector<HTMLButtonElement>("button.clock-badge")!;
    expect(btn.textContent).toMatch(/Clocked in 7:02/);
    act(() => btn.click());
    expect(openClock).toHaveBeenCalledTimes(1);
  });

  it("reads On break with the break's own clock while a break runs", () => {
    shift = mkShift({ break_started_at: new Date(Date.now() - 5 * 60_000).toISOString() });
    const btn = mount().querySelector<HTMLButtonElement>("button.clock-badge")!;
    expect(btn.className).toContain("clock-badge--break");
    expect(btn.textContent).toMatch(/On break · 0:05/);
  });

  it("asks for a finish time instead of a number once the shift ran past believable", () => {
    shift = mkShift({ status: "needs_finish" });
    const btn = mount().querySelector<HTMLButtonElement>("button.clock-badge")!;
    expect(btn.textContent).toMatch(/Finish time\?/);
  });
});
