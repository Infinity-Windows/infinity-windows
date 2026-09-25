// @vitest-environment happy-dom
//
// ONE PUNCH PER TAP, STAMPED AT THE TAP (Release 0, K0.2/K0.5) — the classic
// clock-in's half of the rule Start day follows since Codex's review of #642.
//
// A clock punch waits for a location fix before it is sent, and captureGeoSoft
// can take 12.5 seconds on a weak fix. The landing block and the clock sheet
// used to mint the punch — its one-time id and its tap time — AFTER that wait,
// so the server was told the person tapped up to 12.5 seconds after they did,
// and pay uses the tap time whenever it trusts the phone. These tests tap at a
// fixed moment, make the location wait take seconds on fake timers, and read
// what reached the "server".
//
// The server is a fake behind supabase.rpc that does what the real clock_in
// does with a one-time id (20261028000000, proven on the real SQL by
// scripts/verify-clock-integrity.mjs): the first call with an id makes a
// shift, and a repeat of that id answers with the shift it already made. It
// can also lose a reply AFTER saving — the case a retry exists for. Nothing
// between the tap and the RPC is mocked: the real clockIn, the real location
// wait, the real offline queue and its real sender.

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { CC, CC2, RECENT } = vi.hoisted(() => ({
  CC: { id: "cc1", code: "100", label: "Install", active: true },
  CC2: { id: "cc2", code: "200", label: "Service call", active: true },
  RECENT: { projectId: "p1", jobCode: "BLACK22", name: "Black Desert", costCodeId: "cc1", lastClockInAt: "2026-09-23T13:00:00.000Z" },
}));

// Reads that a punch's cache refresh would re-run are held still, so nothing
// reaches past the fake server. clockIn and clockOut stay real.
vi.mock("../../lib/timeclock", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/timeclock")>();
  return {
    ...actual,
    getOpenShift: vi.fn(async () => null),
    listRecentJobs: vi.fn(async () => [RECENT]),
    getJobLastGeo: vi.fn(async () => null),
  };
});
vi.mock("../../lib/costCodes", () => ({
  getClockCostCodesForProject: vi.fn(async () => [CC, CC2]),
}));
vi.mock("../../lib/install/phases", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/install/phases")>();
  return { ...actual, listMyActivePhases: vi.fn(async () => []) };
});
vi.mock("../../lib/install/sessions", () => ({ getMyOpenSession: vi.fn(async () => null) }));
vi.mock("../../lib/dailyLogNudge", () => ({ announceClockedOut: () => {} }));
vi.mock("../time/ToolboxTalkNagBanner", () => ({ ToolboxTalkNagBanner: () => null }));

import { supabase } from "../../lib/supabase";
import type { ClockInPick, TimeShift } from "../../lib/timeclock";
import { ClockInBlock } from "./ClockInBlock";
import { ClockSheet } from "./ClockSheet";

const P1 = { id: "p1", job_code: "BLACK22", name: "Black Desert", address: null, status: "active", allowed_modes: ["data"] };

/** 7:00 in the morning, Denver: the moment of the tap. */
const T0 = Date.parse("2026-09-24T13:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();
/** The fix the phone finally gets. */
const FIX = { latitude: 40.76, longitude: -111.89, accuracy: 12 };

// ---- the fake server --------------------------------------------------------

type Args = Record<string, unknown>;
const server = {
  shifts: new Map<string, TimeShift>(),
  calls: [] as { fn: string; args: Args }[],
  /** Save the next punch, then lose its reply on the way back. */
  loseNextReply: false,
};
const LOST = { data: null, error: { message: "TypeError: Failed to fetch", details: "", hint: "", code: "" } };

function fakeRpc(fn: string, args: Args = {}) {
  server.calls.push({ fn, args });
  if (fn === "server_now") return { data: iso(Date.now()), error: null };
  if (fn === "clock_in") {
    const id = String(args.p_client_id);
    const again = server.shifts.get(id);
    if (again) return { data: again, error: null };
    const at = (args.p_tapped_at as string | null) ?? iso(Date.now());
    const made: TimeShift = {
      id: `shift-${server.shifts.size + 1}`,
      profile_id: "me",
      project_id: (args.p_project_id as string | null) ?? null,
      cost_code_id: (args.p_cost_code_id as string | null) ?? null,
      clock_in_at: at,
      clock_out_at: null,
      break_seconds: 0,
      break_started_at: null,
      break_type: null,
      injured: null,
      time_confirmed: null,
      status: "open",
      created_at: at,
      note: (args.p_note as string | null) ?? null,
    };
    server.shifts.set(id, made);
    if (server.loseNextReply) {
      server.loseNextReply = false;
      return LOST;
    }
    return { data: made, error: null };
  }
  if (fn === "clock_out") return { data: { id: args.p_shift_id, status: "submitted" }, error: null };
  return { data: null, error: null };
}

const clockInCalls = () => server.calls.filter((c) => c.fn === "clock_in").map((c) => c.args);

// ---- a phone whose location fix is slow --------------------------------------

/** How long this phone takes to find itself; null = it never answers. */
let fixAfterMs: number | null = null;
const geolocation = {
  getCurrentPosition(ok: (p: { coords: typeof FIX }) => void) {
    if (fixAfterMs === null) return; // captureGeoSoft's 12.5 s backstop decides
    setTimeout(() => ok({ coords: FIX }), fixAfterMs);
  },
};

// ---- mounting -----------------------------------------------------------------

const roots: Root[] = [];
const hosts: HTMLElement[] = [];

function todayLocal(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function client(): QueryClient {
  const qc = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Infinity, staleTime: Infinity, refetchOnMount: false, refetchOnWindowFocus: false },
    },
  });
  qc.setQueryData(["myProfile"], { id: "me", role: "installer", display_name: "Dana" });
  qc.setQueryData(["openShift", "me"], null);
  qc.setQueryData(["projects"], [P1]);
  for (const scope of ["all", "p1"]) qc.setQueryData(["clockCostCodes", scope], [CC, CC2]);
  qc.setQueryData(["recentJobs", "me"], [RECENT]);
  qc.setQueryData(["mySchedule", "me", todayLocal(), todayLocal()], []);
  qc.setQueryData(["myOpenings", "me"], []);
  qc.setQueryData(["myActivePhases", "me"], []);
  // Today's talk is signed: the plain Start is the whole tap.
  qc.setQueryData(["todayTalk"], null);
  qc.setQueryData(["toolboxToday", "me"], { id: "done1" });
  return qc;
}

