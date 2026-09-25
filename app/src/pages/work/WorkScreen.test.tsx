// @vitest-environment happy-dom
//
// The Work screen, mounted for real with the server's answers seeded (crew
// redesign K1.2 / K1.3 / K1.4). What a person can SEE is what is asserted:
// the order of the four things, what the one big button says, that unit work
// is locked in words while the talk is owed, and that Next up is filled from
// the records rather than a blank form.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { IsRestoringProvider, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TimeShift } from "../../lib/timeclock";
import type { ProjectOpening } from "../../lib/install/types";
import type { WorkSession, WorkUnit } from "../../lib/customWork/model";

const ME = "00000000-0000-4000-8000-0000000000e2";
const JOB = "job-1";

// ---- the world this screen can see ---------------------------------------
let shift: TimeShift | null = null;
// The shared clock state (useClock().loading): true until the open-shift read
// has answered and this phone's queued punches have been read (#644).
let clockLoading = false;
// The saved copy of the app's data still coming back off the phone
// (PersistQueryClientProvider's restore window).
let restoring = false;
// Held open to prove the punch is stamped before the geolocation wait.
let geoGate: Promise<void> | null = null;
let talk: { id: string; title: string; body: string; talk_date: string } | null = null;
let signed: { id: string } | null = null;
let ruleDate: string | null = null;
let myOpenings: ProjectOpening[] = [];
let units: WorkUnit[] = [];
let sessions: WorkSession[] = [];
let schedule: unknown[] = [];
const clockIn = vi.fn(async (..._args: unknown[]) => ({ ...(shift ?? {}), id: "s-new" }));
const workCommand = vi.fn(async () => {});
const startOpeningWork = vi.fn(async (id: string) => ({ id }));
const navigateSpy = vi.fn();

// The screen's two ways of speaking a refusal: a toast, and leaving for the
// unit sheet. Both are spied so a test can say which one happened.
vi.mock("../../lib/toast", async (orig) => ({
  ...(await orig<typeof import("../../lib/toast")>()),
  pushToast: vi.fn(),
}));
vi.mock("react-router-dom", async (orig) => ({
  ...(await orig<typeof import("react-router-dom")>()),
  useNavigate: () => navigateSpy,
}));

