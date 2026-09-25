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
// can lose a reply AFTER saving, or lose the request BEFORE anything is saved
// — the two cases a retry exists for, and the retry must be the same punch in
// both. Nothing between the tap and the RPC is mocked: the real clockIn, the
// real location wait, the real offline queue and its real sender.

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
// The queue sends a punch only as the person who tapped it, through a client
// bound to their token (2026-09-25). These tests watch the shared client's
// rpc, so the bound client is that same one.
vi.mock("../../lib/supabase", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../lib/supabase")>();
  return { ...real, clientWithToken: () => real.supabase };
});

import { supabase } from "../../lib/supabase";
import { rememberSignedIn } from "../../lib/signedIn";
import { forgetClockCheck, recordClockCheck } from "../../lib/clockSkew";
import type { ClockInPick, TimeShift } from "../../lib/timeclock";
import type { Session } from "@supabase/supabase-js";
import { ClockInBlock } from "./ClockInBlock";
import { ClockSheet } from "./ClockSheet";

const P1 = { id: "p1", job_code: "BLACK22", name: "Black Desert", address: null, status: "active", allowed_modes: ["data"] };

/** Who taps: the fake server files every shift as "me". */
const ME = { access_token: "me-token", user: { id: "me", email: "me@example.test" } };

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
  /** Lose the next punch on the way there: nothing is saved. */
  dropNextRequest: false,
};
const LOST = { data: null, error: { message: "TypeError: Failed to fetch", details: "", hint: "", code: "" } };

