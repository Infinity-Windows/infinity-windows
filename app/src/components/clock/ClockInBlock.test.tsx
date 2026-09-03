// @vitest-environment happy-dom
//
// The one big clock-in spot, mounted for real and read from the DOM. A unit
// test of the strings would stay green with the block wired to nothing; this
// seeds only what the server would return and reads the rendered page, so it
// fails if the block stops offering a clock-in, stops showing the live bar on
// the clock, stops requiring a cost code, drops the note, or stops honouring
// today's toolbox talk.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

// Keep the read helpers real (formatClock/elapsedWorkSeconds/isOnTheClock) but
// hold the network still: the writes and reads all become resolved spies, so a
// cache invalidation after a punch never reaches for a server behind the test.
// vi.mock is hoisted above the file, so the spy is defined via vi.hoisted.
const { clockInSpy } = vi.hoisted(() => ({
  clockInSpy: vi.fn(async () => ({}) as unknown),
}));
vi.mock("../../lib/timeclock", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/timeclock")>();
  return {
    ...actual,
    clockIn: clockInSpy,
    getOpenShift: vi.fn(async () => null),
    listCostCodes: vi.fn(async () => []),
    listRecentJobs: vi.fn(async () => []),
    getJobLastGeo: vi.fn(async () => null),
  };
});

import { ClockInBlock } from "./ClockInBlock";
import type { TimeShift } from "../../lib/timeclock";

let root: Root | null = null;
let host: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  clockInSpy.mockClear();
});

interface Seed {
  shift?: TimeShift | null;
  costCodes?: unknown[];
  recents?: unknown[];
  projects?: unknown[];
  talk?: unknown;
  toolboxDone?: unknown;
}

function mount(seed: Seed = {}): HTMLElement {
  const qc = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        gcTime: Infinity,
        staleTime: Infinity,
        refetchOnMount: false,
        refetchOnWindowFocus: false,
        refetchOnReconnect: false,
      },
    },
  });
  qc.setQueryData(["myProfile"], { id: "me", role: "installer" });
  qc.setQueryData(["openShift", "me"], seed.shift ?? null);
  qc.setQueryData(["costCodes"], seed.costCodes ?? []);
  qc.setQueryData(["recentJobs", "me"], seed.recents ?? []);
  qc.setQueryData(["projects"], seed.projects ?? []);
  qc.setQueryData(["todayTalk"], seed.talk ?? null);
  qc.setQueryData(["toolboxToday", "me"], seed.toolboxDone ?? null);

  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root!.render(
      <QueryClientProvider client={qc}>
        <ClockInBlock />
      </QueryClientProvider>,
    );
  });
  return host;
}

const CC = { id: "cc1", code: "100", label: "Install", active: true };
function recent(costCodeId: string | null) {
  return {
    projectId: "p1",
    jobCode: "BLACK22",
    name: "Black Desert",
    costCodeId,
    lastClockInAt: new Date().toISOString(),
  };
}

function openShift(hoursAgo: number): TimeShift {
  return {
    id: "s1",
    profile_id: "me",
    project_id: "p1",
    cost_code_id: "cc1",
    clock_in_at: new Date(Date.now() - hoursAgo * 3600_000).toISOString(),
    clock_out_at: null,
    break_seconds: 0,
    break_started_at: null,
    break_type: null,
    injured: null,
    time_confirmed: null,
    status: "open",
    created_at: new Date().toISOString(),
    note: null,
    projects: { job_code: "BLACK22", name: "Black Desert" },
    cost_codes: { code: "100", label: "Install" },
  };
}

