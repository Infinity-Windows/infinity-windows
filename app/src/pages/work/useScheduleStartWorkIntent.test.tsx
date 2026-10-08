// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ScheduleAssignment } from "../../lib/schedule/types";
import { rememberSignedIn, signInGeneration } from "../../lib/signedIn";
import { SCHEDULE_START_WORK_KEY, makeScheduleStartWorkState } from "../../lib/work/scheduleStartWorkIntent";

const listMyPublished = vi.fn();
const listProjects = vi.fn();
const role = { isPreviewing: false, isLoading: false };
vi.mock("../../lib/schedule/api", () => ({ listMyPublished: (...a: unknown[]) => listMyPublished(...a) }));
vi.mock("../../lib/api", () => ({ listProjects: (...a: unknown[]) => listProjects(...a) }));
vi.mock("../../lib/useEffectiveRole", () => ({ useEffectiveRole: () => role }));

import {
  clockIntentFor,
  initialIntentPhase,
  intentJobContext,
  nextIntentPhase,
  useScheduleStartWorkIntent,
  verifyScheduleStartWorkIntent,
  type IntentPhase,
  type VerifyInput,
} from "./useScheduleStartWorkIntent";

const ME = "u-me";
const A = "proj-a";
const B = "proj-b";
const C = "proj-c";