vi.mock("../../lib/clockContext", () => ({
  useClock: () => ({ shift, profileId: ME, loading: clockLoading, isOpen: false, openClock: () => {}, closeClock: () => {}, refresh: () => {} }),
  openClockGlobally: vi.fn(),
}));
vi.mock("../../lib/install/api", () => ({
  getMyProfile: async () => ({ id: ME, display_name: "E2E", role: "installer", active: true }),
  getRealProfile: async () => ({ id: ME, display_name: "E2E", role: "installer", active: true }),
  listMyOpeningsAllJobs: async () => myOpenings,
  listOpenings: async () => [],
  startOpeningWork: (id: string) => startOpeningWork(id),
}));
vi.mock("../../lib/install/sessions", () => ({
  listSessionsForOpenings: async () => [],
  blockedUnits: () => [],
}));
vi.mock("../../lib/ops", () => ({
  getTodayTalk: async () => talk,
  listQcQueue: async () => ({ rows: [], hasMore: false }),
}));
vi.mock("../../lib/toolbox", () => ({
  myTodayCompletion: async () => signed,
  submitToolboxCompletion: vi.fn(),
}));
vi.mock("../../lib/companySettings", () => ({
  getCompanySettings: async () => ({
    id: 1,
    evening_nudge_local_time: "17:30:00",
    evening_nudge_enabled: true,
    new_design_r1_enabled: true,
    paid_time_from_start_day_on: ruleDate,
  }),
}));
vi.mock("../../lib/schedule/api", () => ({ listMyPublished: async () => schedule }));
vi.mock("../../lib/api", () => ({
  listProjects: async () => [{ id: JOB, job_code: "OAKRIDGE", name: "Oakridge Apartments", address: "1 Main St", status: "active", allowed_modes: ["data"] }],
}));
vi.mock("../../lib/costCodes", () => ({
  getClockCostCodesForProject: async () => [{ id: "cc-gen", code: "000", label: "General", active: true, is_general: true }],
}));
vi.mock("../../lib/timeclock", async (orig) => ({
  ...(await orig<typeof import("../../lib/timeclock")>()),
  listRecentJobs: async () => [{ projectId: JOB, jobCode: "OAKRIDGE", name: "Oakridge Apartments", costCodeId: "cc-gen", lastClockInAt: "" }],
  clockIn: (...a: unknown[]) => clockIn(...a),
}));
vi.mock("../../lib/geo", () => ({
  captureGeoSoft: async () => {
    if (geoGate) await geoGate;
    return {};
  },
}));
vi.mock("../../lib/vehicles/api", () => ({ listVehicleLinksForAssignments: async () => [] }));
vi.mock("../../lib/offline/outbox", () => ({
  pendingPhotos: async () => ({ count: 0, oldestAt: null }),
  subscribe: () => () => {},
  enqueueClockIn: vi.fn(async () => "entry-1"),
  pendingRefForShift: (id: string) => `pending:${id}`,
}));
vi.mock("../../lib/customWork/useWork", () => ({
  useWork: () => ({
    clock: { shift, profileId: ME },
    user: ME,
    units,
    sessions,
    types: [],
    queue: [],
    queueError: "",
    command: workCommand,
    refresh: async () => {},
    sync: async () => {},
    loading: false,
    error: null,
    active: sessions.find((s) => s.profile_id === ME && !s.ended_at) ?? null,
  }),
}));
vi.mock("../../lib/useEffectiveRole", () => ({
  useEffectiveRole: () => ({ realRole: "installer", effectiveRole: "installer", isPreviewing: false, isLoading: false, grants: {} }),
}));
vi.mock("../../components/install/LiveSummonsStrip", () => ({ LiveSummonsStrip: () => null }));
vi.mock("../../components/clock/ToolboxSignCard", () => ({
  // The signature is a button here, so a test can say WHEN it landed.
  ToolboxSignCard: ({ talk: tk, onSigned }: { talk: { title: string }; onSigned?: () => void }) => (
    <div data-testid="sign-card">
      <button type="button" data-testid="sign-now" onClick={() => onSigned?.()}>
        Sign: {tk.title}
      </button>
    </div>
  ),
}));

const { WorkScreen } = await import("./WorkScreen");
const { pushToast } = await import("../../lib/toast");
const { openClockGlobally } = await import("../../lib/clockContext");
const { enqueueClockIn } = await import("../../lib/offline/outbox");

function opening(over: Partial<ProjectOpening>): ProjectOpening {
  return {
    id: "o1",
    project_id: JOB,
    planset_id: null,
    opening_code: "W7",
    window_type_id: null,
    label: "Kitchen",
    page_number: 1,
    pin_x: null,
    pin_y: null,
    assigned_window_id: null,
    status: "planned",
    confirmed: true,
    created_at: "",
    ro_width_in: null,
    ro_height_in: null,
    ro_measured_by: null,
    ro_measured_at: null,
    assigned_to: ME,
    sequence: 1,
    work_started_at: null,
    projects: { job_code: "OAKRIDGE", name: "Oakridge Apartments" },
    ...over,
  } as ProjectOpening;
}

function openShift(): TimeShift {
  const inAt = new Date();
  inAt.setHours(7, 2, 0, 0);
  return {
    id: "s1",
    profile_id: ME,
    project_id: JOB,
    cost_code_id: "cc-gen",
    clock_in_at: inAt.toISOString(),
    clock_out_at: null,
    break_seconds: 0,
    break_started_at: null,
    injured: null,
    time_confirmed: null,
    status: "open",
    created_at: inAt.toISOString(),
    projects: { job_code: "OAKRIDGE", name: "Oakridge Apartments" },
  } as TimeShift;
}

let root: Root | null = null;
let host: HTMLDivElement | null = null;

