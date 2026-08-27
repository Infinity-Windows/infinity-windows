import { describe, expect, it } from "vitest";
import {
  buildDayMemory,
  dayMemoryFallbackLine,
  type DayMemoryAssignment,
  type DayMemoryInput,
  type DayMemoryLogRow,
  type DayMemoryProfile,
  type DayMemoryProject,
  type DayMemoryShift,
} from "./dayMemory";

const DATE = "2026-08-20";
const OTHER_DATE = "2026-08-21";

/**
 * An instant built from LOCAL calendar fields (year, month, day, hour), not
 * a UTC-anchored "...Z" literal — the same reason dailyLogDay.test.ts pins
 * its instants this way: a Z-suffixed literal lands on a different local
 * day depending on the machine's timezone, which is exactly the kind of
 * flake this file's own subject (local-day bucketing) exists to prevent.
 * Hours are chosen nowhere near a local-midnight boundary unless a test is
 * specifically about crossing one.
 */
function localTime(y: number, m: number, d: number, h: number, min = 0): string {
  return new Date(y, m - 1, d, h, min, 0).toISOString();
}

const profiles: DayMemoryProfile[] = [
  { id: "p-ammon", display_name: "Ammon" },
  { id: "p-jess", display_name: "Jess" },
  { id: "p-taylor", display_name: "Taylor" },
];

const projects: DayMemoryProject[] = [
  { id: "j-black22", job_code: "BLACK22", name: "Black Desert Lot 22" },
  { id: "j-oakridge", job_code: "OAKRIDGE", name: "Oak Ridge" },
];

function baseInput(overrides: Partial<DayMemoryInput> = {}): DayMemoryInput {
  return {
    assignments: [],
    shifts: [],
    sessions: [],
    logs: [],
    profiles,
    projects,
    now: new Date(2026, 7, 20, 20, 0, 0),
    ...overrides,
  };
}

function assignment(overrides: Partial<DayMemoryAssignment> = {}): DayMemoryAssignment {
  return {
    id: "a-1",
    kind: "install",
    project_id: "j-black22",
    start_date: DATE,
    end_date: DATE,
    status: "published",
    members: [{ profile_id: "p-ammon" }],
    ...overrides,
  };
}

function shift(overrides: Partial<DayMemoryShift> = {}): DayMemoryShift {
  return {
    profile_id: "p-ammon",
    project_id: "j-black22",
    clock_in_at: localTime(2026, 8, 20, 8),
    clock_out_at: localTime(2026, 8, 20, 16),
    break_seconds: 0,
    status: "approved",
    ...overrides,
  };
}

