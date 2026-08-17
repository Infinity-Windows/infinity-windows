// The Data Tab's math (CONTEXT.md: Block, Rework, On-tool, labor-minutes).
// Everything here is DERIVED from stored atoms — sessions, shifts, phases —
// and every number keeps its provenance: a stalled hour traces to a Block
// with a reason and an issue; nothing is typed, nothing is stored twice.

import type { TimeShift } from "../timeclock";
import { sessionMinutes, type UnitSession } from "../install/sessions";

/**
 * LOST TIME by reason: how long units SAT after a Block before work
 * resumed (or until now, for units still sitting). This is the number
 * that makes warehouse and GC failures visible — Block exists so they
 * stop being recorded as slow installation.
 *
 * A stall is the gap from the block to the unit's next session start;
 * still-blocked units accrue against `now`. Sessions may be in any order.
 */
export function stallsByReason(
  sessions: readonly UnitSession[],
  now: number = Date.now(),
): { reason: string; count: number; stalledMin: number }[] {
  const byUnit = new Map<string, UnitSession[]>();
  for (const s of sessions) {
    const list = byUnit.get(s.opening_id) ?? [];
    list.push(s);
    byUnit.set(s.opening_id, list);
  }
  const byReason = new Map<string, { count: number; stalledMin: number }>();
  for (const list of byUnit.values()) {
    const sorted = [...list].sort(
      (a, b) => Date.parse(a.started_at) - Date.parse(b.started_at),
    );
    sorted.forEach((s, i) => {
      if (s.end_reason !== "block" || !s.ended_at) return;
      const blockedAt = Date.parse(s.ended_at);
      const next = sorted
        .slice(i + 1)
        .find((n) => Date.parse(n.started_at) > blockedAt);
      const resumeAt = next ? Date.parse(next.started_at) : now;
      const stalledMin = Math.max(0, Math.floor((resumeAt - blockedAt) / 60000));
      const reason = s.block_reason ?? "No reason recorded";
      const entry = byReason.get(reason) ?? { count: 0, stalledMin: 0 };
      entry.count += 1;
      entry.stalledMin += stalledMin;
      byReason.set(reason, entry);
    });
  }
  return [...byReason.entries()]
    .map(([reason, v]) => ({ reason, ...v }))
    .sort((a, b) => b.stalledMin - a.stalledMin);
}

/** Rework: distinct units and total rework minutes. */
export function reworkTotals(
  sessions: readonly UnitSession[],
  now: number = Date.now(),
): { units: number; minutes: number } {
  const units = new Set<string>();
  let minutes = 0;
  for (const s of sessions) {
    if (!s.is_rework) continue;
    units.add(s.opening_id);
    minutes += sessionMinutes(s, now);
  }
  return { units: units.size, minutes };
}

/**
 * The costliest units: total finished labor minutes per opening, biggest
 * first. The Data Tab links each to its sheet — where the Record answers
 * "why did this one cost so much?" with photos and a timeline.
 */
export function topUnitsByLabor(
  sessions: readonly UnitSession[],
  limit = 5,
  now: number = Date.now(),
): { openingId: string; minutes: number }[] {
  const byUnit = new Map<string, number>();
  for (const s of sessions) {
    if (!s.ended_at) continue;
    byUnit.set(s.opening_id, (byUnit.get(s.opening_id) ?? 0) + sessionMinutes(s, now));
  }
  return [...byUnit.entries()]
    .map(([openingId, minutes]) => ({ openingId, minutes }))
    .filter((u) => u.minutes > 0)
    .sort((a, b) => b.minutes - a.minutes)
    .slice(0, limit);
}

/** Sessions a dead phone left running until the sweep flagged them. */
export function autoClosedCount(sessions: readonly UnitSession[]): number {
  return sessions.filter((s) => s.end_reason === "auto_closed").length;
}

export interface OnToolRow {
  profileId: string;
  sessionMin: number;
  shiftMin: number;
  /** null when no shift time — a percentage of nothing is a lie. */
  pct: number | null;
}

/**
 * ON-TOOL (CONTEXT.md): session minutes ÷ worked shift minutes. Crew
 * total first — low on-tool across everyone indicts the schedule or the
 * warehouse, not the people. Per-person rows exist for supervisors only;
 * installers never see any of this.
 */
export function onTool(
  sessions: readonly UnitSession[],
  shifts: readonly Pick<
    TimeShift,
    "profile_id" | "clock_in_at" | "clock_out_at" | "break_seconds"
  >[],
  now: number = Date.now(),
): { total: OnToolRow; perPerson: OnToolRow[] } {
  const shiftMinBy = new Map<string, number>();
  for (const sh of shifts) {
    const start = Date.parse(sh.clock_in_at);
    const end = sh.clock_out_at ? Date.parse(sh.clock_out_at) : now;
    if (Number.isNaN(start) || Number.isNaN(end)) continue;
    const worked = Math.max(
      0,
      Math.floor((end - start) / 60000) - Math.floor((sh.break_seconds ?? 0) / 60),
    );
    shiftMinBy.set(sh.profile_id, (shiftMinBy.get(sh.profile_id) ?? 0) + worked);
  }
  const sessionMinBy = new Map<string, number>();
  for (const s of sessions) {
    sessionMinBy.set(
      s.profile_id,
      (sessionMinBy.get(s.profile_id) ?? 0) + sessionMinutes(s, now),
    );
  }
  const people = new Set([...shiftMinBy.keys(), ...sessionMinBy.keys()]);
  const perPerson: OnToolRow[] = [...people]
    .map((profileId) => {
      const shiftMin = shiftMinBy.get(profileId) ?? 0;
      const sessionMin = Math.min(sessionMinBy.get(profileId) ?? 0, shiftMin || Infinity);
      return {
        profileId,
        sessionMin,
        shiftMin,
        pct: shiftMin > 0 ? Math.min(1, sessionMin / shiftMin) : null,
      };
    })
    .sort((a, b) => (b.shiftMin ?? 0) - (a.shiftMin ?? 0));
  const sessionMin = perPerson.reduce((t, p) => t + p.sessionMin, 0);
  const shiftMin = perPerson.reduce((t, p) => t + p.shiftMin, 0);
  return {
    total: {
      profileId: "crew",
      sessionMin,
      shiftMin,
      pct: shiftMin > 0 ? Math.min(1, sessionMin / shiftMin) : null,
    },
    perPerson,
  };
}
