import { describe, expect, it } from "vitest";
import type { ProjectOpening } from "../install/types";
import type { WorkSession, WorkUnit } from "../customWork/model";
import { chooseNextUp, type NextUpInput } from "./nextUp";

const NOW = new Date("2026-10-06T15:00:00Z").getTime(); // 9 AM Denver
const ME = "me";
const JOB = "job-a";

function opening(over: Partial<ProjectOpening>): ProjectOpening {
  return {
    id: "o",
    project_id: JOB,
    planset_id: null,
    opening_code: "W1",
    window_type_id: null,
    label: null,
    page_number: 1,
    pin_x: null,
    pin_y: null,
    assigned_window_id: null,
    status: "planned",
    confirmed: true,
    created_at: "2026-10-01T00:00:00Z",
    ro_width_in: null,
    ro_height_in: null,
    ro_measured_by: null,
    ro_measured_at: null,
    assigned_to: ME,
    sequence: null,
    work_started_at: null,
    ...over,
  } as ProjectOpening;
}

function unit(over: Partial<WorkUnit>): WorkUnit {
  return {
    id: "u",
    project_id: JOB,
    opening_id: null,
    created_by: ME,
    label: "16",
    type_label: "Slider",
    facts: {},
    revision: 1,
    created_at: "2026-10-01T00:00:00Z",
    updated_at: "2026-10-01T00:00:00Z",
    ...over,
  };
}

function session(over: Partial<WorkSession>): WorkSession {
  return {
    id: "s",
    profile_id: ME,
    shift_id: "sh",
    project_id: JOB,
    unit_id: "u",
    kind: "unit",
    participation: "install",
    stage: "Installing",
    description: "",
    outcome: null,
    delay_reason: "",
    started_at: "2026-10-06T14:00:00Z",
    ended_at: null,
    end_reason: null,
    revision: 1,
    ...over,
  };
}

function input(over: Partial<NextUpInput>): NextUpInput {
  return {
    userId: ME,
    now: NOW,
    jobId: JOB,
    myOpenings: [],
    jobOpenings: [],
    blockedIds: new Set(),
    units: [],
    sessions: [],
    active: null,
    ...over,
  };
}

describe("chooseNextUp (K1.2 / K1.4: running → yesterday → assigned → available → new)", () => {
  it("shows the running custom unit first, with its session", () => {
    const u = unit({ id: "u1" });
    const s = session({ id: "s1", unit_id: "u1" });
    const r = chooseNextUp(input({ units: [u], sessions: [s], active: s, myOpenings: [opening({ id: "o1" })] }));
    expect(r).toMatchObject({ kind: "running", source: "unit", unit: { id: "u1" } });
  });

  it("shows a plan opening that is genuinely in progress as running", () => {
    const o = opening({ id: "o1", work_started_at: new Date(NOW - 20 * 60_000).toISOString() });
    expect(chooseNextUp(input({ myOpenings: [o] }))).toMatchObject({ kind: "running", source: "opening", opening: { id: "o1" } });
  });

  it("a prep-time session (no unit) is not a running unit", () => {
    const s = session({ id: "s1", unit_id: null, kind: "idle", stage: "Idle time" });
    const o = opening({ id: "o1" });
    expect(chooseNextUp(input({ sessions: [s], active: s, myOpenings: [o] }))).toMatchObject({
      kind: "next",
      reason: "assigned",
      opening: { id: "o1" },
    });
  });

  it("yesterday's unfinished opening comes before anything newly assigned", () => {
    const stale = opening({ id: "old", opening_code: "W9", work_started_at: "2026-10-05T16:00:00Z" });
    const fresh = opening({ id: "new", opening_code: "W1" });
    expect(chooseNextUp(input({ myOpenings: [fresh, stale] }))).toMatchObject({
      kind: "next",
      source: "opening",
      opening: { id: "old" },
      reason: "yesterday",
    });
  });

  it("yesterday's unfinished custom unit is remembered by my own ended sessions", () => {
    const u = unit({ id: "u1", label: "12" });
    const done = session({ id: "s0", unit_id: "u1", started_at: "2026-10-05T15:00:00Z", ended_at: "2026-10-05T22:00:00Z", outcome: "partial" });
    expect(chooseNextUp(input({ units: [u], sessions: [done] }))).toMatchObject({ kind: "next", source: "unit", unit: { id: "u1" }, reason: "yesterday" });
  });

  it("a unit I finished yesterday is not offered again", () => {
    const u = unit({ id: "u1", facts: { installation_complete: "Yes" } });
    const done = session({ id: "s0", unit_id: "u1", started_at: "2026-10-05T15:00:00Z", ended_at: "2026-10-05T22:00:00Z", outcome: "finished" });
    expect(chooseNextUp(input({ units: [u], sessions: [done] }))).toEqual({ kind: "new" });
  });

  it("prefers today's job among assigned openings, then anywhere", () => {
    const elsewhere = opening({ id: "b1", project_id: "job-b", opening_code: "A1", sequence: 1 });
    const here = opening({ id: "a1", project_id: JOB, opening_code: "Z9", sequence: 9 });
    expect(chooseNextUp(input({ myOpenings: [elsewhere, here] }))).toMatchObject({ opening: { id: "a1" }, reason: "assigned" });
    expect(chooseNextUp(input({ jobId: null, myOpenings: [elsewhere, here] }))).toMatchObject({ opening: { id: "b1" } });
  });

  it("never points at a session-blocked opening", () => {
    const blocked = opening({ id: "o1", opening_code: "W1", sequence: 1 });
    const free = opening({ id: "o2", opening_code: "W2", sequence: 2 });
    expect(chooseNextUp(input({ myOpenings: [blocked, free], blockedIds: new Set(["o1"]) }))).toMatchObject({ opening: { id: "o2" } });
  });

  it("falls to an unassigned opening on this job, then a saved unit nobody is on", () => {
    const free = opening({ id: "f1", assigned_to: null });
    expect(chooseNextUp(input({ jobOpenings: [free] }))).toMatchObject({ opening: { id: "f1" }, reason: "available" });

    const u2 = unit({ id: "u2", label: "3" });
    const u1 = unit({ id: "u1", label: "12" });
    const busy = unit({ id: "u3", label: "1" });
    const others = session({ id: "x", profile_id: "someone", unit_id: "u3" });
    expect(chooseNextUp(input({ units: [u1, u2, busy], sessions: [others] }))).toMatchObject({
      kind: "next",
      source: "unit",
      unit: { id: "u2" },
      reason: "available",
    });
  });

  it("is a blank New unit only when nothing at all matches", () => {
    expect(chooseNextUp(input({}))).toEqual({ kind: "new" });
    // Saved units on ANOTHER job are not "available on this job".
    expect(chooseNextUp(input({ units: [unit({ id: "u9", project_id: "job-z" })] }))).toEqual({ kind: "new" });
  });
});
