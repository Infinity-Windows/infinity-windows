// One person's regular / overtime / double split, for a whole crew at once
// (Wave K, K5).
//
// The rule this exists to keep: OVERTIME IS WEEKLY, so a two-week pay period is
// two separate weekly buckets and never one 80-hour pool. TimecardPanel has
// done that correctly for a single person since Wave T; the team export had no
// overtime at all (`overtime: []`). This is that same maths, lifted out so both
// the team CSV and the Gusto export use one implementation instead of two.
//
// Framework-free and pure: the caller does the date work (punchDay / weekRange)
// and hands over flat rows, so the split can be tested with fixtures.

import { splitOvertime, type OvertimeRule } from "./overtime";
import type { TimecardOvertimeLine } from "./timecardExport";

/** One worked shift, already reduced to the four facts the split needs. */
export interface OvertimeShiftRow {
  profileId: string;
  /** Display name, for the export line. */
  employee: string;
  /** Local calendar day key (YYYY-MM-DD) — the daily-OT bucket. */
  day: string;
  /** Week-start key (an ISO date string) — the weekly-OT bucket. */
  week: string;
  /** Net worked hours (breaks already excluded). */
  hours: number;
}

export interface OvertimeLineByPerson extends TimecardOvertimeLine {
  profileId: string;
}

/**
 * Split every person's shifts into regular / overtime / double time.
 *
 * `ruleFor` answers with the rule that applies to one person (their override,
 * else the company default) — passing it in rather than the rules table keeps
 * this module free of database shapes.
 *
 * People come back in name order, the same order every other export uses, so
 * two exports of the same period diff cleanly against each other.
 */
export function splitOvertimeByPerson(
  rows: OvertimeShiftRow[],
  ruleFor: (profileId: string) => OvertimeRule | null,
): OvertimeLineByPerson[] {
  // person -> week -> day -> hours
  const byPerson = new Map<string, { employee: string; weeks: Map<string, Map<string, number>> }>();
  for (const r of rows) {
    let person = byPerson.get(r.profileId);
    if (!person) {
      person = { employee: r.employee, weeks: new Map() };
      byPerson.set(r.profileId, person);
    }
    const days = person.weeks.get(r.week) ?? new Map<string, number>();
    days.set(r.day, (days.get(r.day) ?? 0) + r.hours);
    person.weeks.set(r.week, days);
  }

  const out: OvertimeLineByPerson[] = [];
  for (const [profileId, person] of byPerson) {
    const rule = ruleFor(profileId);
    let regular = 0;
    let overtime = 0;
    let doubleTime = 0;
    for (const days of person.weeks.values()) {
      const split = splitOvertime([...days.values()], rule);
      regular += split.regular;
      overtime += split.overtime;
      doubleTime += split.doubleTime;
    }
    out.push({
      profileId,
      employee: person.employee,
      regular: round2(regular),
      overtime: round2(overtime),
      doubleTime: round2(doubleTime),
    });
  }
  out.sort((a, b) =>
    a.employee.localeCompare(b.employee, undefined, { sensitivity: "base" }),
  );
  return out;
}

const round2 = (n: number) => Math.round(n * 100) / 100;
