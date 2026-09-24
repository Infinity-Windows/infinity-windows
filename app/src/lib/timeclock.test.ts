import { beforeEach, describe, expect, it, vi } from "vitest";
import type { JobMode } from "./types";

// clockIn and listTeamShifts are the functions here that talk to the database;
// the rest are pure. Mock supabase.rpc and supabase.from — indirected through
// spies the same way liveProjects.test.ts does, so the factory closes over them
// safely. `from` returns a chainable stub whose terminal `.range()` resolves to
// whatever `rangeResult` is told to give for that page.
const rpc = vi.fn();
const range = vi.fn();
const queryFilter = vi.fn();
vi.mock("./supabase", () => {
  const builder: Record<string, unknown> = {};
  for (const m of ["select", "gte", "lt", "neq", "order", "eq", "is", "limit"]) {
    builder[m] = (...args: unknown[]) => { queryFilter(m, ...args); return builder; };
  }
  builder.range = (...args: unknown[]) => range(...args);
  return {
    supabase: {
      rpc: (...args: unknown[]) => rpc(...args),
      from: () => builder,
    },
    supabaseConfigured: true,
  };
});

import {
  addDays,
  breakTypeLabel,
  clockIn,
  listTeamShifts,
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

  it("falls back keyed+mode -> keyed+note -> keyed only when an overload is missing, never to an unkeyed punch", async () => {
    // Release 0 (K0.2): every rung of the ladder carries the tap's one-time
    // id. The old bottom rung — a bare, unkeyed punch — is gone on purpose:
    // an unkeyed clock-in is the double punch this release exists to end.
    rpc.mockResolvedValueOnce({ data: null, error: MISSING }); // 20261028000000 not applied
    rpc.mockResolvedValueOnce({ data: null, error: MISSING }); // client_id + note overload absent
    const returned = shift({});
    rpc.mockResolvedValueOnce({ data: returned, error: null }); // client_id-only overload works

    const out = await clockIn("j1", null, undefined, "hello", "data");

    expect(rpc).toHaveBeenCalledTimes(3);
    const id = (rpc.mock.calls[0][1] as { p_client_id: string }).p_client_id;
    expect(id).toEqual(expect.any(String));
    // 1st carries id, note, mode and the tap time.
    expect(rpc.mock.calls[0][1]).toMatchObject({ p_note: "hello", p_mode: "data", p_client_id: id });
    expect(rpc.mock.calls[0][1]).toHaveProperty("p_tapped_at");
    // 2nd drops the mode and the tap time but keeps the note — and the SAME id.
    expect(rpc.mock.calls[1][1]).toMatchObject({ p_note: "hello", p_client_id: id });
    expect(rpc.mock.calls[1][1]).not.toHaveProperty("p_mode");
    expect(rpc.mock.calls[1][1]).not.toHaveProperty("p_tapped_at");
    // 3rd keeps only the id: neither note nor mode, still never unkeyed.
    expect(rpc.mock.calls[2][1]).toMatchObject({ p_client_id: id });
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

  it("sends a single-mode punch through the same keyed overload, with p_mode null", async () => {
    // Before Release 0 a null mode took a different overload (note-only). The
    // keyed overload takes p_mode itself, so null is simply sent as null and the
    // server stores nothing — the same result by one path instead of two.
    rpc.mockResolvedValueOnce({ data: shift({}), error: null });

    await clockIn("j1", null, undefined, "note", null);

    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc.mock.calls[0][1]).toHaveProperty("p_note", "note");
    expect(rpc.mock.calls[0][1]).toHaveProperty("p_mode", null);
    expect(rpc.mock.calls[0][1]).toHaveProperty("p_client_id", expect.any(String));
  });

  it("ignores an unrecognised mode rather than sending it", async () => {
    rpc.mockResolvedValueOnce({ data: shift({}), error: null });

    await clockIn("j1", null, undefined, null, "bogus" as unknown as JobMode);

    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc.mock.calls[0][1]).toHaveProperty("p_mode", null);
    // note normalised to null when blank/absent
    expect(rpc.mock.calls[0][1]).toHaveProperty("p_note", null);
  });
});

