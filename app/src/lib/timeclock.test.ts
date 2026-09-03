import { beforeEach, describe, expect, it, vi } from "vitest";
import type { JobMode } from "./types";

// clockIn is the only function here that talks to the database; the rest are
// pure. Mock just supabase.rpc — indirected through `rpc` the same way
// liveProjects.test.ts does, so the factory closes over the spy safely.
const rpc = vi.fn();
vi.mock("./supabase", () => ({
  supabase: { rpc: (...args: unknown[]) => rpc(...args) },
  supabaseConfigured: true,
}));

import {
  addDays,
  breakTypeLabel,
  clockIn,
  currentBreakSeconds,
  elapsedWorkSeconds,
  formatClock,
  previousPayPeriod,
  punchDay,
  shiftHours,
  shiftsToExportRows,
  startOfWeekIso,
  summarizeByJobCostCode,
  timecardRange,
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

describe("summarizeByJobCostCode (slice 3: the service billing basis)", () => {
  // Two jobs, three cost codes, closed shifts of known lengths.
  const cedar = { job_code: "W-1001", name: "Cedar Ridge" };
  const oak = { job_code: "W-2002", name: "Oak Park" };
  const serviceCode = { code: "500", label: "Service call" };
  const warrantyCode = { code: "600", label: "Warranty" };

  function closed(hours: number, partial: Partial<TimeShift>): TimeShift {
    const start = "2026-01-05T08:00:00Z";
    const end = new Date(new Date(start).getTime() + hours * 3_600_000).toISOString();
    return shift({ clock_in_at: start, clock_out_at: end, status: "approved", ...partial });
  }

  it("splits hours by job AND by cost code, and totals them", () => {
    const report = summarizeByJobCostCode([
      closed(6, { project_id: "cedar", projects: cedar, cost_code_id: "svc", cost_codes: serviceCode }),
      closed(2, { project_id: "cedar", projects: cedar, cost_code_id: "war", cost_codes: warrantyCode }),
      closed(4, { project_id: "oak", projects: oak, cost_code_id: "svc", cost_codes: serviceCode }),
    ]);

    expect(report.totalHours).toBe(12);
    expect(report.shiftCount).toBe(3);
    // Cedar (8h) sorts ahead of Oak (4h).
    expect(report.jobs.map((j) => j.jobKey)).toEqual(["cedar", "oak"]);

    const cedarJob = report.jobs.find((j) => j.jobKey === "cedar")!;
    expect(cedarJob.hours).toBe(8);
    expect(cedarJob.jobCode).toBe("W-1001");
    // Service call (6h) ahead of Warranty (2h).
    expect(cedarJob.costCodes.map((c) => [c.code, c.hours])).toEqual([
      ["500", 6],
      ["600", 2],
    ]);
  });

  it("sums repeated shifts on the same job+code into one line", () => {
    const report = summarizeByJobCostCode([
      closed(3, { project_id: "cedar", projects: cedar, cost_code_id: "svc", cost_codes: serviceCode }),
      closed(5, { project_id: "cedar", projects: cedar, cost_code_id: "svc", cost_codes: serviceCode }),
    ]);
    const cedarJob = report.jobs[0];
    expect(cedarJob.costCodes).toHaveLength(1);
    expect(cedarJob.costCodes[0].hours).toBe(8);
    expect(cedarJob.costCodes[0].shiftCount).toBe(2);
  });

  it("buckets a shift with no job / no cost code rather than dropping it", () => {
    const report = summarizeByJobCostCode([
      closed(2, { project_id: null, projects: null, cost_code_id: null, cost_codes: null }),
    ]);
    expect(report.jobs).toHaveLength(1);
    expect(report.jobs[0].jobKey).toBe("unassigned");
    expect(report.jobs[0].costCodes[0].costCodeKey).toBe("none");
    expect(report.jobs[0].hours).toBe(2);
  });

  it("counts an open (unfinished) shift as zero hours, never a bill", () => {
    const report = summarizeByJobCostCode([
      shift({ project_id: "cedar", projects: cedar, cost_code_id: "svc", cost_codes: serviceCode }),
    ]);
    expect(report.totalHours).toBe(0);
    expect(report.jobs[0].hours).toBe(0);
    expect(report.jobs[0].costCodes[0].shiftCount).toBe(1);
  });
});

describe("previousPayPeriod (T8 sign-off)", () => {
  it("returns exactly the 14 days before the current period, never the running one", () => {
    const anchor = new Date(2026, 0, 20); // inside the pay period starting Jan 19
    const current = timecardRange("pay", anchor);
    const prev = previousPayPeriod(anchor);
    expect(prev.start.getTime()).toBeLessThan(current.start.getTime());
    expect(addDays(prev.start, 14).getTime()).toBe(current.start.getTime());
  });

  it("agrees with timecardRange('pay', ...) for a date inside that prior period", () => {
    const anchor = new Date(2026, 0, 20);
    const prev = previousPayPeriod(anchor);
    const recomputed = timecardRange("pay", addDays(prev.start, 3));
    expect(recomputed.startIso).toBe(prev.startIso);
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

// The actual write of job_mode to the shift (standard-tracking-jobs slice 2).
// These guard the RPC wiring itself: mocking the whole clockIn wrapper (as the
// ClockInBlock test does) would let a broken payload pass, so we assert on the
// exact args reaching supabase.rpc. The missing-overload error shape is the one
// isMissingClockInOverload recognises (PGRST202) so the fallback chain runs.
describe("clockIn (mode-carrying path, slice 2)", () => {
  const MISSING = { code: "PGRST202", message: "Could not find the function" };

  beforeEach(() => {
    rpc.mockReset();
  });

  it("sends the picked mode to clock_in as p_mode, alongside the note", async () => {
    const returned = shift({});
    rpc.mockResolvedValueOnce({ data: returned, error: null });

    const out = await clockIn("j1", "cc1", { lat: 1, lng: 2 }, "  morning  ", "tracking");

    expect(rpc).toHaveBeenCalledTimes(1);
    const [fn, payload] = rpc.mock.calls[0];
    expect(fn).toBe("clock_in");
    // The write that would silently vanish if p_mode were renamed, dropped, or
    // the whole cleanMode branch deleted.
    expect(payload).toMatchObject({
      p_project_id: "j1",
      p_cost_code_id: "cc1",
      p_lat: 1,
      p_lng: 2,
      p_note: "morning",
      p_mode: "tracking",
    });
    expect(out).toBe(returned);
  });

  it("falls back mode+note -> note-only -> bare punch when the overload is missing", async () => {
    rpc.mockResolvedValueOnce({ data: null, error: MISSING }); // mode+note overload absent
    rpc.mockResolvedValueOnce({ data: null, error: MISSING }); // note-only overload absent
    const returned = shift({});
    rpc.mockResolvedValueOnce({ data: returned, error: null }); // bare punch works

    const out = await clockIn("j1", null, undefined, "hello", "data");

    expect(rpc).toHaveBeenCalledTimes(3);
    // 1st carries both note and mode.
    expect(rpc.mock.calls[0][1]).toMatchObject({ p_note: "hello", p_mode: "data" });
    // 2nd drops the mode but keeps the note.
    expect(rpc.mock.calls[1][1]).toHaveProperty("p_note", "hello");
    expect(rpc.mock.calls[1][1]).not.toHaveProperty("p_mode");
    // 3rd is a bare punch: neither note nor mode.
    expect(rpc.mock.calls[2][1]).not.toHaveProperty("p_note");
    expect(rpc.mock.calls[2][1]).not.toHaveProperty("p_mode");
    expect(out).toBe(returned);
  });

  it("throws a non-missing-overload error instead of quietly falling back", async () => {
    const real = { code: "P0001", message: "complete today's toolbox talk before clocking in" };
    rpc.mockResolvedValueOnce({ data: null, error: real });

    await expect(clockIn("j1", null, undefined, "note", "tracking")).rejects.toBe(real);
    expect(rpc).toHaveBeenCalledTimes(1); // no fallback on a real error
  });

  it("leaves a single-mode punch on the note-only path, with no p_mode key", async () => {
    rpc.mockResolvedValueOnce({ data: shift({}), error: null });

    await clockIn("j1", null, undefined, "note", null);

    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc.mock.calls[0][1]).toHaveProperty("p_note", "note");
    expect(rpc.mock.calls[0][1]).not.toHaveProperty("p_mode");
  });

  it("ignores an unrecognised mode rather than sending it", async () => {
    rpc.mockResolvedValueOnce({ data: shift({}), error: null });

    await clockIn("j1", null, undefined, null, "bogus" as unknown as JobMode);

    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc.mock.calls[0][1]).not.toHaveProperty("p_mode");
    // note normalised to null when blank/absent
    expect(rpc.mock.calls[0][1]).toHaveProperty("p_note", null);
  });
});