beforeEach(() => {
  shift = null;
  clockLoading = false;
  restoring = false;
  geoGate = null;
  vi.mocked(openClockGlobally).mockClear();
  vi.mocked(enqueueClockIn).mockClear();
  talk = null;
  signed = null;
  ruleDate = null;
  myOpenings = [];
  units = [];
  sessions = [];
  schedule = [];
  clockIn.mockClear();
  workCommand.mockClear();
  startOpeningWork.mockClear();
  navigateSpy.mockClear();
  vi.mocked(pushToast).mockClear();
});
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

let qc: QueryClient | null = null;
const tree = () => (
  <QueryClientProvider client={qc!}>
    <IsRestoringProvider value={restoring}>
      <MemoryRouter>
        <WorkScreen />
      </MemoryRouter>
    </IsRestoringProvider>
  </QueryClientProvider>
);
async function settle() {
  // Let every seeded query resolve.
  for (let i = 0; i < 3; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}
async function mount(seed?: (client: QueryClient) => void): Promise<HTMLElement> {
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  seed?.(qc);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(tree());
  });
  await settle();
  return host;
}
/** The provider's answer changed (the clock was read): render again. */
async function rerender(): Promise<HTMLElement> {
  await act(async () => {
    root!.render(tree());
  });
  await settle();
  return host!;
}

const byTestId = (el: HTMLElement, id: string) => el.querySelector<HTMLElement>(`[data-testid="${id}"]`);