describe("buildDayMemory", () => {
  it("returns no jobs and no deliveries for a day nothing touched", () => {
    const memory = buildDayMemory(DATE, baseInput());
    expect(memory).toEqual({ date: DATE, jobs: [], deliveries: [] });
  });

  it("assembles assigned, worked, unitsFinished and log for one job", () => {
    const memory = buildDayMemory(
      DATE,
      baseInput({
        assignments: [assignment({ members: [{ profile_id: "p-ammon" }, { profile_id: "p-jess" }] })],
        shifts: [shift()],
        sessions: [
          {
            project_id: "j-black22",
            opening_id: "op-1",
            started_at: localTime(2026, 8, 20, 12),
            end_reason: "finish",
          },
        ],
        logs: [
          {
            project_id: "j-black22",
            log_date: DATE,
            headline: "3 units in",
            notes: "Good day.",
            day_flow: "smooth",
          },
        ],
      }),
    );

    expect(memory.jobs).toHaveLength(1);
    const entry = memory.jobs[0];
    expect(entry.projectId).toBe("j-black22");
    expect(entry.jobCode).toBe("BLACK22");
    expect(entry.assigned).toEqual(["Ammon", "Jess"]);
    expect(entry.worked).toEqual([{ profileId: "p-ammon", name: "Ammon", hours: 8 }]);
    expect(entry.unitsFinished).toBe(1);
    expect(entry.log).toEqual({ headline: "3 units in", notes: "Good day.", day_flow: "smooth" });
  });

  it("shows the honest diff: someone assigned who never punched in, and someone who worked unassigned", () => {
    const memory = buildDayMemory(
      DATE,
      baseInput({
        assignments: [assignment({ members: [{ profile_id: "p-ammon" }] })],
        shifts: [shift({ profile_id: "p-jess" })],
      }),
    );
    const entry = memory.jobs[0];
    expect(entry.assigned).toEqual(["Ammon"]);
    expect(entry.worked.map((w) => w.name)).toEqual(["Jess"]);
  });

  it("excludes canceled assignments from assigned", () => {
    const memory = buildDayMemory(
      DATE,
      baseInput({ assignments: [assignment({ status: "canceled" })] }),
    );
    expect(memory.jobs).toHaveLength(0);
  });

  it("excludes voided shifts from worked", () => {
    const memory = buildDayMemory(
      DATE,
      baseInput({ shifts: [shift({ status: "voided" })] }),
    );
    expect(memory.jobs).toHaveLength(0);
  });

  it("counts a multi-day assignment as assigned on every day it spans", () => {
    const memory = buildDayMemory(
      DATE,
      baseInput({
        assignments: [assignment({ start_date: "2026-08-18", end_date: "2026-08-22" })],
      }),
    );
    expect(memory.jobs[0]?.assigned).toEqual(["Ammon"]);
  });

  it("splits a shift crossing local midnight across both days it touches", () => {
    const crossing = shift({
      clock_in_at: localTime(2026, 8, 20, 22),
      clock_out_at: localTime(2026, 8, 21, 6),
    });
    const day1 = buildDayMemory(DATE, baseInput({ shifts: [crossing] }));
    const day2 = buildDayMemory(OTHER_DATE, baseInput({ shifts: [crossing] }));
    // 8 total hours on the shift (22:00 -> 06:00), split at local midnight:
    // 2h on day1, 6h on day2.
    expect(day1.jobs[0]?.worked[0]?.hours).toBeCloseTo(2, 1);
    expect(day2.jobs[0]?.worked[0]?.hours).toBeCloseTo(6, 1);
  });

  it("charges the break only to the shift's clock-in day, not a day it merely spills into", () => {
    const crossing = shift({
      clock_in_at: localTime(2026, 8, 20, 22),
      clock_out_at: localTime(2026, 8, 21, 6),
      break_seconds: 1800, // 30 min
    });
    const day1 = buildDayMemory(DATE, baseInput({ shifts: [crossing] }));
    const day2 = buildDayMemory(OTHER_DATE, baseInput({ shifts: [crossing] }));
    // 2h on day1 minus the 30-min break = 1.5h; 6h on day2, break untouched.
    expect(day1.jobs[0]?.worked[0]?.hours).toBeCloseTo(1.5, 1);
    expect(day2.jobs[0]?.worked[0]?.hours).toBeCloseTo(6, 1);
  });

  it("uses `now` to value a still-open shift", () => {
    const memory = buildDayMemory(
      DATE,
      baseInput({
        shifts: [shift({ clock_out_at: null })],
        now: new Date(2026, 7, 20, 12, 0, 0),
      }),
    );
    // 08:00 -> 12:00 = 4h.
    expect(memory.jobs[0]?.worked[0]?.hours).toBeCloseTo(4, 1);
  });

  it("counts unitsFinished as distinct openings, not sessions", () => {
    const memory = buildDayMemory(
      DATE,
      baseInput({
        sessions: [
          { project_id: "j-black22", opening_id: "op-1", started_at: localTime(2026, 8, 20, 9), end_reason: "finish" },
          // A redo-and-refinish on the same opening, same day: still one unit.
          { project_id: "j-black22", opening_id: "op-1", started_at: localTime(2026, 8, 20, 14), end_reason: "finish" },
          { project_id: "j-black22", opening_id: "op-2", started_at: localTime(2026, 8, 20, 9), end_reason: "block" },
        ],
      }),
    );
    expect(memory.jobs[0]?.unitsFinished).toBe(1);
  });

  it("ignores a session on a different local day", () => {
    const memory = buildDayMemory(
      DATE,
      baseInput({
        sessions: [
          { project_id: "j-black22", opening_id: "op-1", started_at: localTime(2026, 8, 21, 9), end_reason: "finish" },
        ],
      }),
    );
    expect(memory.jobs).toHaveLength(0);
  });

  it("matches a log only to its own log_date, even when a wider range was fetched", () => {
    const logs: DayMemoryLogRow[] = [
      { project_id: "j-black22", log_date: OTHER_DATE, headline: "wrong day", notes: "n", day_flow: null },
    ];
    const memory = buildDayMemory(DATE, baseInput({ logs }));
    expect(memory.jobs).toHaveLength(0);
  });

  it("routes a delivery assignment to `deliveries`, never into `jobs`", () => {
    const memory = buildDayMemory(
      DATE,
      baseInput({
        assignments: [
          assignment({
            id: "a-truck",
            kind: "delivery",
            project_id: null,
            members: [{ profile_id: "p-taylor" }],
            delivery: { id: "d-1", label: "Truck from ABC Glass" },
          }),
        ],
      }),
    );
    expect(memory.jobs).toHaveLength(0);
    expect(memory.deliveries).toEqual([
      { assignmentId: "a-truck", label: "Truck from ABC Glass", memberNames: ["Taylor"] },
    ]);
  });

  it("sorts jobs by job code and names within a job alphabetically", () => {
    const memory = buildDayMemory(
      DATE,
      baseInput({
        assignments: [
          assignment({ id: "a-1", project_id: "j-oakridge", members: [{ profile_id: "p-taylor" }] }),
          assignment({ id: "a-2", project_id: "j-black22", members: [{ profile_id: "p-jess" }, { profile_id: "p-ammon" }] }),
        ],
      }),
    );
    expect(memory.jobs.map((j) => j.jobCode)).toEqual(["BLACK22", "OAKRIDGE"]);
    expect(memory.jobs[0]?.assigned).toEqual(["Ammon", "Jess"]);
  });
});

describe("dayMemoryFallbackLine", () => {
  it("says nothing happened when there's no assigned, worked or log", () => {
    expect(dayMemoryFallbackLine({ assigned: [], worked: [], unitsFinished: 0 })).toBe(
      "No day record.",
    );
  });

  it("says nobody punched in when assigned but not worked", () => {
    expect(dayMemoryFallbackLine({ assigned: ["Ammon"], worked: [], unitsFinished: 0 })).toBe(
      "Assigned, but no crew punched in.",
    );
  });

  it("gives an auto factual line when crew worked but nobody logged it", () => {
    const line = dayMemoryFallbackLine({
      assigned: ["Ammon", "Jess", "Taylor"],
      worked: [
        { profileId: "p-ammon", name: "Ammon", hours: 8 },
        { profileId: "p-jess", name: "Jess", hours: 7.5 },
        { profileId: "p-taylor", name: "Taylor", hours: 6 },
      ],
      unitsFinished: 4,
    });
    expect(line).toBe("3 crew · 21.5h — 4 units finished");
  });

  it("singularizes one unit finished", () => {
    const line = dayMemoryFallbackLine({
      assigned: [],
      worked: [{ profileId: "p-ammon", name: "Ammon", hours: 2 }],
      unitsFinished: 1,
    });
    expect(line).toBe("1 crew · 2h — 1 unit finished");
  });
});