function todayISO(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
const TODAY = todayISO();

function row(id: string, projectId: string | null, extra: Partial<ScheduleAssignment> = {}): ScheduleAssignment {
  return {
    id,
    project_id: projectId,
    kind: "install",
    delivery_id: null,
    start_date: TODAY,
    end_date: TODAY,
    start_time: "07:00",
    status: "published",
    color: null,
    note: null,
    created_by: null,
    published_at: null,
    created_at: "",
    updated_at: "",
    members: [{ profile_id: ME, role: "installer" }],
    ...extra,
  };
}

const ROWS = [row("asg-a", A), row("asg-b", B)];
const PROJECTS = [{ id: A }, { id: B }, { id: C }];

// ---- the pure check ----------------------------------------------------------

describe("verifyScheduleStartWorkIntent (fail closed)", () => {
  const base = (): VerifyInput => ({
    intent: { v: 1, assignmentId: "asg-b", ownerId: ME, generation: 4, day: TODAY },
    signedInUserId: ME,
    generation: 4,
    profileId: ME,
    isPreviewing: false,
    today: TODAY,
    assignments: ROWS,
    projects: PROJECTS,
  });

  it("selects the tapped assignment's project, not the first of the day", () => {
    expect(verifyScheduleStartWorkIntent(base())).toEqual({ ok: true, assignmentId: "asg-b", projectId: B });
  });

  it.each<[string, (i: VerifyInput) => VerifyInput, string]>([
    ["another person signed in", (i) => ({ ...i, signedInUserId: "u-other" }), "identity"],
    ["nobody signed in", (i) => ({ ...i, signedInUserId: null }), "identity"],
    ["someone else's intent", (i) => ({ ...i, intent: { ...i.intent, ownerId: "u-other" } }), "identity"],
    ["empty owner", (i) => ({ ...i, intent: { ...i.intent, ownerId: "" } }), "identity"],
    ["a later sign-in generation", (i) => ({ ...i, generation: 5 }), "identity"],
    ["a profile for someone else", (i) => ({ ...i, profileId: "u-other" }), "identity"],
    ["a role preview", (i) => ({ ...i, isPreviewing: true }), "preview"],
    ["yesterday's tap", (i) => ({ ...i, intent: { ...i.intent, day: "2000-01-01" } }), "day"],
    ["an assignment not in the fresh read", (i) => ({ ...i, assignments: [row("asg-a", A)] }), "missing"],
    ["a duplicated assignment", (i) => ({ ...i, assignments: [...ROWS, row("asg-b", B)] }), "duplicate"],
    ["a canceled assignment", (i) => ({ ...i, assignments: [row("asg-b", B, { status: "canceled" })] }), "not-published"],
    ["a draft", (i) => ({ ...i, assignments: [row("asg-b", B, { status: "draft" })] }), "not-published"],
    ["a delivery with no project", (i) => ({ ...i, assignments: [row("asg-b", null, { kind: "delivery" })] }), "delivery"],
    ["an install with no project", (i) => ({ ...i, assignments: [row("asg-b", null)] }), "delivery"],
    ["not my assignment", (i) => ({ ...i, assignments: [row("asg-b", B, { members: [{ profile_id: "u-other", role: "installer" }] })] }), "not-mine"],
    ["not on today", (i) => ({ ...i, assignments: [row("asg-b", B, { start_date: "2099-01-01", end_date: "2099-01-02" })] }), "not-today"],
    ["a job missing from the job list", (i) => ({ ...i, projects: [{ id: A }] }), "unknown-project"],
  ])("refuses %s", (_label, change, reason) => {
    expect(verifyScheduleStartWorkIntent(change(base()))).toEqual({ ok: false, reason });
  });
});

describe("phase transitions", () => {
  const intent = { v: 1 as const, assignmentId: "asg-b", ownerId: ME, generation: 1, day: TODAY };
  const checking: IntentPhase = { kind: "checking", intent };

  it("no intent is inert: no event changes it and Work keeps its own choice", () => {
    const none = initialIntentPhase({ kind: "none" });
    for (const e of [{ type: "shift" }, { type: "failed" }, { type: "invalidate" }, { type: "manual", projectId: C }, { type: "verified", assignmentId: "asg-b", projectId: B }] as const) {
      expect(nextIntentPhase(none, e)).toBe(none);
    }
    expect(intentJobContext(none)).toEqual({ override: false });
    expect(clockIntentFor(none)).toBeNull();
  });

  it("malformed starts at choose; checking and choose suggest no job at all", () => {
    expect(initialIntentPhase({ kind: "malformed" })).toEqual({ kind: "choose" });
    expect(intentJobContext(checking)).toEqual({ override: true, jobId: null });
    expect(intentJobContext({ kind: "choose" })).toEqual({ override: true, jobId: null });
  });

  it("a hand pick beats a late confirmation", () => {
    const manual = nextIntentPhase(checking, { type: "manual", projectId: C });
    expect(nextIntentPhase(manual, { type: "verified", assignmentId: "asg-b", projectId: B })).toEqual({ kind: "manual", projectId: C });
    expect(intentJobContext(manual)).toEqual({ override: true, jobId: C });
    expect(clockIntentFor(manual)).toBeNull();
  });

  it("a failed check never later becomes a selection", () => {
    const choose = nextIntentPhase(checking, { type: "failed" });
    expect(nextIntentPhase(choose, { type: "verified", assignmentId: "asg-b", projectId: B })).toEqual({ kind: "choose" });
  });

  it("an identity/day/preview change turns a live selection into choose", () => {
    const selected = nextIntentPhase(checking, { type: "verified", assignmentId: "asg-b", projectId: B });
    expect(nextIntentPhase(selected, { type: "invalidate" })).toEqual({ kind: "choose" });
  });

  it("a shift drops it entirely, so a later clock-out cannot re-prime the tapped job", () => {
    const selected = nextIntentPhase(checking, { type: "verified", assignmentId: "asg-b", projectId: B });
    const dropped = nextIntentPhase(selected, { type: "shift" });
    expect(dropped).toEqual({ kind: "none" });
    expect(nextIntentPhase(dropped, { type: "verified", assignmentId: "asg-b", projectId: B })).toEqual({ kind: "none" });
  });
});

// ---- the hook ----------------------------------------------------------------

// Existing ReactDOM/happy-dom runtime; no additional test dependencies.
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const cleanups = new Set<() => void>();
async function waitFor(check: () => void) {
  await vi.waitFor(async () => {
    await act(async () => {});
    check();
  });
}
type Props = { profileId: string | null; shift: unknown; clockKnown: boolean; today: string };
function renderIntent(state: unknown, props: Partial<Props> = {}) {
  let currentProps: Props = { profileId: ME, shift: null, clockKnown: true, today: TODAY, ...props };
  type Result = { intent: ReturnType<typeof useScheduleStartWorkIntent>; location: ReturnType<typeof useLocation> };
  const result = {} as { current: Result };
  function Probe() {
    result.current = { intent: useScheduleStartWorkIntent(currentProps), location: useLocation() };
    return null;
  }
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const render = () => root.render(
    <MemoryRouter initialEntries={[{ pathname: "/", search: "?x=1", hash: "#h", state }]}><Probe /></MemoryRouter>
  );
  act(render);
  const unmount = () => { act(() => root.unmount()); host.remove(); cleanups.delete(unmount); };
  cleanups.add(unmount);
  return { result, unmount, rerender: (next: Props) => { currentProps = next; act(render); } };
}
afterEach(() => {
  for (const cleanup of cleanups) cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function tapState(assignmentId = "asg-b", extra: Record<string, unknown> = {}) {
  return { ...makeScheduleStartWorkState(assignmentId, TODAY, { userId: ME, generation: signInGeneration() }), ...extra };
}

beforeEach(() => {
  listMyPublished.mockReset();
  listProjects.mockReset();
  role.isPreviewing = false;
  role.isLoading = false;
  rememberSignedIn(null);
  rememberSignedIn({ user: { id: ME } });
});

describe("useScheduleStartWorkIntent", () => {
  it("no intent: nothing is read and nothing changes", async () => {
    const { result } = renderIntent({ keep: 1 });
    expect(result.current.intent.phase).toEqual({ kind: "none" });
    await act(async () => {});
    expect(listMyPublished).not.toHaveBeenCalled();
    expect(listProjects).not.toHaveBeenCalled();
    expect(result.current.location.state).toEqual({ keep: 1 });
  });

  it("selects the tapped job after FRESH reads, and removes only its own key from history", async () => {
    listMyPublished.mockResolvedValue(ROWS);
    listProjects.mockResolvedValue(PROJECTS);
    const { result } = renderIntent(tapState("asg-b", { keep: 1 }));
    await waitFor(() => expect(result.current.intent.phase).toEqual({ kind: "selected", assignmentId: "asg-b", projectId: B }));
    expect(listMyPublished).toHaveBeenCalledTimes(1);
    expect(listMyPublished).toHaveBeenCalledWith(ME, TODAY, TODAY, { strictRemote: true });
    expect(listProjects).toHaveBeenCalledTimes(1);
    expect(result.current.location.state).toEqual({ keep: 1 });
    expect(result.current.location.search).toBe("?x=1");
    expect(result.current.location.hash).toBe("#h");
  });

  it("a failed fresh read asks the person to choose — never the first job", async () => {
    listMyPublished.mockRejectedValue(new Error("offline"));
    listProjects.mockResolvedValue(PROJECTS);
    const { result } = renderIntent(tapState());
    await waitFor(() => expect(result.current.intent.phase).toEqual({ kind: "choose" }));
    expect(intentJobContext(result.current.intent.phase)).toEqual({ override: true, jobId: null });
  });

  it("someone else's intent asks the person to choose", async () => {
    listMyPublished.mockResolvedValue(ROWS);
    listProjects.mockResolvedValue(PROJECTS);
    const other = { [SCHEDULE_START_WORK_KEY]: { v: 1, assignmentId: "asg-b", ownerId: "u-other", generation: signInGeneration(), day: TODAY } };
    const { result } = renderIntent(other);
    await waitFor(() => expect(result.current.intent.phase).toEqual({ kind: "choose" }));
  });

  it("an intent from an earlier sign-in generation asks the person to choose", async () => {
    listMyPublished.mockResolvedValue(ROWS);
    listProjects.mockResolvedValue(PROJECTS);
    const stale = tapState();
    rememberSignedIn(null);
    rememberSignedIn({ user: { id: ME } });
    const { result } = renderIntent(stale);
    await waitFor(() => expect(result.current.intent.phase).toEqual({ kind: "choose" }));
  });

  it("a malformed intent asks to choose without reading anything", async () => {
    const { result } = renderIntent({ [SCHEDULE_START_WORK_KEY]: { v: 9 } });
    expect(result.current.intent.phase).toEqual({ kind: "choose" });
    await act(async () => {});
    expect(listMyPublished).not.toHaveBeenCalled();
    expect(result.current.location.state).toBeNull();
  });

  it("waits for the clock: nothing is read while it is unknown", async () => {
    const { result } = renderIntent(tapState(), { clockKnown: false });
    await act(async () => {});
    expect(listMyPublished).not.toHaveBeenCalled();
    expect(result.current.intent.phase.kind).toBe("checking");
  });

  it("an open shift wins: the intent is dropped and nothing is read", async () => {
    const { result } = renderIntent(tapState(), { shift: { id: "s", project_id: A, status: "open" } });
    await waitFor(() => expect(result.current.intent.phase).toEqual({ kind: "none" }));
    expect(listMyPublished).not.toHaveBeenCalled();
  });

  it("a shift recovered after the clock was unknown still wins", async () => {
    const { result, rerender } = renderIntent(tapState(), { clockKnown: false });
    rerender({ profileId: ME, shift: { id: "s", project_id: A, status: "open" }, clockKnown: true, today: TODAY });
    await waitFor(() => expect(result.current.intent.phase).toEqual({ kind: "none" }));
    expect(listMyPublished).not.toHaveBeenCalled();
  });

  it("a hand pick made while the check is held beats its late answer", async () => {
    let answer!: (rows: ScheduleAssignment[]) => void;
    listMyPublished.mockReturnValue(new Promise((r) => (answer = r)));
    listProjects.mockResolvedValue(PROJECTS);
    const { result } = renderIntent(tapState());
    await waitFor(() => expect(listMyPublished).toHaveBeenCalled());
    act(() => result.current.intent.onExplicitProjectChoice(C));
    await act(async () => answer(ROWS));
    expect(result.current.intent.phase).toEqual({ kind: "manual", projectId: C });
  });

  it("a preview starting while the check is held ends it in choose", async () => {
    let answer!: (rows: ScheduleAssignment[]) => void;
    listMyPublished.mockReturnValue(new Promise((r) => (answer = r)));
    listProjects.mockResolvedValue(PROJECTS);
    const { result, rerender } = renderIntent(tapState());
    await waitFor(() => expect(listMyPublished).toHaveBeenCalled());
    role.isPreviewing = true;
    rerender({ profileId: ME, shift: null, clockKnown: true, today: TODAY });
    await act(async () => answer(ROWS));
    expect(result.current.intent.phase).toEqual({ kind: "choose" });
  });

  it("a sign-in change after selection turns it into choose", async () => {
    listMyPublished.mockResolvedValue(ROWS);
    listProjects.mockResolvedValue(PROJECTS);
    const { result } = renderIntent(tapState());
    await waitFor(() => expect(result.current.intent.phase.kind).toBe("selected"));
    act(() => rememberSignedIn({ user: { id: "u-other" } }));
    await waitFor(() => expect(result.current.intent.phase).toEqual({ kind: "choose" }));
  });

  it("a new local day after selection turns it into choose", async () => {
    listMyPublished.mockResolvedValue(ROWS);
    listProjects.mockResolvedValue(PROJECTS);
    const { result, rerender } = renderIntent(tapState());
    await waitFor(() => expect(result.current.intent.phase.kind).toBe("selected"));
    rerender({ profileId: ME, shift: null, clockKnown: true, today: "2999-01-01" });
    await waitFor(() => expect(result.current.intent.phase).toEqual({ kind: "choose" }));
  });

  it("a shift after selection drops it, so a later clock-out does not re-prime the tapped job", async () => {
    listMyPublished.mockResolvedValue(ROWS);
    listProjects.mockResolvedValue(PROJECTS);
    const { result, rerender } = renderIntent(tapState());
    await waitFor(() => expect(result.current.intent.phase.kind).toBe("selected"));
    rerender({ profileId: ME, shift: { id: "s", project_id: B, status: "open" }, clockKnown: true, today: TODAY });
    await waitFor(() => expect(result.current.intent.phase).toEqual({ kind: "none" }));
    rerender({ profileId: ME, shift: null, clockKnown: true, today: TODAY });
    await act(async () => {});
    expect(result.current.intent.phase).toEqual({ kind: "none" });
    expect(listMyPublished).toHaveBeenCalledTimes(1);
  });

  it("a remount on the same (already stripped) entry has nothing to replay", async () => {
    listMyPublished.mockResolvedValue(ROWS);
    listProjects.mockResolvedValue(PROJECTS);
    const first = renderIntent(tapState("asg-b", { keep: 1 }));
    await waitFor(() => expect(first.result.current.intent.phase.kind).toBe("selected"));
    const strippedState = first.result.current.location.state;
    first.unmount();
    const again = renderIntent(strippedState);
    expect(again.result.current.intent.phase).toEqual({ kind: "none" });
  });
  it.each(["queued", "break", "needs-finish"])("a %s shift takes precedence without verification", async (status) => {
    const { result } = renderIntent(tapState(), { shift: { id: "s", project_id: A, status } });
    await waitFor(() => expect(result.current.intent.phase).toEqual({ kind: "none" }));
    expect(listMyPublished).not.toHaveBeenCalled();
    expect(listProjects).not.toHaveBeenCalled();
  });

  it("a person-preview profile change invalidates selected even without a role preview", async () => {
    listMyPublished.mockResolvedValue(ROWS);
    listProjects.mockResolvedValue(PROJECTS);
    const { result, rerender } = renderIntent(tapState());
    await waitFor(() => expect(result.current.intent.phase.kind).toBe("selected"));
    rerender({ profileId: "preview-person", shift: null, clockKnown: true, today: TODAY });
    expect(result.current.intent.phase).toEqual({ kind: "choose" });
  });

  it.each(["profile", "day", "owner", "generation", "preview"])("a %s change also invalidates an intent-owned manual pick", async (boundary) => {
    listMyPublished.mockReturnValue(new Promise(() => {}));
    listProjects.mockResolvedValue(PROJECTS);
    const { result, rerender } = renderIntent(tapState());
    act(() => result.current.intent.onExplicitProjectChoice(B));
    expect(result.current.intent.phase).toEqual({ kind: "manual", projectId: B });
    if (boundary === "owner") act(() => rememberSignedIn({ user: { id: "new-owner" } }));
    if (boundary === "generation") act(() => { rememberSignedIn(null); rememberSignedIn({ user: { id: ME } }); });
    if (boundary === "preview") role.isPreviewing = true;
    rerender({ profileId: boundary === "profile" ? "preview-person" : ME, shift: null, clockKnown: true, today: boundary === "day" ? "2999-01-01" : TODAY });
    expect(result.current.intent.phase).toEqual({ kind: "choose" });
    expect(intentJobContext(result.current.intent.phase)).toEqual({ override: true, jobId: null });
  });

  it("offline refuses without attempting either verification read", async () => {
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    const { result } = renderIntent(tapState());
    await waitFor(() => expect(result.current.intent.phase).toEqual({ kind: "choose" }));
    expect(listMyPublished).not.toHaveBeenCalled();
    expect(listProjects).not.toHaveBeenCalled();
  });

  it("timeout refuses and a later successful answer cannot select a job", async () => {
    vi.useFakeTimers();
    let answer!: (rows: ScheduleAssignment[]) => void;
    listMyPublished.mockReturnValue(new Promise((r) => (answer = r)));
    listProjects.mockResolvedValue(PROJECTS);
    const { result } = renderIntent(tapState());
    expect(result.current.intent.phase.kind).toBe("checking");
    await act(async () => vi.advanceTimersByTimeAsync(15_000));
    expect(result.current.intent.phase).toEqual({ kind: "choose" });
    await act(async () => answer(ROWS));
    expect(result.current.intent.phase).toEqual({ kind: "choose" });
  });

  it("leaving Work during a held verification cannot update a subsequent ordinary mount", async () => {
    let answer!: (rows: ScheduleAssignment[]) => void;
    listMyPublished.mockReturnValue(new Promise((r) => (answer = r)));
    listProjects.mockResolvedValue(PROJECTS);
    const first = renderIntent(tapState());
    await waitFor(() => expect(listMyPublished).toHaveBeenCalledTimes(1));
    const stripped = first.result.current.location.state;
    first.unmount();
    const next = renderIntent(stripped);
    await act(async () => answer(ROWS));
    expect(next.result.current.intent.phase).toEqual({ kind: "none" });
    expect(listMyPublished).toHaveBeenCalledTimes(1);
  });

  it("first profile hydration starts verification rather than invalidating the tap", async () => {
    listMyPublished.mockResolvedValue(ROWS);
    listProjects.mockResolvedValue(PROJECTS);
    const { result, rerender } = renderIntent(tapState(), { profileId: null });
    expect(result.current.intent.phase.kind).toBe("checking");
    expect(listMyPublished).not.toHaveBeenCalled();
    rerender({ profileId: ME, shift: null, clockKnown: true, today: TODAY });
    await waitFor(() => expect(result.current.intent.phase).toEqual({ kind: "selected", assignmentId: "asg-b", projectId: B }));
    expect(listMyPublished).toHaveBeenCalledTimes(1);
  });

  it("known to unknown to known profile hydration never resurrects the discarded selection", async () => {
    listMyPublished.mockResolvedValue(ROWS);
    listProjects.mockResolvedValue(PROJECTS);
    const { result, rerender } = renderIntent(tapState());
    await waitFor(() => expect(result.current.intent.phase.kind).toBe("selected"));
    rerender({ profileId: null, shift: null, clockKnown: true, today: TODAY });
    expect(result.current.intent.phase).toEqual({ kind: "choose" });
    rerender({ profileId: ME, shift: null, clockKnown: true, today: TODAY });
    await act(async () => {});
    expect(result.current.intent.phase).toEqual({ kind: "choose" });
    expect(listMyPublished).toHaveBeenCalledTimes(1);
  });

});
