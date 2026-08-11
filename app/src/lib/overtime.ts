// Overtime, computed at the reporting layer — never stored per-shift.
//
// The rules live in the overtime_rules table (one company default, optional
// per-person overrides; person beats company). Because nothing is priced at
// write time, changing a rule re-prices history honestly: the timecard and
// the export always show what the current rule says the week was worth.
//
// The split follows the standard layering:
//   1. Per day, hours past the double-time threshold are double time.
//   2. Per day, remaining hours past the daily threshold are overtime.
//   3. Across the week, remaining REGULAR hours past the weekly threshold
//      become overtime too — daily-OT hours never count twice.
// Any threshold left unset simply doesn't apply (the seeded company default
// sets weekly 40 only).

export interface OvertimeRule {
  weeklyThresholdHours: number | null;
  weeklyOtMultiplier: number;
  dailyThresholdHours: number | null;
  dailyOtMultiplier: number;
  doubleTimeThresholdHours: number | null;
  doubleTimeMultiplier: number;
}

export interface OvertimeSplit {
  regular: number;
  overtime: number;
  doubleTime: number;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Split one week of per-day worked hours into regular / OT / double time. */
export function splitOvertime(
  dailyHours: number[],
  rule: OvertimeRule | null,
): OvertimeSplit {
  let regular = 0;
  let overtime = 0;
  let doubleTime = 0;

  for (const raw of dailyHours) {
    const h = Math.max(0, raw);
    const dtT = rule?.doubleTimeThresholdHours ?? null;
    const dT = rule?.dailyThresholdHours ?? null;
    const dt = dtT !== null ? Math.max(0, h - dtT) : 0;
    const underDt = h - dt;
    const dailyOt = dT !== null ? Math.max(0, underDt - dT) : 0;
    doubleTime += dt;
    overtime += dailyOt;
    regular += underDt - dailyOt;
  }

  const wT = rule?.weeklyThresholdHours ?? null;
  if (wT !== null && regular > wT) {
    overtime += regular - wT;
    regular = wT;
  }

  return {
    regular: round2(regular),
    overtime: round2(overtime),
    doubleTime: round2(doubleTime),
  };
}

/** The rule that applies to a person: their override, else the company's. */
export function pickOvertimeRule<T extends { scope: string; profile_id: string | null }>(
  rules: T[],
  profileId: string,
): T | null {
  return (
    rules.find((r) => r.scope === "person" && r.profile_id === profileId) ??
    rules.find((r) => r.scope === "company") ??
    null
  );
}

/** Map a DB overtime_rules row onto the split's shape. */
export function overtimeRuleFromRow(row: {
  weekly_threshold_hours: number | null;
  weekly_ot_multiplier: number;
  daily_threshold_hours: number | null;
  daily_ot_multiplier: number;
  double_time_threshold_hours: number | null;
  double_time_multiplier: number;
}): OvertimeRule {
  return {
    weeklyThresholdHours: row.weekly_threshold_hours,
    weeklyOtMultiplier: row.weekly_ot_multiplier,
    dailyThresholdHours: row.daily_threshold_hours,
    dailyOtMultiplier: row.daily_ot_multiplier,
    doubleTimeThresholdHours: row.double_time_threshold_hours,
    doubleTimeMultiplier: row.double_time_multiplier,
  };
}
