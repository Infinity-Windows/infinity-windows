// @vitest-environment happy-dom
//
// K0.1: a switch made on a shift that is itself still on the phone. A switch
// is a clock-in, and a clock-in that reaches the server AHEAD of the queued
// one becomes the open shift that queued clock-in then has to close — paid
// from arrival, not from the tap. So on a pending shift the sheet never
// sends the switch directly: it queues it behind the pending clock-in, the
// way a queued clock-out waits for its clock-in.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, useLocation } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spies = vi.hoisted(() => ({
  clockIn: vi.fn(async (..._a: unknown[]) => ({}) as unknown),
  enqueueClockIn: vi.fn(async (..._a: unknown[]) => "q-1"),
  pushToast: vi.fn((..._a: unknown[]) => {}),
}));
vi.mock("../../lib/timeclock", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/timeclock")>();
  return { ...actual, clockIn: spies.clockIn, listRecentJobs: vi.fn(async () => []) };
});
vi.mock("../../lib/offline/outbox", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/offline/outbox")>();
  return { ...actual, enqueueClockIn: spies.enqueueClockIn };
});
vi.mock("../../lib/toast", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/toast")>();
  return {
    ...actual,
    pushToast: spies.pushToast,
    toastSuccess: (m: string) => spies.pushToast(m, "success"),
    toastError: (e: unknown) => spies.pushToast(String((e as Error)?.message ?? e), "error"),
  };
});
const CODES = [
  { id: "cc1", code: "100", label: "Install", active: true },
  { id: "cc2", code: "200", label: "Travel", active: true },
];
vi.mock("../../lib/costCodes", () => ({ getClockCostCodesForProject: vi.fn(async () => CODES) }));
vi.mock("../../lib/geo", () => ({ captureGeoSoft: vi.fn(async () => ({})) }));
vi.mock("../../lib/dailyLogNudge", () => ({ announceClockedOut: () => {} }));
vi.mock("../../lib/install/sessions", () => ({ getMyOpenSession: vi.fn(async () => null) }));
vi.mock("../../lib/install/phases", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/install/phases")>();
  return { ...actual, listMyActivePhases: vi.fn(async () => []) };
});
vi.mock("../time/ToolboxTalkNagBanner", () => ({ ToolboxTalkNagBanner: () => null }));
vi.mock("../../lib/clockSkew", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/clockSkew")>();
  return { ...actual, fetchServerNowMs: vi.fn(async () => Date.now()) };
});

import { ClockSheet } from "./ClockSheet";
import { localDateOf } from "../../lib/toolboxSign";
import type { ClockInPick, TimeShift } from "../../lib/timeclock";

let root: Root | null = null;
let host: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});
beforeEach(() => {
  for (const s of Object.values(spies)) s.mockClear();
  spies.clockIn.mockResolvedValue({});
});

function shift(id: string): TimeShift {
  const now = new Date().toISOString();
  return {
    id,
    profile_id: "me",
    project_id: "p1",
    cost_code_id: "cc1",
    clock_in_at: now,
    clock_out_at: null,
    break_seconds: 0,
    break_started_at: null,
    break_type: null,
    injured: null,
    time_confirmed: null,
    status: "open",
    created_at: now,
    projects: { job_code: "BLACK22", name: "Black Desert" },
    cost_codes: { code: "100", label: "Install" },
  };
}

function RouteProbe() {
  const location = useLocation();
  return <span data-testid="clock-route">{location.pathname}</span>;
}

function mount(s: TimeShift, initialPick?: ClockInPick): HTMLElement {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity, refetchOnMount: false, gcTime: Infinity } },
  });
  qc.setQueryData(["projects"], [
    { id: "p1", job_code: "BLACK22", name: "Black Desert", address: null, status: "active", allowed_modes: ["data"] },
    { id: "p2", job_code: "OAK-2", name: "Oakridge", address: null, status: "active", allowed_modes: ["data"] },
  ]);
  for (const scope of ["all", "p1", "p2"]) qc.setQueryData(["clockCostCodes", scope], CODES);
  qc.setQueryData(["recentJobs", "me"], []);
  qc.setQueryData(["myActivePhases", "me"], []);
  qc.setQueryData(["toolboxToday", "me"], { id: "done1" });
  qc.setQueryData(["todayTalk", localDateOf(new Date())], null);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root!.render(
      <QueryClientProvider client={qc}>
        <MemoryRouter>
          <ClockSheet
            profileId="me"
            shift={s}
            initialPick={initialPick}
            pending={{ kind: "clock_in", entryId: "entry-1", tappedAt: s.clock_in_at, sending: false }}
            onClose={() => {}}
            onChanged={() => {}}
          />
          <RouteProbe />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  return host;
}

