// The paid-time rule decides WHEN a shift starts, never how it is paid. The
// second half of this file is the payroll before/after comparison the spec
// requires of every release that touches time (Builder laws, K1.3): the same
// recorded shifts, totalled with the rule off and then on, must come out
// identical to the cent — and nothing in the payroll path may even read the
// rule.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { shiftHours } from "../../../supabase/functions/_shared/timeMath.ts";
import { buildGustoCsv, buildGustoRows } from "./gustoExport";
import { splitOvertimeByPerson } from "./overtimeRollup";
import { normalizeRuleDate, paidTimeRuleActive, paidTimeRuleState } from "./paidTimeRule";
import { shiftsToExportRows, type TimeShift } from "./timeclock";

describe("paidTimeRuleActive (K1.3 / Q69: one date for everyone, default off)", () => {
  it("is off until the owner sets a date", () => {
    expect(paidTimeRuleActive(null, "2026-10-05")).toBe(false);
    expect(paidTimeRuleActive({}, "2026-10-05")).toBe(false);
    expect(paidTimeRuleActive({ paid_time_from_start_day_on: null }, "2026-10-05")).toBe(false);
  });

  it("switches on for everyone on the day the owner picked, not before", () => {
    const s = { paid_time_from_start_day_on: "2026-10-05" };
    expect(paidTimeRuleActive(s, "2026-10-04")).toBe(false);
    expect(paidTimeRuleActive(s, "2026-10-05")).toBe(true);
    expect(paidTimeRuleActive(s, "2026-11-01")).toBe(true);
  });

  it("tolerates a timestamp-shaped date from an older client", () => {
    expect(paidTimeRuleActive({ paid_time_from_start_day_on: "2026-10-05T00:00:00" }, "2026-10-05")).toBe(true);
  });

  it("names the three states for the owner's card", () => {
    expect(paidTimeRuleState(null, "2026-10-05")).toBe("off");
    expect(paidTimeRuleState({ paid_time_from_start_day_on: "2026-10-19" }, "2026-10-05")).toBe("scheduled");
    expect(paidTimeRuleState({ paid_time_from_start_day_on: "2026-10-05" }, "2026-10-05")).toBe("on");
  });

  it("accepts only a calendar date from the date input", () => {
    expect(normalizeRuleDate("2026-10-05")).toBe("2026-10-05");
    expect(normalizeRuleDate("")).toBeNull();
    expect(normalizeRuleDate("next monday")).toBeNull();
    expect(normalizeRuleDate(undefined)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Payroll before/after comparison over fixtures
// ---------------------------------------------------------------------------

/** A pay period of recorded shifts straddling the rule's effective date. */
function fixtureShifts(): TimeShift[] {
  const mk = (
    id: string,
    name: string,
    clockIn: string,
    clockOut: string,
    breakSeconds = 0,
  ): TimeShift => ({
    id,
    profile_id: name,
    project_id: "job",
    cost_code_id: "cc",
    clock_in_at: clockIn,
    clock_out_at: clockOut,
    break_seconds: breakSeconds,
    break_started_at: null,
    injured: null,
    time_confirmed: true,
    status: "approved",
    created_at: clockIn,
    profiles: { display_name: name },
    projects: { job_code: "BLACK22", name: "Black Desert" },
    cost_codes: { code: "100", label: "Install" },
  }) as TimeShift;
  return [
    // Before the effective date: clocked in AFTER signing (today's timing).
    mk("a1", "Ana Ruiz", "2026-10-01T13:02:00Z", "2026-10-01T22:30:00Z", 1800),
    mk("a2", "Ana Ruiz", "2026-10-02T13:05:00Z", "2026-10-02T23:45:00Z", 1800),
    mk("b1", "Ben Cole", "2026-10-01T13:00:00Z", "2026-10-01T23:00:00Z", 3600),
    // On and after the effective date: clocked in at the Start day tap, the
    // talk signed on the clock. The record is a shift like any other.
    mk("a3", "Ana Ruiz", "2026-10-05T12:55:00Z", "2026-10-05T22:40:00Z", 1800),
    mk("a4", "Ana Ruiz", "2026-10-06T12:58:00Z", "2026-10-06T23:58:00Z", 1800),
    mk("b2", "Ben Cole", "2026-10-05T12:57:00Z", "2026-10-06T00:30:00Z", 3600),
  ];
}

/** Everything payroll produces from a set of shifts, as one comparable blob. */
function payroll(shifts: TimeShift[]) {
  const perShift = shifts.map((s) => ({ id: s.id, hours: shiftHours(s) }));
  const exportRows = shiftsToExportRows(shifts).map((r) => ({ ...r }));
  // The same reduction the team export makes before the weekly split: one
  // flat row per shift with its day and week keys, hours net of breaks.
  const week = (iso: string) => {
    const d = new Date(iso);
    const day = d.getUTCDay();
    const monday = new Date(d);
    monday.setUTCDate(d.getUTCDate() - ((day + 6) % 7));
    return monday.toISOString().slice(0, 10);
  };
  const lines = splitOvertimeByPerson(
    shifts.map((s) => ({
      profileId: s.profile_id,
      employee: s.profiles?.display_name ?? s.profile_id,
      day: s.clock_in_at.slice(0, 10),
      week: week(s.clock_in_at),
      hours: shiftHours(s),
    })),
    () => null,
  );
  const gusto = lines.map((l) => ({
    firstName: l.employee.split(" ")[0],
    lastName: l.employee.split(" ").slice(1).join(" "),
    regular: l.regular,
    overtime: l.overtime,
    doubleOvertime: l.doubleTime,
  }));
  return { perShift, exportRows, gustoRows: buildGustoRows(gusto), csv: buildGustoCsv(gusto) };
}

describe("payroll before/after the paid-time rule (K1.3: no past shift recalculated)", () => {
  it("totals the same recorded shifts identically with the rule off and on", () => {
    const shifts = fixtureShifts();
    const before = payroll(shifts);
    // Flip the rule on for the whole period. Payroll takes no such input, so
    // the only way this could differ is if a payroll function had started
    // reading the setting — which the structural test below forbids.
    expect(paidTimeRuleActive({ paid_time_from_start_day_on: "2026-10-05" }, "2026-10-06")).toBe(true);
    const after = payroll(fixtureShifts());
    expect(after).toEqual(before);
    // And the numbers are real hours, not zeros that happen to match.
    expect(before.perShift.find((r) => r.id === "a1")?.hours).toBeCloseTo(8.966, 2);
    expect(before.perShift.find((r) => r.id === "b2")?.hours).toBeCloseTo(10.55, 2);
    expect(before.csv).toContain("Ana");
  });

  it("a shift recorded before the effective date keeps the clock-in it was recorded with", () => {
    const shifts = fixtureShifts();
    const a1 = shifts.find((s) => s.id === "a1")!;
    // The record says 13:02Z (signed at 12:58, clocked in after) and stays so:
    // the rule is a fact about future taps, and there is no function anywhere
    // that rewrites clock_in_at from a signature time.
    expect(a1.clock_in_at).toBe("2026-10-01T13:02:00Z");
    expect(shiftHours(a1)).toBeCloseTo(8.966, 2);
  });

  it("no payroll module reads the rule (structural)", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const payrollFiles = [
      resolve(here, "./gustoExport.ts"),
      resolve(here, "./overtimeRollup.ts"),
      resolve(here, "./timeclock.ts"),
      resolve(here, "../../../supabase/functions/_shared/timeMath.ts"),
    ];
    for (const f of payrollFiles) {
      const src = readFileSync(f, "utf8");
      expect(src.includes("paidTimeRule"), `${f} must not read the paid-time rule`).toBe(false);
      expect(src.includes("paid_time_from_start_day_on"), `${f} must not read the paid-time rule`).toBe(false);
    }
  });
});