function render(ui: ReactNode): HTMLElement {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(<QueryClientProvider client={client()}><MemoryRouter>{ui}</MemoryRouter></QueryClientProvider>));
  roots.push(root);
  hosts.push(host);
  return host;
}

function mountSheet(opts: { shift?: TimeShift | null; initialPick?: ClockInPick | null } = {}): HTMLElement {
  return render(
    <ClockSheet profileId="me" shift={opts.shift ?? null} initialPick={opts.initialPick ?? null} onClose={() => {}} onChanged={() => {}} />,
  );
}

/** Let time pass on the fake clock, flushing React and the queue as it goes. */
async function pass(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

async function tap(el: HTMLElement, selector: string) {
  const b = el.querySelector<HTMLButtonElement>(selector);
  if (!b) throw new Error(`no ${selector} in: ${el.textContent}`);
  expect(b.disabled).toBe(false);
  await act(async () => {
    b.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  server.shifts.clear();
  server.calls.length = 0;
  server.loseNextReply = false;
  fixAfterMs = null;
  vi.spyOn(supabase, "rpc").mockImplementation(((fn: string, args?: Args) =>
    Promise.resolve(fakeRpc(fn, args))) as unknown as typeof supabase.rpc);
  // happy-dom has no geolocation; this phone has one, and it is slow. The
  // permission reads "prompt", so the block's advisory "near the job?" check
  // asks for nothing on its own.
  Object.defineProperty(navigator, "geolocation", { configurable: true, get: () => geolocation });
  Object.defineProperty(navigator, "permissions", {
    configurable: true,
    get: () => ({ query: async () => ({ state: "prompt" }) }),
  });
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  vi.setSystemTime(T0);
});

afterEach(() => {
  for (const r of roots.splice(0)) act(() => r.unmount());
  for (const h of hosts.splice(0)) h.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
  delete (navigator as { geolocation?: unknown }).geolocation;
  delete (navigator as { permissions?: unknown }).permissions;
});

describe("the landing block's Start", () => {
  it("is stamped at the tap, not when the location fix arrives seconds later", async () => {
    fixAfterMs = 9_000;
    const el = render(<ClockInBlock />);
    await tap(el, ".clock-btn.primary.big");
    // Nothing leaves before the fix: the punch waits for it …
    await pass(8_999);
    expect(clockInCalls()).toHaveLength(0);
    await pass(1);
    // … and then carries the fix AND the moment of the tap, not 9 s later.
    const [sent] = clockInCalls();
    expect(sent).toMatchObject({ p_project_id: "p1", p_cost_code_id: "cc1", p_lat: FIX.latitude, p_lng: FIX.longitude });
    expect(sent.p_tapped_at).toBe(iso(T0));
    expect([...server.shifts.values()].map((s) => s.clock_in_at)).toEqual([iso(T0)]);
  });

  it("is ONE shift when its reply is lost after the server saved it and the sheet sends it again", async () => {
    // The block's punch is saved, the reply never comes back, and the block
    // hands the tap to the sheet — the path a lost reply takes from here.
    server.loseNextReply = true;
    const handoffs: ClockInPick[] = [];
    const onOpen = (e: Event) => handoffs.push((e as CustomEvent<ClockInPick>).detail);
    window.addEventListener("infinity:open-clock", onOpen);
    try {
      const block = render(<ClockInBlock />);
      await tap(block, ".clock-btn.primary.big");
      await pass(12_500); // no fix at all: captureGeoSoft's backstop
      expect(clockInCalls()).toHaveLength(1);
      expect(clockInCalls()[0].p_tapped_at).toBe(iso(T0));
      expect(handoffs).toHaveLength(1);
      expect(handoffs[0]).toMatchObject({ projectId: "p1", costCodeId: "cc1", clientId: clockInCalls()[0].p_client_id });

      // Twenty seconds later the person taps Start on the sheet it opened.
      await pass(20_000);
      const sheet = mountSheet({ initialPick: handoffs[0] });
      await tap(sheet, ".clock-btn.primary.big");
      await pass(12_500);
      const [first, second] = clockInCalls();
      expect(second.p_client_id).toBe(first.p_client_id);
      // One shift, paid from the block's tap: the repeat was answered with it.
      expect(server.shifts.size).toBe(1);
      expect([...server.shifts.values()][0].clock_in_at).toBe(iso(T0));
    } finally {
      window.removeEventListener("infinity:open-clock", onOpen);
    }
  });
});

describe("the clock sheet", () => {
  it("stamps Start at the tap, and a reply lost after the server saved it is sent again from the queue as the same punch — one shift", async () => {
    server.loseNextReply = true;
    const el = mountSheet();
    await tap(el, ".clock-btn.primary.big");
    // The live try goes out after the location wait gives up …
    await pass(12_500);
    // … is saved and loses its reply, so the sheet queues it, and the queue
    // sends it straight away (the phone is online).
    await pass(1_000);
    const sent = clockInCalls();
    expect(sent).toHaveLength(2);
    const [live, queued] = sent;
    // The same punch both times: one id, one tap time — the tap's, not the
    // moment the location wait ended, nor the moment the queue sent it.
    expect(queued.p_client_id).toBe(live.p_client_id);
    expect(live.p_tapped_at).toBe(iso(T0));
    expect(queued.p_tapped_at).toBe(iso(T0));
    expect(queued.p_clock_checked_at).toBe(live.p_clock_checked_at);
    expect(queued.p_clock_skew_ms).toBe(live.p_clock_skew_ms);
    expect(server.shifts.size).toBe(1);
    expect([...server.shifts.values()][0].clock_in_at).toBe(iso(T0));
  });

  /** Four hours into a shift on BLACK22, 100 — Install. */
  const onTheClock = (over: Partial<TimeShift> = {}): TimeShift => ({
    id: "11111111-2222-4333-8444-555555555555",
    profile_id: "me",
    project_id: "p1",
    cost_code_id: "cc1",
    clock_in_at: iso(T0 - 4 * 3600_000),
    clock_out_at: null,
    break_seconds: 0,
    break_started_at: null,
    break_type: null,
    injured: null,
    time_confirmed: null,
    status: "open",
    created_at: iso(T0 - 4 * 3600_000),
    projects: { job_code: "BLACK22", name: "Black Desert" },
    cost_codes: { code: "100", label: "Install" },
    ...over,
  });

  it("stamps a job switch at the tap", async () => {
    fixAfterMs = 9_000;
    const el = mountSheet({ shift: onTheClock() });
    await tap(el, ".clock-job-chip");
    await tap(el, ".clock-btn.primary.big");
    await pass(9_000);
    const [sent] = clockInCalls();
    expect(sent.p_tapped_at).toBe(iso(T0));
    expect(sent.p_lat).toBe(FIX.latitude);
  });

  it("stamps a cost-code switch at the tap", async () => {
    fixAfterMs = 9_000;
    const el = mountSheet({ shift: onTheClock() });
    await tap(el, ".clock-chip.cost:not(.current)");
    await pass(9_000);
    const [sent] = clockInCalls();
    expect(sent).toMatchObject({ p_project_id: "p1", p_cost_code_id: "cc2", p_lat: FIX.latitude });
    expect(sent.p_tapped_at).toBe(iso(T0));
  });

  it("stamps Clock out at the tap, and a running break ends there too", async () => {
    // On lunch since 6:50; Clock out tapped at 7:00; the fix takes 9 s.
    fixAfterMs = 9_000;
    const lunchFrom = T0 - 10 * 60_000;
    const el = mountSheet({ shift: onTheClock({ break_started_at: iso(lunchFrom), break_type: "lunch" }) });
    await tap(el, ".clock-btn.out");
    await pass(9_000);
    const out = server.calls.filter((c) => c.fn === "clock_out").map((c) => c.args);
    expect(out).toHaveLength(1);
    expect(out[0].p_tapped_at).toBe(iso(T0));
    // Ten minutes of lunch — not ten minutes and nine seconds.
    expect(out[0].p_break_seconds).toBe(600);
    expect(out[0].p_lat).toBe(FIX.latitude);
  });
});