async function flush() {
  for (let i = 0; i < 4; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

async function click(el: HTMLElement, selector: string) {
  const button = el.querySelector<HTMLButtonElement>(selector);
  if (!button) throw new Error(`no ${selector} on the sheet: ${el.textContent}`);
  await act(async () => {
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await flush();
}

describe("a switch on a clock-in that is still on the phone", () => {
  it("Ask preselects the requested job, queues only after confirmation, then returns to the waiting reply", async () => {
    const pick: ClockInPick = { projectId: "p2", costCodeId: null, note: null, mode: null, returnToAsk: true };
    const el = mount(shift("pending:entry-1"), pick);
    await flush();
    expect(el.querySelector(".clock-pick-summary")?.textContent).toContain("Oakridge");
    expect(spies.enqueueClockIn).not.toHaveBeenCalled();
    const install = [...el.querySelectorAll<HTMLButtonElement>(".clock-costcode-item")].find((b) => b.textContent?.includes("100"));
    expect(install).toBeTruthy();
    await act(async () => install!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await flush();
    await click(el, ".clock-btn.primary.big");
    expect(spies.clockIn).not.toHaveBeenCalled();
    expect(spies.enqueueClockIn).toHaveBeenCalledWith(expect.objectContaining({ projectId: "p2", afterShiftRef: "pending:entry-1" }));
    expect(el.querySelector('[data-testid="clock-route"]')?.textContent).toBe("/ask");
  });
  it("draws the queued line under the hero", async () => {
    const el = mount(shift("pending:entry-1"));
    await flush();
    const line = el.querySelector(".clock-queue-line");
    expect(line?.getAttribute("data-kind")).toBe("clock_in");
    expect(line?.textContent).toContain("saved on this phone");
  });

  it("queues a cost-code switch behind the pending clock-in and never sends it directly", async () => {
    const el = mount(shift("pending:entry-1"));
    await flush();
    // The Travel chip is the one that is not current.
    const travel = [...el.querySelectorAll<HTMLButtonElement>(".clock-chip.cost")].find((b) => b.textContent?.includes("200"));
    expect(travel).toBeTruthy();
    await act(async () => {
      travel!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();
    expect(spies.clockIn).not.toHaveBeenCalled();
    expect(spies.enqueueClockIn).toHaveBeenCalledTimes(1);
    expect(spies.enqueueClockIn.mock.calls[0][0]).toEqual(
      expect.objectContaining({ projectId: "p1", costCodeId: "cc2", afterShiftRef: "pending:entry-1" }),
    );
  });

  it("queues a job switch the same way", async () => {
    const el = mount(shift("pending:entry-1"));
    await flush();
    await click(el, ".clock-job-chip");
    await click(el, ".clock-btn.primary.big");
    expect(spies.clockIn).not.toHaveBeenCalled();
    expect(spies.enqueueClockIn).toHaveBeenCalledTimes(1);
    expect(spies.enqueueClockIn.mock.calls[0][0]).toEqual(expect.objectContaining({ afterShiftRef: "pending:entry-1" }));
  });

  it("sends a switch on a REAL shift straight to the server, as before", async () => {
    const el = mount(shift("11111111-2222-4333-8444-555555555555"));
    await flush();
    const travel = [...el.querySelectorAll<HTMLButtonElement>(".clock-chip.cost")].find((b) => b.textContent?.includes("200"));
    await act(async () => {
      travel!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();
    expect(spies.clockIn).toHaveBeenCalledTimes(1);
    expect(spies.enqueueClockIn).not.toHaveBeenCalled();
  });
});
