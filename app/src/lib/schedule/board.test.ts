import { describe, expect, it } from "vitest";
import {
  boardChips,
  boardLanes,
  boardWeek,
  chipsByPersonDay,
  copyWeekForward,
  coverageReport,
  dedupeProposals,
  outsideWindowEntries,
  repeatLastWorkedDay,
} from "./board";
import type { ScheduleAssignment } from "./types";
import type { Profile } from "../install/types";

const prof = (id: string, name: string, role: Profile["role"], active = true): Profile => ({
  id,
  display_name: name,
  skill_level: 3,
  role,
  active,
});

const asg = (over: Partial<ScheduleAssignment>): ScheduleAssignment =>
  ({
    id: "a1",
    project_id: "p1",
    start_date: "2026-08-10",
    end_date: "2026-08-12",
    start_time: null,
    status: "draft",
    color: null,
    note: null,
    created_by: null,
    published_at: null,
    created_at: "",
    updated_at: "",
    members: [
      { profile_id: "ben", role: "foreman" },
      { profile_id: "chris", role: "installer" },
    ],
    ...over,
  }) as ScheduleAssignment;

describe("boardWeek + lanes", () => {
  it("always a Monday-first week from any anchor", () => {
    expect(boardWeek("2026-08-13")[0]).toBe("2026-08-10"); // Thu -> Mon
    expect(boardWeek("2026-08-10")).toHaveLength(7);
  });

  it("foremen band first, alphabetical within bands, inactive dropped", () => {
    const lanes = boardLanes([
      prof("z", "Zed", "installer"),
      prof("a", "Ava", "installer"),
      prof("t", "Taylor", "foreman"),
      prof("gone", "Ghost", "installer", false),
    ]);
    expect(lanes.map((l) => l.name)).toEqual(["Taylor", "Ava", "Zed"]);
    expect(lanes[0].isLead).toBe(true);
  });
});

describe("boardChips (blocks -> person-days)", () => {
  it("a 3-day block with 2 members is six chips, clipped to the week", () => {
    const week = boardWeek("2026-08-10");
    const chips = boardChips([asg({})], week);
    expect(chips).toHaveLength(6);
    const cell = chipsByPersonDay(chips).get("ben|2026-08-11");
    expect(cell).toHaveLength(1);
    expect(cell![0].projectId).toBe("p1");
  });

  it("a block outside the week produces nothing", () => {
    const chips = boardChips(
      [asg({ start_date: "2026-09-01", end_date: "2026-09-02" })],
      boardWeek("2026-08-10"),
    );
    expect(chips).toHaveLength(0);
  });

  // Wave A3: the "AI proposed" chip reads createdVia straight off the chip —
  // this is the only place that field is populated from the assignment.
  it("carries created_via through as createdVia, for the AI-proposed chip", () => {
    const week = boardWeek("2026-08-10");
    const aiChips = boardChips([asg({ created_via: "ai" })], week);
    expect(aiChips.every((c) => c.createdVia === "ai")).toBe(true);

    const humanChips = boardChips([asg({})], week);
    expect(humanChips.every((c) => c.createdVia === null)).toBe(true);
  });
});

describe("coverageReport", () => {
  const jobs = [
    { id: "p1", job_code: "BLACK22", name: "Black Desert", start_date: "2026-08-13" },
    { id: "p2", job_code: "ZZTEST", name: "Test", start_date: "2026-08-12" },
    { id: "p3", job_code: "FAR", name: "Far off", start_date: "2026-12-01" },
    { id: "p4", job_code: "NODATE", name: "No date", start_date: null },
  ];

  it("upcoming = starts within 21 days; covered needs crew today-or-later", () => {
    const r = coverageReport(jobs, [asg({ project_id: "p1" })], "2026-08-10");
    expect(r.upcoming.map((j) => j.job_code)).toEqual(["ZZTEST", "BLACK22"]);
    expect(r.covered.map((j) => j.job_code)).toEqual(["BLACK22"]);
    expect(r.uncovered.map((j) => j.job_code)).toEqual(["ZZTEST"]);
    // ZZTEST starts in 2 days: an incident, not a reminder.
    expect(r.imminent.map((j) => j.job_code)).toEqual(["ZZTEST"]);
  });

  it("crew entirely in the past does not cover a future start", () => {
    const past = asg({ project_id: "p1", start_date: "2026-08-01", end_date: "2026-08-05" });
    const r = coverageReport(jobs, [past], "2026-08-10");
    expect(r.uncovered.map((j) => j.job_code)).toContain("BLACK22");
  });
});

