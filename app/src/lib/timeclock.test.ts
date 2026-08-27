import { describe, expect, it } from "vitest";
import {
  breakTypeLabel,
  currentBreakSeconds,
  elapsedWorkSeconds,
  formatClock,
  punchDay,
  shiftHours,
  shiftsToExportRows,
  startOfWeekIso,
  type TimeShift,
} from "./timeclock";

function shift(partial: Partial<TimeShift>): TimeShift {
  return {
    id: "s1",
    profile_id: "p1",
    project_id: "j1",
    cost_code_id: null,
    clock_in_at: "2026-01-05T08:00:00Z",
    clock_out_at: null,
    break_seconds: 0,
    break_started_at: null,
    injured: false,
    time_confirmed: true,
    status: "open",
    created_at: "2026-01-05T08:00:00Z",
    ...partial,
  };
}

describe("shiftHours", () => {
  it("returns 0 for an open shift", () => {
    expect(shiftHours(shift({}))).toBe(0);
  });
  it("subtracts break time from clocked span", () => {
    const s = shift({ clock_out_at: "2026-01-05T16:00:00Z", break_seconds: 1800 }); // 8h - 0.5h
    expect(shiftHours(s)).toBeCloseTo(7.5, 5);
  });
});

describe("currentBreakSeconds", () => {
  it("includes a running break based on break_started_at", () => {
    const now = new Date("2026-01-05T10:00:00Z").getTime();
    const s = shift({ break_seconds: 600, break_started_at: "2026-01-05T09:55:00Z" });
    expect(currentBreakSeconds(s, now)).toBe(600 + 300); // 5 min running
  });
  it("returns stored break when not currently on break", () => {
    const s = shift({ break_seconds: 900, break_started_at: null });
    expect(currentBreakSeconds(s, Date.now())).toBe(900);
  });
});

describe("elapsedWorkSeconds", () => {
  it("counts wall time minus break for an open shift", () => {
    const now = new Date("2026-01-05T10:00:00Z").getTime(); // 2h after clock-in
    const s = shift({ break_seconds: 600 }); // 10 min banked break
    expect(elapsedWorkSeconds(s, now)).toBe(7200 - 600);
  });
  it("freezes while on a running break", () => {
    const now = new Date("2026-01-05T10:00:00Z").getTime();
    const before = shift({ break_started_at: "2026-01-05T09:50:00Z" });
    // 2h gross - 10 min running break = 6600s, and it does not grow with `now`
    expect(elapsedWorkSeconds(before, now)).toBe(7200 - 600);
    const later = new Date("2026-01-05T10:05:00Z").getTime();
    expect(elapsedWorkSeconds(before, later)).toBe(elapsedWorkSeconds(before, now));
  });
});

describe("formatClock", () => {
  it("formats H:MM:SS with zero padding", () => {
    expect(formatClock(0)).toBe("0:00:00");
    expect(formatClock(65)).toBe("0:01:05");
    expect(formatClock(3661)).toBe("1:01:01");
  });
  it("never returns negatives", () => {
    expect(formatClock(-50)).toBe("0:00:00");
  });
});

describe("breakTypeLabel", () => {
  it("maps known types and falls back", () => {
    expect(breakTypeLabel("lunch")).toBe("Lunch");
    expect(breakTypeLabel("rest")).toBe("Rest");
    expect(breakTypeLabel(null)).toBe("Break");
  });
});

describe("shiftsToExportRows (T7: one shared export mapping)", () => {
  const fmt = (iso: string) =>
    new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

  it("maps a closed shift's fields, including every joined table", () => {
    const s = shift({
      clock_out_at: "2026-01-05T16:00:00Z",
      profiles: { display_name: "Alex Rivera" },
      projects: { job_code: "W-1001", name: "Job" },
      cost_codes: { code: "100", label: "Install" },
      status: "approved",
    });
    const [row] = shiftsToExportRows([s]);
    expect(row.employee).toBe("Alex Rivera");
    expect(row.day).toBe(punchDay(s.clock_in_at));
    expect(row.start).toBe(fmt(s.clock_in_at));
    expect(row.end).toBe(fmt(s.clock_out_at!));
    expect(row.hours).toBe(shiftHours(s));
    expect(row.job).toBe("W-1001");
    expect(row.costCode).toBe("100 - Install");
    expect(row.status).toBe("approved");
  });

  it("leaves end blank for a still-open shift, rather than formatting null", () => {
    const [row] = shiftsToExportRows([shift({})]);
    expect(row.end).toBe("");
  });

  it("falls back to the given name and a dash/em-dash when joins are missing", () => {
    const [row] = shiftsToExportRows([shift({ project_id: null })], "Fallback Name");
    expect(row.employee).toBe("Fallback Name");
    expect(row.job).toBe("—");
    expect(row.costCode).toBe("-");
  });

  it("defaults the fallback name to Crew when none is given", () => {
    const [row] = shiftsToExportRows([shift({})]);
    expect(row.employee).toBe("Crew");
  });
});

describe("startOfWeekIso", () => {
  it("returns a Monday at midnight as ISO", () => {
    const iso = startOfWeekIso();
    const d = new Date(iso);
    expect(d.getDay()).toBe(1); // Monday
    expect(d.getHours()).toBe(0);
    expect(d.getMinutes()).toBe(0);
  });
});