// ---------------------------------------------------------------------------
// listTeamShifts pages; it does not cap
// ---------------------------------------------------------------------------
// WHY THIS IS TESTED: this array becomes the Gusto file the office uploads to
// payroll. It used to be one .limit(1000) read, and because the sort is
// newest-first, the punches a cap dropped were the OLDEST — silently shorting
// the first of a pay period's two weeks in a file nobody could see was short.
describe("listTeamShifts", () => {
  const page = (n: number, offset = 0) =>
    Array.from({ length: n }, (_, i) => ({ id: `s${offset + i}` }));

  beforeEach(() => {
    range.mockReset();
    queryFilter.mockReset();
  });

  it("keeps reading until it has every punch the count says exist", async () => {
    range
      .mockResolvedValueOnce({ data: page(1000, 0), error: null, count: 2037 })
      .mockResolvedValueOnce({ data: page(1000, 1000), error: null, count: 2037 })
      .mockResolvedValueOnce({ data: page(37, 2000), error: null, count: 2037 });

    const rows = await listTeamShifts("2026-08-24T00:00:00Z", "2026-09-07T00:00:00Z");

    expect(rows).toHaveLength(2037);
    // Each window starts where the last one ended, so nothing is skipped.
    expect(range.mock.calls).toEqual([
      [0, 999],
      [1000, 1999],
      [2000, 2999],
    ]);
    // The oldest punch in the period — the one the old cap would have eaten.
    expect(rows[rows.length - 1]).toEqual({ id: "s2036" });
  });

  it("does not read a server's own row ceiling as the end of the period", async () => {
    // PostgREST can hand back fewer rows than were asked for. Treating that as
    // "that's all of them" is exactly how the old cap hid itself; the count is
    // what settles it.
    range
      .mockResolvedValueOnce({ data: page(500, 0), error: null, count: 1012 })
      .mockResolvedValueOnce({ data: page(500, 500), error: null, count: 1012 })
      .mockResolvedValueOnce({ data: page(12, 1000), error: null, count: 1012 });

    const rows = await listTeamShifts("2026-08-24T00:00:00Z", "2026-09-07T00:00:00Z");

    expect(rows).toHaveLength(1012);
    expect(range).toHaveBeenCalledTimes(3);
  });

  it("loads the complete unassigned backlog without payroll date bounds", async () => {
    range.mockResolvedValueOnce({ data: page(1000), count: 1001 })
      .mockResolvedValueOnce({ data: page(1, 1000), count: 1001 });
    expect(await listTeamShifts(null, null, undefined, { unassignedOnly: true })).toHaveLength(1001);
    expect(queryFilter.mock.calls.filter(c => c[0] === "is")).toEqual([
      ["is", "project_id", null], ["is", "project_id", null],
    ]);
    expect(queryFilter.mock.calls.some(c => c[0] === "gte" || c[0] === "lt")).toBe(false);
    expect(queryFilter).toHaveBeenCalledWith("neq", "status", "voided");
  });

  it("reads a small period in one go", async () => {
    range.mockResolvedValueOnce({ data: page(4), error: null, count: 4 });

    const rows = await listTeamShifts("2026-08-24T00:00:00Z", "2026-08-31T00:00:00Z");

    expect(rows).toHaveLength(4);
    expect(range).toHaveBeenCalledTimes(1);
  });

  it("stops on an empty period without a second read", async () => {
    range.mockResolvedValueOnce({ data: [], error: null, count: 0 });

    expect(await listTeamShifts("2026-08-24T00:00:00Z", "2026-08-31T00:00:00Z")).toEqual([]);
    expect(range).toHaveBeenCalledTimes(1);
  });

  it("refuses a count-free result instead of calling a capped page the total", async () => {
    range.mockResolvedValueOnce({ data: page(6), error: null });
    await expect(listTeamShifts(null, null)).rejects.toThrow("could not be counted");
  });

  it("refuses a partial read and changed or duplicated pages", async () => {
    range.mockResolvedValueOnce({ data: page(2), count: 4 }).mockResolvedValueOnce({ data: [], count: 4 });
    await expect(listTeamShifts(null, null)).rejects.toThrow("incomplete");
    range.mockResolvedValueOnce({ data: page(2), count: 4 }).mockResolvedValueOnce({ data: page(2, 2), count: 5 });
    await expect(listTeamShifts(null, null)).rejects.toThrow("changed");
    range.mockResolvedValueOnce({ data: page(2), count: 4 }).mockResolvedValueOnce({ data: page(2), count: 4 });
    await expect(listTeamShifts(null, null)).rejects.toThrow("changed");
  });

  it("throws the raw error so formatApiError can speak for it upstream", async () => {
    range.mockResolvedValueOnce({ data: null, error: { message: "boom" } });

    await expect(
      listTeamShifts("2026-08-24T00:00:00Z", "2026-08-31T00:00:00Z"),
    ).rejects.toEqual({ message: "boom" });
  });
});