describe("outsideWindowEntries", () => {
  const jobs = [
    { id: "p1", job_code: "BLACK22", start_date: "2026-08-11", end_date: "2026-08-20" },
    { id: "p2", job_code: "OPEN", start_date: "2026-08-11", end_date: null },
    { id: "p3", job_code: "NOWIN", start_date: null, end_date: null },
  ];

  it("flags before-start and past-completion; silent without a window", () => {
    const early = asg({ id: "e", project_id: "p1", start_date: "2026-08-09", end_date: "2026-08-10" });
    const late = asg({ id: "l", project_id: "p1", start_date: "2026-08-19", end_date: "2026-08-22" });
    const noWin = asg({ id: "n", project_id: "p3" });
    const entries = outsideWindowEntries([early, late, noWin], jobs);
    expect(entries.map((e) => e.assignmentId)).toEqual(["e", "l"]);
    expect(entries[0].detail).toMatch(/before the job's target start/);
  });

  it("an open-ended window is unbounded on the right", () => {
    const late = asg({ id: "l", project_id: "p2", start_date: "2026-09-01", end_date: "2026-09-09" });
    expect(outsideWindowEntries([late], jobs)).toHaveLength(0);
  });
});

describe("seeding (propose, never auto-commit)", () => {
  const names = new Map([
    ["ben", "Ben"],
    ["chris", "Chris"],
  ]);
  const codes = new Map([
    ["p1", "BLACK22"],
    ["p2", "PECAN14"],
  ]);

  it("repeat-yesterday keeps a split day split - both jobs proposed", () => {
    const out = repeatLastWorkedDay(
      [
        { profile_id: "ben", project_id: "p1", clock_in_at: "2026-08-10T13:00:00Z" },
        { profile_id: "ben", project_id: "p2", clock_in_at: "2026-08-10T19:00:00Z" },
        { profile_id: "chris", project_id: "p1", clock_in_at: "2026-08-08T13:00:00Z" }, // older day: ignored
      ],
      names,
      codes,
      "2026-08-11",
    );
    expect(out).toHaveLength(2);
    expect(out.map((p) => p.jobCode).sort()).toEqual(["BLACK22", "PECAN14"]);
    expect(out.every((p) => p.day === "2026-08-11")).toBe(true);
  });

  it("copy-week-forward shifts the PLAN by 7 days, weekday preserved", () => {
    const chips = boardChips([asg({})], boardWeek("2026-08-10"));
    const out = copyWeekForward(chips, names, codes);
    expect(out[0].day).toBe("2026-08-17");
    expect(out).toHaveLength(6);
  });

  it("dedupe makes re-running a seed idempotent, not additive", () => {
    const chips = boardChips([asg({})], boardWeek("2026-08-10"));
    const proposals = copyWeekForward(chips, names, codes);
    const nextWeekBlock = asg({
      id: "a2",
      start_date: "2026-08-17",
      end_date: "2026-08-17",
      members: [{ profile_id: "ben", role: "foreman" }],
    });
    const { fresh, skipped } = dedupeProposals(proposals, [nextWeekBlock]);
    expect(skipped).toBe(1); // ben's Monday already planned
    expect(fresh.some((p) => p.personId === "ben" && p.day === "2026-08-17")).toBe(false);
  });
});