function fakeRpc(fn: string, args: Args = {}) {
  server.calls.push({ fn, args });
  if (fn === "server_now") return { data: iso(Date.now()), error: null };
  if (fn === "clock_in") {
    if (server.dropNextRequest) {
      server.dropNextRequest = false;
      return LOST;
    }
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

/** The two ways a punch's first try fails that a retry must survive as the same punch. */
const FAILURES = [
  ["its reply is lost after the server saved it", () => (server.loseNextReply = true)],
  ["its request never reached the server", () => (server.dropNextRequest = true)],
] as const;

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

/** When today's talk was signed, by the signing phone's clock: 6:00, before any tap here. */
const SIGNED_EARLY = iso(T0 - 3600_000);

function client(opts: { signedAt?: string } = {}): QueryClient {
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
  qc.setQueryData(["toolboxToday", "me"], { id: "done1", signed_at: opts.signedAt ?? SIGNED_EARLY });
  return qc;
}

function render(ui: ReactNode, opts: { signedAt?: string } = {}): HTMLElement {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(<QueryClientProvider client={client(opts)}><MemoryRouter>{ui}</MemoryRouter></QueryClientProvider>));
  roots.push(root);
  hosts.push(host);
  return host;
}

function mountSheet(
  opts: { shift?: TimeShift | null; initialPick?: ClockInPick | null; signedAt?: string } = {},
): HTMLElement {
  return render(
    <ClockSheet profileId="me" shift={opts.shift ?? null} initialPick={opts.initialPick ?? null} onClose={() => {}} onChanged={() => {}} />,
    { signedAt: opts.signedAt },
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
  server.dropNextRequest = false;
  fixAfterMs = null;
  vi.spyOn(supabase, "rpc").mockImplementation(((fn: string, args?: Args) =>
    Promise.resolve(fakeRpc(fn, args))) as unknown as typeof supabase.rpc);
  // The person who taps is signed in: the phone knows them, and so does auth.
  rememberSignedIn(ME);
  vi.spyOn(supabase.auth, "getSession").mockResolvedValue({
    data: { session: ME as unknown as Session },
    error: null,
  } as Awaited<ReturnType<typeof supabase.auth.getSession>>);
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
  // This phone checked its clock a minute ago and ran 1.5 s ahead: every
  // punch carries that check, so a punch re-stamped later would show it.
  forgetClockCheck();
  recordClockCheck(T0 - 60_000, T0 - 61_500);
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

  // The block's request fails either way, and the block hands the tap to the
  // sheet — the path a failed Start takes from here. Saved or not, the
  // sheet's Start must send the SAME punch: its id, its tap time and its
  // clock check. With only the id carried, the never-arrived case was paid
  // from the sheet's own later tap (Codex review of #640, 2026-09-25).
  it.each(FAILURES)("is ONE shift, paid from its tap, when %s and the sheet sends it again", async (_how, fail) => {
    fail();
    const handoffs: ClockInPick[] = [];
    const onOpen = (e: Event) => handoffs.push((e as CustomEvent<ClockInPick>).detail);
    window.addEventListener("infinity:open-clock", onOpen);
    try {
      const block = render(<ClockInBlock />);
      await tap(block, ".clock-btn.primary.big");
      await pass(12_500); // no fix at all: captureGeoSoft's backstop
      expect(clockInCalls()).toHaveLength(1);
      const first = clockInCalls()[0];
      expect(first.p_tapped_at).toBe(iso(T0));
      expect(handoffs).toHaveLength(1);
      // The whole punch rides the hand-off, not just its id.
      expect(handoffs[0]).toEqual({
        projectId: "p1",
        costCodeId: "cc1",
        note: null,
        mode: "data",
        punch: {
          clientId: first.p_client_id,
          tappedAt: iso(T0),
          clockCheckedAt: iso(T0 - 61_500),
          clockSkewMs: 1_500,
        },
      });

      // Twenty seconds later — the phone having checked its clock again
      // meanwhile — the person taps Start on the sheet it opened.
      await pass(20_000);
      recordClockCheck(Date.now(), Date.now());
      const sheet = mountSheet({ initialPick: handoffs[0] });
      await tap(sheet, ".clock-btn.primary.big");
      await pass(12_500);
      const sent = clockInCalls();
      expect(sent).toHaveLength(2);
      // The sheet sent the block's punch as it came: same id, same tap time,
      // same clock check — not the sheet tap's time or the newer check.
      expect(sent[1]).toMatchObject({
        p_client_id: first.p_client_id,
        p_tapped_at: iso(T0),
        p_clock_checked_at: iso(T0 - 61_500),
        p_clock_skew_ms: 1_500,
      });
      // One shift, paid from the block's tap — whether the server answered
      // the repeat with the shift it had saved, or saved it only now.
      expect(server.shifts.size).toBe(1);
      expect([...server.shifts.values()][0].clock_in_at).toBe(iso(T0));
    } finally {
      window.removeEventListener("infinity:open-clock", onOpen);
    }
  });

  it("is paid from today's talk, under the same id, when the talk was signed after its tap and before the sheet sent it", async () => {
    // The block's request never arrived, and before the sheet's Start the
    // person signed today's talk (at 7:00:30). Paid time does not start
    // before the talk: the effective tap is the later of the two — the rule
    // the block and Start day follow when signing IS the clock-in.
    server.dropNextRequest = true;
    const handoffs: ClockInPick[] = [];
    const onOpen = (e: Event) => handoffs.push((e as CustomEvent<ClockInPick>).detail);
    window.addEventListener("infinity:open-clock", onOpen);
    try {
      const block = render(<ClockInBlock />);
      await tap(block, ".clock-btn.primary.big");
      await pass(12_500);
      expect(handoffs).toHaveLength(1);
      const first = clockInCalls()[0];

      await pass(20_000);
      const signedAt = iso(T0 + 30_000);
      const sheet = mountSheet({ initialPick: handoffs[0], signedAt });
      await tap(sheet, ".clock-btn.primary.big");
      await pass(12_500);
      const sent = clockInCalls();
      expect(sent).toHaveLength(2);
      expect(sent[1].p_client_id).toBe(first.p_client_id);
      expect(sent[1].p_tapped_at).toBe(signedAt);
      expect(server.shifts.size).toBe(1);
      expect([...server.shifts.values()][0].clock_in_at).toBe(signedAt);
    } finally {
      window.removeEventListener("infinity:open-clock", onOpen);
    }
  });
});

describe("the clock sheet", () => {
  it.each(FAILURES)("stamps Start at the tap, and when %s the queue sends the same punch — one shift, paid from the tap", async (_how, fail) => {
    fail();
    const el = mountSheet();
    await tap(el, ".clock-btn.primary.big");
    // The live try goes out after the location wait gives up …
    await pass(12_500);
    // … fails on the network (saved or not), so the sheet queues it, and the
    // queue sends it straight away (the phone is online).
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