// ---------------------------------------------------------------------------
// Release 0 (K0.2 / K0.4 / K0.5): one-time ids, the tap trio, and refusals a
// person can read. Every direct punch is keyed even when the caller never
// thinks about it; a caller retrying a tap it already stamped keeps the id.
// ---------------------------------------------------------------------------
import {
  ClockRefusal,
  clockOut,
  endBreak,
  mintPunch,
  readEndBreak,
  startBreak,
} from "./timeclock";

const PUNCH = {
  clientId: "11111111-2222-4333-8444-555555555555",
  tappedAt: "2026-09-23T13:02:11.000Z",
  clockCheckedAt: "2026-09-23T12:00:00.000Z",
  clockSkewMs: 1500,
};

describe("clockIn carries the tap's one-time id and time (Release 0)", () => {
  beforeEach(() => rpc.mockReset());

  it("sends the punch it was given — id, tap time, last clock check and skew", async () => {
    rpc.mockResolvedValueOnce({ data: shift({}), error: null });
    await clockIn("j1", "cc1", undefined, null, "data", PUNCH);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc.mock.calls[0][1]).toMatchObject({
      p_client_id: PUNCH.clientId,
      p_tapped_at: PUNCH.tappedAt,
      p_clock_checked_at: PUNCH.clockCheckedAt,
      p_clock_skew_ms: 1500,
    });
  });

  it("keeps the same id on a retry of the same punch object", async () => {
    // The landing block's punch, refused on the network, handed to the sheet:
    // the second send must be the FIRST send to the server.
    rpc.mockResolvedValueOnce({ data: null, error: { message: "Failed to fetch" } });
    rpc.mockResolvedValueOnce({ data: shift({}), error: null });
    await expect(clockIn("j1", "cc1", undefined, null, null, PUNCH)).rejects.toBeTruthy();
    await clockIn("j1", "cc1", undefined, null, null, PUNCH);
    expect(rpc.mock.calls[0][1]).toHaveProperty("p_client_id", PUNCH.clientId);
    expect(rpc.mock.calls[1][1]).toHaveProperty("p_client_id", PUNCH.clientId);
  });

  it("mints a fresh id per call when the caller passes none, so no direct punch is ever unkeyed", async () => {
    rpc.mockResolvedValue({ data: shift({}), error: null });
    await clockIn("j1", "cc1");
    await clockIn("j1", "cc1");
    const a = (rpc.mock.calls[0][1] as { p_client_id: string }).p_client_id;
    const b = (rpc.mock.calls[1][1] as { p_client_id: string }).p_client_id;
    expect(a).toEqual(expect.any(String));
    expect(b).toEqual(expect.any(String));
    expect(a).not.toBe(b);
  });
});

