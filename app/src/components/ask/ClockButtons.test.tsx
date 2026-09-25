// @vitest-environment happy-dom
//
// The buttons under an Ask reply (K2.4): shown only when they fit the real
// clock, the tap is the change, and the line under them is the receipt.
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { IsRestoringProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TimeShift } from "../../lib/timeclock";

const clock = vi.hoisted(() => ({
  shift: null as TimeShift | null,
  loading: false,
  profileId: "p1" as string | null,
  refreshed: 0,
  opened: 0,
}));
vi.mock("../../lib/clockContext", () => ({
  useClock: () => ({ shift: clock.shift, refresh: () => { clock.refreshed += 1; }, profileId: clock.profileId, loading: clock.loading, isOpen: false, openClock: () => {}, closeClock: () => {} }),
  openClockGlobally: () => { clock.opened += 1; },
}));
vi.mock("../../lib/queryClient", async () => {
  const { QueryClient } = await import("@tanstack/react-query");
  return { queryClient: new QueryClient() };
});
const lang = vi.hoisted(() => ({ current: "en" as "en" | "es" }));
vi.mock("../../lib/i18n/context", () => ({
  useLanguage: () => ({ lang: lang.current, t: (k: string) => k, setLang: () => {}, needsChoice: false }),
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
type Buttons = Parameters<typeof ClockButtons>[0]["buttons"];
const view = (buttons: Buttons, restoring: boolean): ReactNode => (
  <IsRestoringProvider value={restoring}><ClockButtons buttons={buttons} deps={deps} /></IsRestoringProvider>
);
const mount = async (buttons: Buttons, restoring = false) => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => { root!.render(view(buttons, restoring)); });
  await settle();
};
/** The clock provider re-rendering the reply once it knows more. */
const rerender = async (buttons: Buttons, restoring = false) => {
  await act(async () => { root!.render(view(buttons, restoring)); });
  await settle();
};
const button = (text: string) => [...host!.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === text) ?? null;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  clock.shift = open(); clock.loading = false; clock.profileId = "p1"; clock.refreshed = 0; clock.opened = 0; calls.length = 0;
  lang.current = "en";
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

// A reply restored when Ask opens lands while the clock is still being read:
// `shift` is null because nothing has been read yet, not because the person
// is off the clock. The card must not say either until it knows.
describe("one-tap clock buttons while the clock is still being read", () => {
  const lunch: Buttons = [{ action: "start_break", break_type: "lunch" }];
  const checking = () => host!.querySelector('[role="status"]')?.textContent ?? "";

  it("says it is checking, offers no button, and then shows the buttons for a person on the clock", async () => {
    clock.loading = true;
    clock.shift = null;
    await mount(lunch);
    expect(checking()).toBe("Checking your clock…");
    expect(host!.querySelector("section")?.getAttribute("aria-busy")).toBe("true");
    expect(host!.querySelectorAll("button")).toHaveLength(0);
    expect(host!.textContent).not.toContain("You're not clocked in");

    // The clock is read: this person is on it.
    clock.loading = false;
    clock.shift = open();
    await rerender(lunch);
    expect(host!.textContent).not.toContain("Checking your clock");
    expect(button("Start break")).not.toBeNull();
    await act(async () => button("Start break")!.click());
    await settle();
    expect(calls).toEqual(["start:lunch"]);
  });

  it("says it is checking, then — once it knows — that the person is not clocked in", async () => {
    clock.loading = true;
    clock.shift = null;
    await mount(lunch);
    expect(checking()).toBe("Checking your clock…");
    expect(host!.textContent).not.toContain("You're not clocked in");

    clock.loading = false;
    await rerender(lunch);
    expect(host!.textContent).not.toContain("Checking your clock");
    expect(host!.textContent).toContain("You're not clocked in");
    expect(button("Open job clock")).not.toBeNull();
    expect(calls).toEqual([]);
  });

  it("keeps checking while the saved copy of the app's data is still being restored", async () => {
    // react-query reports a restoring query as idle, so `loading` reads false
    // here while `shift` is still the empty default.
    clock.shift = null;
    await mount(lunch, true);
    expect(checking()).toBe("Checking your clock…");
    expect(host!.textContent).not.toContain("You're not clocked in");
    await rerender(lunch, false);
    expect(host!.textContent).toContain("You're not clocked in");
  });

  it("keeps checking until it knows who is signed in", async () => {
    // With no profile yet the clock query has not even started, so it does
    // not report loading either.
    clock.profileId = null;
    clock.shift = null;
    await mount(lunch);
    expect(checking()).toBe("Checking your clock…");
    expect(host!.querySelectorAll("button")).toHaveLength(0);
  });

  it("says it in Spanish for a Spanish reader", async () => {
    lang.current = "es";
    clock.loading = true;
    clock.shift = null;
    await mount(lunch);
    expect(checking()).toBe("Revisando tu reloj…");
  });
});
