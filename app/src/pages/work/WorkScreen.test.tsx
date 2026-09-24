// @vitest-environment happy-dom
//
// The Work screen, mounted for real with the server's answers seeded (crew
// redesign K1.2 / K1.3 / K1.4). What a person can SEE is what is asserted:
// the order of the four things, what the one big button says, that unit work
// is locked in words while the talk is owed, and that Next up is filled from
// the records rather than a blank form.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TimeShift } from "../../lib/timeclock";
import type { ProjectOpening } from "../../lib/install/types";
import type { WorkSession, WorkUnit } from "../../lib/customWork/model";

const ME = "00000000-0000-4000-8000-0000000000e2";
const JOB = "job-1";

// ---- the world this screen can see ---------------------------------------
let shift: TimeShift | null = null;
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
  useClock: () => ({ shift, profileId: ME, loading: false, isOpen: false, openClock: () => {}, closeClock: () => {}, refresh: () => {} }),
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
vi.mock("../../lib/geo", () => ({ captureGeoSoft: async () => ({}) }));
vi.mock("../../lib/vehicles/api", () => ({ listVehicleLinksForAssignments: async () => [] }));
vi.mock("../../lib/offline/outbox", () => ({
  pendingPhotos: async () => ({ count: 0, oldestAt: null }),
  subscribe: () => () => {},
  enqueueClockIn: vi.fn(),
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
  ToolboxSignCard: ({ talk: tk }: { talk: { title: string } }) => <div data-testid="sign-card">Sign: {tk.title}</div>,
}));

const { WorkScreen } = await import("./WorkScreen");
const { pushToast } = await import("../../lib/toast");

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

async function mount(): Promise<HTMLElement> {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      <QueryClientProvider client={qc}>
        <MemoryRouter>
          <WorkScreen />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  // Let every seeded query resolve.
  for (let i = 0; i < 3; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
  return host;
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
        updated_at: new Date(Date.now() - 3600_000).toISOString(),
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