describe("clockOut, startBreak and endBreak are keyed the same way", () => {
  const MISSING = { code: "PGRST202", message: "Could not find the function" };
  beforeEach(() => rpc.mockReset());

  it("clockOut sends the id and the tap trio beside the punch's own fields", async () => {
    rpc.mockResolvedValueOnce({ data: shift({ clock_out_at: "2026-09-23T21:00:00Z" }), error: null });
    await clockOut("s1", { injured: false, timeConfirmed: true, breakSeconds: 600 }, PUNCH);
    expect(rpc.mock.calls[0][0]).toBe("clock_out");
    expect(rpc.mock.calls[0][1]).toMatchObject({
      p_shift_id: "s1",
      p_break_seconds: 600,
      p_client_id: PUNCH.clientId,
      p_tapped_at: PUNCH.tappedAt,
      p_clock_skew_ms: 1500,
    });
  });

  it("clockOut falls back to the legacy overload only when the keyed one is missing", async () => {
    rpc.mockResolvedValueOnce({ data: null, error: MISSING });
    rpc.mockResolvedValueOnce({ data: shift({}), error: null });
    await clockOut("s1", { injured: false, timeConfirmed: true, breakSeconds: 0 }, PUNCH);
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(rpc.mock.calls[1][1]).not.toHaveProperty("p_client_id");
  });

  it("clockOut surfaces the server's plain refusal of a second close, without retrying", async () => {
    const refusal = { code: "P0001", message: "This shift was already clocked out. Nothing was changed." };
    rpc.mockResolvedValueOnce({ data: null, error: refusal });
    await expect(clockOut("s1", { injured: false, timeConfirmed: true, breakSeconds: 0 })).rejects.toBe(refusal);
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it("startBreak sends the id and the break type", async () => {
    rpc.mockResolvedValueOnce({ data: shift({ break_started_at: "2026-09-23T17:00:00Z" }), error: null });
    await startBreak("s1", "lunch", PUNCH);
    expect(rpc.mock.calls[0][0]).toBe("start_break");
    expect(rpc.mock.calls[0][1]).toMatchObject({ p_shift_id: "s1", p_break_type: "lunch", p_client_id: PUNCH.clientId });
  });

  it("endBreak returns the shift when the break ended", async () => {
    const ended = shift({ break_seconds: 1800 });
    rpc.mockResolvedValueOnce({ data: { outcome: "ended", shift: ended }, error: null });
    const out = await endBreak("s1", PUNCH);
    expect(out).toEqual(ended);
    expect(rpc.mock.calls[0][1]).toMatchObject({ p_shift_id: "s1", p_client_id: PUNCH.clientId });
  });

  it("endBreak turns 'no_break_running' into a refusal the sheet can read (K0.4)", async () => {
    rpc.mockResolvedValueOnce({ data: { outcome: "no_break_running", shift: shift({}) }, error: null });
    const err = await endBreak("s1", PUNCH).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ClockRefusal);
    expect((err as ClockRefusal).code).toBe("no_break_running");
    // The English line, for a caller that only has formatApiError.
    expect((err as Error).message).toContain("couldn't find the start of that break");
  });

  it("endBreak turns 'shift_closed' into its own refusal", async () => {
    rpc.mockResolvedValueOnce({ data: { outcome: "shift_closed", shift: shift({}) }, error: null });
    const err = await endBreak("s1", PUNCH).catch((e: unknown) => e);
    expect((err as ClockRefusal).code).toBe("shift_closed");
  });

  it("endBreak on a database behind the app takes the legacy overload and its row", async () => {
    const row = shift({ break_seconds: 900 });
    rpc.mockResolvedValueOnce({ data: null, error: MISSING });
    rpc.mockResolvedValueOnce({ data: row, error: null });
    expect(await endBreak("s1", PUNCH)).toEqual(row);
    expect(rpc.mock.calls[1][1]).toEqual({ p_shift_id: "s1" });
  });

  it("readEndBreak passes a bare row through untouched (the legacy shape)", () => {
    const row = shift({});
    expect(readEndBreak(row)).toBe(row);
  });
});

describe("a made-up shift id never reaches a uuid RPC (K0.4)", () => {
  beforeEach(() => rpc.mockReset());

  for (const [name, call] of [
    ["clockOut", () => clockOut("pending:abc", { injured: false, timeConfirmed: true, breakSeconds: 0 })],
    ["startBreak", () => startBreak("pending:abc", "lunch")],
    ["endBreak", () => endBreak("pending:abc")],
  ] as const) {
    it(`${name} refuses a pending: ref before any request leaves`, async () => {
      const err = await call().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ClockRefusal);
      expect((err as ClockRefusal).code).toBe("clock_pending_sync");
      expect(rpc).not.toHaveBeenCalled();
    });
  }
});

describe("mintPunch", () => {
  it("keeps a caller's id and stamps the tap time", () => {
    const p = mintPunch("keep-me", Date.UTC(2026, 8, 23, 13, 2, 11));
    expect(p.clientId).toBe("keep-me");
    expect(p.tappedAt).toBe("2026-09-23T13:02:11.000Z");
  });
  it("mints a uuid-shaped id when given none", () => {
    expect(mintPunch().clientId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(mintPunch(null).clientId).not.toBe(mintPunch(null).clientId);
  });
});
