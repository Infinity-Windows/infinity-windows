// @vitest-environment happy-dom
//
// K0.4, the sheet's half: a clock-in still on the phone shows as a shift whose
// id is `pending:<outbox entry>`. That id is not a uuid, and the sheet used to
// hand it straight to start_break / end_break / clock_out — the server answered
// "invalid input syntax for type uuid", which is not a network error (so it was
// not queued) and not anything an installer can act on. CurrentWork and
// Servicing had this guard; ClockSheet did not. Now a punch on a pending shift
// never leaves for the server: it queues behind the clock-in, under the tap's
// one-time id, exactly as the offline branch always did.
//
// And the other half of K0.4: when the server says it could not find the break
// being ended, the person reads why in their language instead of "Back on the
// clock".

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spies = vi.hoisted(() => ({
  startBreak: vi.fn(async (..._a: unknown[]) => ({}) as unknown),
  endBreak: vi.fn(async (..._a: unknown[]) => ({}) as unknown),
  clockOut: vi.fn(async (..._a: unknown[]) => ({}) as unknown),
  enqueueBreakStart: vi.fn(async (..._a: unknown[]) => "q-1"),
  enqueueBreakStop: vi.fn(async (..._a: unknown[]) => "q-2"),
  enqueueClockOut: vi.fn(async (..._a: unknown[]) => "q-3"),
  pushToast: vi.fn((..._a: unknown[]) => {}),
}));
vi.mock("../../lib/timeclock", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/timeclock")>();
  return {
    ...actual,
    startBreak: spies.startBreak,
    endBreak: spies.endBreak,
    clockOut: spies.clockOut,
    listRecentJobs: vi.fn(async () => []),
  };
});
vi.mock("../../lib/offline/outbox", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/offline/outbox")>();
  return {
    ...actual,
    enqueueBreakStart: spies.enqueueBreakStart,
    enqueueBreakStop: spies.enqueueBreakStop,
    enqueueClockOut: spies.enqueueClockOut,
  };
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
vi.mock("../../lib/costCodes", () => ({ getClockCostCodesForProject: vi.fn(async () => []) }));
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
import { ClockRefusal, type TimeShift } from "../../lib/timeclock";

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
  spies.startBreak.mockResolvedValue({});
  spies.endBreak.mockResolvedValue({});
  spies.clockOut.mockResolvedValue({});
});

function shift(id: string, over: Partial<TimeShift> = {}): TimeShift {
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
    ...over,
  };
}

function mount(s: TimeShift): HTMLElement {
  const qc = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Infinity, refetchOnMount: false, gcTime: Infinity },
    },
  });
  qc.setQueryData(["projects"], [{ id: "p1", job_code: "BLACK22", name: "Black Desert", address: null, status: "active", allowed_modes: ["data"] }]);
  for (const scope of ["all", "p1"]) qc.setQueryData(["clockCostCodes", scope], []);
  qc.setQueryData(["recentJobs", "me"], []);
  qc.setQueryData(["myActivePhases", "me"], []);
  qc.setQueryData(["toolboxToday", "me"], { id: "done1" });
  qc.setQueryData(["todayTalk"], null);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root!.render(
      <QueryClientProvider client={qc}>
        <MemoryRouter>
          <ClockSheet profileId="me" shift={s} onClose={() => {}} onChanged={() => {}} />
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

const PENDING = "pending:entry-1";

describe("a punch on a clock-in that is still on the phone", () => {
  it("queues the break end under the tap's id and never calls end_break", async () => {
    const el = mount(shift(PENDING, { break_started_at: new Date(Date.now() - 600_000).toISOString(), break_type: "lunch" }));
    await flush();
    await click(el, ".clock-btn.resume");
    expect(spies.endBreak).not.toHaveBeenCalled();
    expect(spies.enqueueBreakStop).toHaveBeenCalledTimes(1);
    expect(spies.enqueueBreakStop.mock.calls[0][0]).toBe(PENDING);
    expect(spies.enqueueBreakStop.mock.calls[0][1]).toEqual(
      expect.objectContaining({ clientId: expect.any(String), tappedAt: expect.any(String) }),
    );
    // Told it is saved and will follow the clock-in, not told it failed.
    expect(spies.pushToast.mock.calls.map((c) => c[0])).toContain("Back on the clock — will sync when online");
  });

  it("queues the break start under the tap's id and never calls start_break", async () => {
    const el = mount(shift(PENDING));
    await flush();
    await click(el, ".clock-btn.break");
    await click(el, ".clock-break-option");
    expect(spies.startBreak).not.toHaveBeenCalled();
    expect(spies.enqueueBreakStart).toHaveBeenCalledTimes(1);
    expect(spies.enqueueBreakStart.mock.calls[0][0]).toBe(PENDING);
    expect(spies.enqueueBreakStart.mock.calls[0][1]).toBe("lunch");
    expect(spies.enqueueBreakStart.mock.calls[0][2]).toEqual(expect.objectContaining({ clientId: expect.any(String) }));
  });

  it("queues the clock-out under the tap's id and never calls clock_out", async () => {
    const el = mount(shift(PENDING));
    await flush();
    await click(el, ".clock-btn.out");
    expect(spies.clockOut).not.toHaveBeenCalled();
    expect(spies.enqueueClockOut).toHaveBeenCalledTimes(1);
    expect(spies.enqueueClockOut.mock.calls[0][0]).toEqual(
      expect.objectContaining({ shiftRef: PENDING, punch: expect.objectContaining({ clientId: expect.any(String) }) }),
    );
  });
});

describe("a punch on a real shift", () => {
  const REAL = "11111111-2222-4333-8444-555555555555";

  it("goes to the server with the tap's id, and the same id queues if the network drops", async () => {
    spies.endBreak.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    const el = mount(shift(REAL, { break_started_at: new Date(Date.now() - 600_000).toISOString(), break_type: "rest" }));
    await flush();
    await click(el, ".clock-btn.resume");
    expect(spies.endBreak).toHaveBeenCalledTimes(1);
    expect(spies.endBreak.mock.calls[0][0]).toBe(REAL);
    const live = spies.endBreak.mock.calls[0][1] as { clientId: string };
    expect(spies.enqueueBreakStop).toHaveBeenCalledTimes(1);
    expect(spies.enqueueBreakStop.mock.calls[0][1]).toEqual(expect.objectContaining({ clientId: live.clientId }));
  });

  it("shows the server's refusal of a break end in the person's words, and queues nothing", async () => {
    spies.endBreak.mockRejectedValueOnce(new ClockRefusal("no_break_running"));
    const el = mount(shift(REAL, { break_started_at: new Date(Date.now() - 600_000).toISOString(), break_type: "lunch" }));
    await flush();
    await click(el, ".clock-btn.resume");
    expect(spies.enqueueBreakStop).not.toHaveBeenCalled();
    const errors = spies.pushToast.mock.calls.filter((c) => c[1] === "error").map((c) => c[0]);
    expect(errors).toEqual([
      "We couldn't find the start of that break, so it wasn't ended. Your foreman will check your breaks.",
    ]);
    expect(spies.pushToast.mock.calls.map((c) => c[0])).not.toContain("Back on the clock");
  });
});