describe("WorkScreen (K1.2)", () => {
  it("lays out clock → today → your unit → quick buttons, in that order", async () => {
    const el = await mount();
    const order = ["ws-clock", "ws-today", "ws-unit", "ws-quick"].map((id) => byTestId(el, id));
    for (const node of order) expect(node).not.toBeNull();
    const pos = order.map((n) => [...el.querySelectorAll("[data-testid]")].indexOf(n!));
    expect(pos).toEqual([...pos].sort((a, b) => a - b));
  });

  it("off the clock the one big button is Start day, with today's job already picked", async () => {
    const el = await mount();
    const btn = byTestId(el, "ws-start-day")!;
    expect(btn.textContent).toContain("Start day");
    expect(btn.className).toContain("ws-btn--primary");
    expect(byTestId(el, "ws-clock")!.textContent).toContain("OAKRIDGE · Oakridge Apartments");
    expect(byTestId(el, "ws-clock")!.textContent).toContain("000 — General");
  });

  it("K1.3, signed already: Start day clocks straight in — one tap", async () => {
    talk = { id: "t1", title: "Ladders", body: "", talk_date: "2026-10-06" };
    signed = { id: "c1" };
    const el = await mount();
    await act(async () => byTestId(el, "ws-start-day")!.click());
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(clockIn).toHaveBeenCalledTimes(1);
    expect(clockIn.mock.calls[0][0]).toBe(JOB);
    expect(byTestId(el, "ws-start-talk")).toBeNull();
  });

  it("K1.3, unsigned with the rule off: Start day opens the talk first and does not clock in yet", async () => {
    talk = { id: "t1", title: "Ladders", body: "", talk_date: "2026-10-06" };
    signed = null;
    const el = await mount();
    expect(byTestId(el, "ws-clock")!.textContent).toContain("Opens today's toolbox talk first.");
    await act(async () => byTestId(el, "ws-start-day")!.click());
    expect(clockIn).not.toHaveBeenCalled();
    expect(byTestId(el, "ws-start-talk")!.textContent).toContain("Sign: Ladders");
  });

  it("K1.3, unsigned with the rule ON: Start day clocks in at the tap; the talk card waits on the clock", async () => {
    talk = { id: "t1", title: "Ladders", body: "", talk_date: "2026-10-06" };
    signed = null;
    ruleDate = "2000-01-01";
    const el = await mount();
    expect(byTestId(el, "ws-clock")!.textContent).toContain("Paid time starts at this tap.");
    await act(async () => byTestId(el, "ws-start-day")!.click());
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(clockIn).toHaveBeenCalledTimes(1);
  });

  it("on the clock with the talk owed: the Finish-your-toolbox-talk card shows and unit work is locked in words", async () => {
    shift = openShift();
    talk = { id: "t1", title: "Ladders", body: "", talk_date: "2026-10-06" };
    signed = null;
    myOpenings = [opening({})];
    const el = await mount();
    expect(byTestId(el, "ws-clock")!.textContent).toContain("Clocked in 7:02");
    expect(byTestId(el, "ws-finish-talk")!.textContent).toContain("Finish your toolbox talk");
    const unit = byTestId(el, "ws-unit")!;
    expect(unit.textContent).toContain("Sign today's toolbox talk to start a unit.");
    expect(byTestId(el, "ws-unit-start")!.hasAttribute("disabled")).toBe(true);
    // And the heads-up says so too.
    expect(byTestId(el, "ws-headsups")!.textContent).toContain("Toolbox talk not signed yet");
    // The card under the clock says what the signature unlocks: both.
    expect(byTestId(el, "ws-finish-talk")!.textContent).toContain("unlock unit work and prep time");
  });

  // Prep time waits for the signature exactly like unit work (owner,
  // 2026-09-24): locked in words on the clock with the talk owed, and the
  // server's refusal said in the phone's words when the phone's read was stale.
  it("K1.3: on the clock with the talk owed, Prep time is locked in words and the sheet does not open", async () => {
    shift = openShift();
    talk = { id: "t1", title: "Ladders", body: "", talk_date: "2026-10-06" };
    signed = null;
    const el = await mount();
    const prep = byTestId(el, "ws-quick-prep")!;
    expect(prep.getAttribute("data-locked")).toBe("true");
    await act(async () => prep.click());
    expect(pushToast).toHaveBeenCalledWith("Sign today's toolbox talk to start prep time.", "info");
    expect(el.querySelector('[role="dialog"][aria-label="Prep time"]')).toBeNull();
    expect(workCommand).not.toHaveBeenCalled();
  });

  it("K1.3: a prep start Forge refuses for the signature is said in plain words, and the sheet closes", async () => {
    shift = openShift();
    signed = { id: "stale" };
    workCommand.mockRejectedValueOnce(new Error("Sign today's toolbox talk before starting work."));
    const el = await mount();
    const prep = byTestId(el, "ws-quick-prep")!;
    expect(prep.getAttribute("data-locked")).toBeNull();
    await act(async () => prep.click());
    const sheet = el.querySelector<HTMLElement>('[role="dialog"][aria-label="Prep time"]');
    expect(sheet).not.toBeNull();
    const hauling = [...sheet!.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Hauling")!;
    await act(async () => hauling.click());
    await act(async () => byTestId(el, "ws-prep-start")!.click());
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(workCommand).toHaveBeenCalledWith("start", expect.objectContaining({ unit_id: null, stage: "Idle time", description: "Hauling" }));
    expect(pushToast).toHaveBeenCalledWith(
      "Forge won't start prep time until today's toolbox talk is signed. Sign it under Finish your toolbox talk, then try again.",
      "error",
    );
    expect(el.querySelector('[role="dialog"][aria-label="Prep time"]')).toBeNull();
  });

  it("K1.4: after clock-in, Next up comes from the plan's openings — assigned to me, on my job", async () => {
    shift = openShift();
    signed = { id: "c1" };
    myOpenings = [opening({ id: "o2", opening_code: "W9", sequence: 2 }), opening({ id: "o1", opening_code: "W7", sequence: 1 })];
    const el = await mount();
    const unit = byTestId(el, "ws-unit")!;
    expect(unit.textContent).toContain("Next up");
    expect(unit.textContent).toContain("Assigned to you");
    expect(unit.textContent).toContain("W7");
    expect(byTestId(el, "ws-unit-start")!.hasAttribute("disabled")).toBe(false);
  });

  it("K1.4: a running custom unit shows with Pause and Finish", async () => {
    shift = openShift();
    signed = { id: "c1" };
    units = [{ id: "u1", project_id: JOB, opening_id: null, created_by: ME, label: "16", type_label: "Slider", facts: {}, revision: 1, created_at: "", updated_at: "" }];
    sessions = [{ id: "ss1", profile_id: ME, shift_id: "s1", project_id: JOB, unit_id: "u1", kind: "unit", participation: "install", stage: "Installing", description: "", outcome: null, delay_reason: "", started_at: new Date(Date.now() - 600_000).toISOString(), ended_at: null, end_reason: null, revision: 1 }];
    const el = await mount();
    const unit = byTestId(el, "ws-unit")!;
    expect(unit.textContent).toContain("Working on");
    expect(unit.textContent).toContain("16");
    const finish = [...unit.querySelectorAll("button")].find((b) => /Finish/.test(b.textContent ?? ""))!;
    await act(async () => finish.click());
    expect(workCommand).toHaveBeenCalledWith("stop", expect.objectContaining({ outcome: "finished", expected_session_id: "ss1" }));
  });

  // K1.3 on the server: every unit start is refused until today's talk is
  // signed (_unit_work_gate, 20261031000000). The button here was live
  // because the phone's last read said signed; the server knows better.
  const REFUSAL = "Sign today's toolbox talk before starting work on a unit.";

  it("K1.3: a plan-opening start Forge refuses for the signature is said in plain words, and the sheet does not open", async () => {
    shift = openShift();
    signed = { id: "stale" };
    myOpenings = [opening({})];
    startOpeningWork.mockRejectedValueOnce(new Error(REFUSAL));
    const el = await mount();
    await act(async () => byTestId(el, "ws-unit-start")!.click());
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(startOpeningWork).toHaveBeenCalledWith("o1");
    expect(pushToast).toHaveBeenCalledWith(
      "Forge won't start a unit until today's toolbox talk is signed. Sign it under Finish your toolbox talk, then try again.",
      "error",
    );
    // The sheet cannot clear this one, so Work stays put (any other refusal
    // opens the sheet with the reason — that path is unchanged).
    expect(navigateSpy).not.toHaveBeenCalled();
  });

  it("K1.3: a saved-unit start Forge refuses for the signature shows the same words on the card", async () => {
    shift = openShift();
    signed = { id: "stale" };
    units = [{ id: "u1", project_id: JOB, opening_id: null, created_by: ME, label: "16", type_label: "Slider", facts: {}, revision: 1, created_at: "", updated_at: "" }];
    workCommand.mockRejectedValueOnce(new Error(REFUSAL));
    const el = await mount();
    await act(async () => byTestId(el, "ws-unit-start")!.click());
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(workCommand).toHaveBeenCalledWith("start", expect.objectContaining({ unit_id: "u1" }));
    const alert = byTestId(el, "ws-unit")!.querySelector("[role=alert]");
    expect(alert?.textContent).toContain("Forge won't start a unit until today's toolbox talk is signed");
    expect(alert?.textContent).not.toContain(REFUSAL);
  });

  it("K1.4: nothing matches → the blank New unit door, only then", async () => {
    shift = openShift();
    signed = { id: "c1" };
    const el = await mount();
    expect(byTestId(el, "ws-unit-new")).not.toBeNull();
    expect(byTestId(el, "ws-unit")!.textContent).toContain("Nothing matched on this job.");
  });

  it("Today reads the published assignment with its Updated time and a Changed tag", async () => {
    const today = new Date().toISOString().slice(0, 10);
    schedule = [
      {
        id: "a1",
        project_id: JOB,
        kind: "install",
        delivery_id: null,
        start_date: today,
        end_date: today,
        start_time: "07:00",
        end_time: "15:30",
        status: "published",
        color: null,
        note: null,
        created_by: null,
        published_at: new Date(Date.now() - 3 * 86400_000).toISOString(),
        created_at: "",
        // An hour ago, but never before today's midnight: in the first hour
        // after midnight an hour ago is yesterday, and Updated then reads
        // "Thu 11:00 PM" — right for the card, wrong for this assertion.
        updated_at: new Date(Math.max(Date.now() - 3600_000, new Date().setHours(0, 0, 0, 0))).toISOString(),
        members: [{ profile_id: ME, role: "installer", display_name: "E2E" }, { profile_id: "x", role: "foreman", display_name: "Sam" }],
        project: { id: JOB, job_code: "OAKRIDGE", name: "Oakridge Apartments", address: "1 Main St" },
      },
    ];
    const el = await mount();
    const today$ = byTestId(el, "ws-today")!;
    expect(today$.textContent).toContain("Oakridge Apartments");
    expect(today$.textContent).toMatch(/Starts 7:00/);
    expect(today$.textContent).toContain("With Sam");
    expect(today$.textContent).toMatch(/Updated \d/);
    expect(today$.textContent).toContain("Changed");
    expect(byTestId(el, "ws-headsups")!.textContent).toContain("Your schedule changed");
  });
});

// Codex review of #642 (2026-09-25). P1 3: nothing that punches is offered
// until the shared clock state is known — a null shift before then means
// "not read yet", and a tap in that gap was a second clock-in over the first.
// P1 2: one punch per Start day tap, stamped at the tap (before the
// geolocation wait), through the live try, the queue and the hand-off.
describe("Start day and a clock that is not known yet (Codex review of #642)", () => {
  const TALK = { id: "t1", title: "Ladders", body: "", talk_date: "2026-10-06" };
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  const startDay = (el: HTMLElement) => byTestId(el, "ws-start-day");
  type Punch = { clientId: string; tappedAt: string };
  const punchOf = (call: number): Punch => clockIn.mock.calls[call][5] as Punch;

  it("cold reload with a shift on the server: 'Recovering your clock', no Start day, then the shift itself", async () => {
    clockLoading = true; // the open-shift read has not answered yet
    signed = { id: "c1" };
    const el = await mount();
    expect(byTestId(el, "ws-clock-recovering")!.textContent).toContain("Recovering your clock");
    expect(startDay(el)).toBeNull();
    expect(el.textContent).not.toContain("More clock options");
    // The read answers with the shift the server already holds.
    clockLoading = false;
    shift = openShift();
    await rerender();
    expect(byTestId(el, "ws-clock-recovering")).toBeNull();
    expect(byTestId(el, "ws-clock")!.textContent).toContain("Clocked in 7:02");
    expect(startDay(el)).toBeNull();
    expect(clockIn).not.toHaveBeenCalled();
    expect(enqueueClockIn).not.toHaveBeenCalled();
  });

  it("cold reload with a clock-in queued on this phone: recovering, then clocked in from the queue — never a second Start day", async () => {
    clockLoading = true; // this phone's own queue has not been read yet (#644)
    const el = await mount();
    expect(byTestId(el, "ws-clock-recovering")).not.toBeNull();
    expect(startDay(el)).toBeNull();
    // The queue is read: the clock-in tapped with no signal is the shift.
    clockLoading = false;
    shift = { ...openShift(), id: "pending:entry-7" };
    await rerender();
    const strip = byTestId(el, "ws-clock")!;
    expect(strip.textContent).toContain("Clocked in 7:02");
    expect(strip.textContent).toContain("Saved on this phone");
    expect(startDay(el)).toBeNull();
    expect(clockIn).not.toHaveBeenCalled();
    expect(enqueueClockIn).not.toHaveBeenCalled();
  });

  it("while the saved copy of the app's data is still coming back (idle, not 'loading'): no Start day", async () => {
    restoring = true;
    // Nothing restored yet: not even who this is — the screen waits.
    let el = await mount();
    expect(startDay(el)).toBeNull();
    act(() => root?.unmount());
    host?.remove();
    // The person already known (a profile in memory) and the clock not:
    // react-query calls a restoring query idle, so useClock().loading alone
    // would read false here — the strip still says it is recovering.
    el = await mount((client) =>
      client.setQueryData(["myProfile"], { id: ME, display_name: "E2E", role: "installer", active: true }),
    );
    expect(byTestId(el, "ws-clock-recovering")).not.toBeNull();
    expect(startDay(el)).toBeNull();
    restoring = false;
    await rerender();
    expect(byTestId(el, "ws-clock-recovering")).toBeNull();
    expect(startDay(el)).not.toBeNull();
  });

  it("stamps the punch at the Start day tap, before the geolocation wait, with the tap's picks and mode", async () => {
    talk = TALK;
    signed = { id: "c1" };
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-09-25T13:02:00.000Z") });
    try {
      let found!: () => void;
      geoGate = new Promise<void>((r) => {
        found = r;
      });
      const el = await mount();
      await act(async () => startDay(el)!.click());
      // The phone takes ten seconds to find itself.
      vi.setSystemTime(new Date("2026-09-25T13:02:10.000Z"));
      found();
      await settle();
      expect(clockIn).toHaveBeenCalledTimes(1);
      const [projectId, costCodeId, , , mode] = clockIn.mock.calls[0];
      expect([projectId, costCodeId, mode]).toEqual([JOB, "cc-gen", "data"]);
      expect(punchOf(0).tappedAt).toBe("2026-09-25T13:02:00.000Z");
      expect(punchOf(0).clientId).toMatch(UUID);
    } finally {
      vi.useRealTimers();
    }
  });

  it("unsigned with the rule off, signing IS the clock-in: the punch is stamped at the signature", async () => {
    talk = TALK;
    signed = null;
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-09-25T12:55:00.000Z") });
    try {
      const el = await mount();
      await act(async () => startDay(el)!.click());
      expect(clockIn).not.toHaveBeenCalled();
      // Five minutes reading the talk, off the clock (today's timing).
      vi.setSystemTime(new Date("2026-09-25T13:00:00.000Z"));
      await act(async () => byTestId(el, "sign-now")!.click());
      await settle();
      expect(clockIn).toHaveBeenCalledTimes(1);
      expect(punchOf(0).tappedAt).toBe("2026-09-25T13:00:00.000Z");
    } finally {
      vi.useRealTimers();
    }
  });

  it("a reply that never came back: the queue gets the SAME punch and mode, and the phone's shift starts at the tap", async () => {
    signed = { id: "c1" };
    clockIn.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    const el = await mount();
    await act(async () => startDay(el)!.click());
    await settle();
    expect(clockIn).toHaveBeenCalledTimes(1);
    const punch = punchOf(0);
    expect(enqueueClockIn).toHaveBeenCalledTimes(1);
    const queued = vi.mocked(enqueueClockIn).mock.calls[0][0];
    expect(queued.punch).toBe(punch);
    expect(queued).toMatchObject({ projectId: JOB, costCodeId: "cc-gen", mode: "data" });
    expect(qc!.getQueryData<TimeShift>(["openShift", ME])).toMatchObject({
      id: "pending:entry-1",
      clock_in_at: punch.tappedAt,
      job_mode: "data",
    });
  });

  it("a server no hands the clock sheet this tap's whole punch, so its retry is the same punch", async () => {
    // The id AND the tap time: a retry of a request that never arrived is
    // still paid from this tap, not from the sheet's later one.
    signed = { id: "c1" };
    clockIn.mockRejectedValueOnce(new Error("complete today's toolbox talk before clocking in"));
    const el = await mount();
    await act(async () => startDay(el)!.click());
    await settle();
    expect(enqueueClockIn).not.toHaveBeenCalled();
    expect(openClockGlobally).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: JOB, costCodeId: "cc-gen", mode: "data", punch: punchOf(0) }),
    );
  });

  it("two separate Start day taps are two punches", async () => {
    signed = { id: "c1" };
    clockIn.mockRejectedValueOnce(new Error("complete today's toolbox talk before clocking in"));
    const el = await mount();
    await act(async () => startDay(el)!.click());
    await settle();
    await act(async () => startDay(el)!.click());
    await settle();
    expect(clockIn).toHaveBeenCalledTimes(2);
    expect(punchOf(0).clientId).not.toBe(punchOf(1).clientId);
  });
});
