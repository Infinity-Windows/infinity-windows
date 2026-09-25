// The paid-time rule (crew redesign K1.3, owner's rule + Q69, settled
// 2026-09-23): "paid time starts the moment someone starts the toolbox talk".
//
// What it changes: WHEN a shift begins. Under the rule, Start day clocks the
// person in at that tap and the talk is signed on the clock; before it, the
// clock-in waits for the signature (today's timing). It changes nothing else —
// never how hours are added up, never a shift already on record. Payroll
// (timeMath.shiftHours, gustoExport) does not import this file, and
// paidTimeRule.test.ts proves the same shifts total the same with the rule
// on and off.
//
// One date for everyone (Q69): the owner sets `paid_time_from_start_day_on`
// at release time, at the start of a pay period. Null = off. The server's
// clock_in gate reads the same column (20261031000000, `_toolbox_gate_open`),
// so the phone and the database agree on the day it starts.

/** The one setting this file reads, as company_settings carries it. */
export interface PaidTimeRuleSettings {
  paid_time_from_start_day_on?: string | null;
}

/**
 * Is the rule in force on `todayISO` (a "YYYY-MM-DD" company-local day)?
 * Off until the owner sets a date; a date in the future is not yet on.
 */
export function paidTimeRuleActive(
  settings: PaidTimeRuleSettings | null | undefined,
  todayISO: string,
): boolean {
  const on = settings?.paid_time_from_start_day_on ?? null;
  if (!on) return false;
  return on.slice(0, 10) <= todayISO;
}

export type PaidTimeRuleState = "off" | "scheduled" | "on";

/** Off, scheduled for a future day, or on — for the owner's settings card. */
export function paidTimeRuleState(
  settings: PaidTimeRuleSettings | null | undefined,
  todayISO: string,
): PaidTimeRuleState {
  const on = settings?.paid_time_from_start_day_on ?? null;
  if (!on) return "off";
  return on.slice(0, 10) <= todayISO ? "on" : "scheduled";
}

/** A "YYYY-MM-DD" from an <input type="date">, or null for anything else. */
export function normalizeRuleDate(value: string | null | undefined): string | null {
  const v = (value ?? "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;
}