describe("the clock-in block", () => {
  it("shows the big off-the-clock card with the pick flow", () => {
    const el = mount({ costCodes: [CC], recents: [recent(null)], projects: [] });
    expect(el.querySelector(".clockin-block")).toBeTruthy();
    expect(el.querySelector(".clockin-bar")).toBeNull();
    expect(el.textContent).toContain("Clock in");
    expect(el.textContent).toContain("Cost code");
  });

  it("collapses to a slim bar with a running timer on the clock", () => {
    const el = mount({ shift: openShift(1) });
    expect(el.querySelector(".clockin-block")).toBeNull();
    const bar = el.querySelector(".clockin-bar");
    expect(bar).toBeTruthy();
    const timer = el.querySelector(".clockin-bar-timer");
    expect(timer?.textContent).toMatch(/^\d+:\d\d:\d\d$/);
    expect(el.textContent).toContain("BLACK22");
    expect(el.textContent).toContain("Clock out");
  });

  it("requires a cost code before the button will start", () => {
    // A recent job with no last cost code primes the job but not the code.
    const el = mount({ costCodes: [CC], recents: [recent(null)] });
    const start = el.querySelector<HTMLButtonElement>(".clock-btn.primary.big");
    expect(start).toBeTruthy();
    expect(start!.disabled).toBe(true);

    const code = el.querySelector<HTMLButtonElement>(".clock-costcode-item");
    act(() => code!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(
      el.querySelector<HTMLButtonElement>(".clock-btn.primary.big")!.disabled,
    ).toBe(false);
  });

  it("carries the typed note through to the clock-in", async () => {
    const el = mount({ costCodes: [CC], recents: [recent("cc1")] });
    const start = el.querySelector<HTMLButtonElement>(".clock-btn.primary.big");
    expect(start!.disabled).toBe(false); // job + code both primed

    const textarea = el.querySelector<HTMLTextAreaElement>("#clockin-block-note")!;
    const nativeSet = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype,
      "value",
    )!.set!;
    act(() => {
      nativeSet.call(textarea, "left the gate open");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });

    await act(async () => {
      start!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(clockInSpy).toHaveBeenCalledTimes(1);
    // The 5th arg is the job mode (slice 2). This recent job isn't in the
    // projects list, so its mode is unknown → null (unchanged, mode-less punch).
    expect(clockInSpy.mock.calls[0]).toEqual([
      "p1",
      "cc1",
      expect.anything(),
      "left the gate open",
      null,
    ]);
  });

  it("won't clock in until today's toolbox talk is signed", () => {
    // A talk exists today and isn't signed: the button becomes "sign first",
    // and the plain clock-in is not offered.
    const el = mount({
      costCodes: [CC],
      recents: [recent("cc1")],
      talk: { id: "t1", title: "Ladders" },
      toolboxDone: null,
    });
    expect(el.textContent).toContain("Sign safety talk & clock in");
    expect(el.textContent).toContain("Sign today's safety talk to clock in.");
    expect(el.textContent).not.toContain("Start clock");
    expect(clockInSpy).not.toHaveBeenCalled();
  });

  it("offers the plain clock-in once the talk is signed", () => {
    const el = mount({
      costCodes: [CC],
      recents: [recent("cc1")],
      talk: { id: "t1", title: "Ladders" },
      toolboxDone: { id: "done1" },
    });
    expect(el.textContent).toContain("Start clock");
    expect(el.textContent).not.toContain("Sign safety talk & clock in");
  });

  // ---- Mode step (standard-tracking-jobs slice 2) --------------------------
  const proj = (allowed_modes: string[]) => ({
    id: "p1",
    job_code: "BLACK22",
    name: "Black Desert",
    address: null,
    status: "active",
    allowed_modes,
  });

  async function clickAndFlush(btn: HTMLButtonElement) {
    await act(async () => {
      btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  it("asks Install vs Tracking only when the job allows both", () => {
    const el = mount({
      costCodes: [CC],
      recents: [recent("cc1")],
      projects: [proj(["data", "tracking"])],
    });
    expect(el.textContent).toContain("What are you here to do?");
    expect(el.textContent).toContain("Install work");
    expect(el.textContent).toContain("Tracking only");
  });

  it("stays silent about mode when the job allows only one", () => {
    const el = mount({
      costCodes: [CC],
      recents: [recent("cc1")],
      projects: [proj(["data"])],
    });
    expect(el.textContent).not.toContain("What are you here to do?");
  });

  it("records the picked mode when the job allows both", async () => {
    const el = mount({
      costCodes: [CC],
      recents: [recent("cc1")],
      projects: [proj(["data", "tracking"])],
    });
    // Switch from the default (install work) to tracking only — the mode
    // buttons are the ones carrying aria-pressed.
    const modeBtns = Array.from(
      el.querySelectorAll<HTMLButtonElement>("[aria-pressed]"),
    );
    const tracking = modeBtns.find((b) => b.textContent?.includes("Tracking only"))!;
    act(() => tracking.dispatchEvent(new MouseEvent("click", { bubbles: true })));

    const start = el.querySelector<HTMLButtonElement>(".clock-btn.primary.big")!;
    await clickAndFlush(start);

    expect(clockInSpy).toHaveBeenCalledTimes(1);
    expect(clockInSpy.mock.calls[0]).toEqual([
      "p1",
      "cc1",
      expect.anything(),
      null,
      "tracking",
    ]);
  });

  it("records the one mode silently on a single-mode job", async () => {
    const el = mount({
      costCodes: [CC],
      recents: [recent("cc1")],
      projects: [proj(["tracking"])],
    });
    const start = el.querySelector<HTMLButtonElement>(".clock-btn.primary.big")!;
    await clickAndFlush(start);

    expect(clockInSpy).toHaveBeenCalledTimes(1);
    expect(clockInSpy.mock.calls[0]).toEqual([
      "p1",
      "cc1",
      expect.anything(),
      null,
      "tracking",
    ]);
  });
});
