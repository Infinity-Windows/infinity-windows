// The Data Tab's math (CONTEXT.md: Block, Rework, On-tool, labor-minutes).
// Everything here is DERIVED from stored atoms — sessions, shifts, phases —
// and every number keeps its provenance: a stalled hour traces to a Block
// with a reason and an issue; nothing is typed, nothing is stored twice.

import type { TimeShift } from "../timeclock";
import { supabase } from "../supabase";
import { sessionMinutes, type UnitSession } from "../install/sessions";

/**
 * A project's non-voided install minutes from the old hand-recorded era
 * (install_events.minutes, pre-sessions). Windows installed before
 * automatic timing shipped have their time HERE and nowhere else.
 */
export async function listProjectInstallMinutes(
  projectId: string,
): Promise<{ opening_id: string; minutes: number }[]> {
  const { data, error } = await supabase
    .from("install_events")
    .select("project_opening_id, minutes, opening:project_openings!inner(project_id)")
    .eq("opening.project_id", projectId)
    .is("voided_at", null)
    .not("minutes", "is", null);
  if (error) throw error;
  return ((data ?? []) as unknown as { project_opening_id: string; minutes: number }[])
    .map((r) => ({ opening_id: r.project_opening_id, minutes: r.minutes }))
    .filter((r) => r.minutes > 0);
}

/**
 * Old-era install minutes that the sessions ledger does NOT already cover
 * — the automatic timing wins per window, the old number only fills gaps
 * (same newest-truth-first rule as estimating evidence). Returns the
 * minutes to add and how many windows they came from, so the UI can say
 * so out loud.
 */
export function legacyLabor(
  events: readonly { opening_id: string; minutes: number }[],
  sessions: readonly UnitSession[],
): { minutes: number; units: number } {
  const covered = new Set(
    sessions.filter((s) => s.ended_at).map((s) => s.opening_id),
  );
  let minutes = 0;
  const units = new Set<string>();
  for (const e of events) {
    if (covered.has(e.opening_id)) continue;
    minutes += e.minutes;
    units.add(e.opening_id);
  }
  return { minutes, units: units.size };
}

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
 * BLOCKED RIGHT NOW: units whose newest session ended in a Block with no
 * work since — with how long they've been sitting. The morning dispatch
 * list: every row is something to go unstick today.
 */
export function blockedNow(
  sessions: readonly UnitSession[],
  now: number = Date.now(),
): { openingId: string; reason: string | null; sittingMin: number }[] {
  const newestBy = new Map<string, UnitSession>();
  for (const s of sessions) {
    const prev = newestBy.get(s.opening_id);
    if (!prev || Date.parse(s.started_at) > Date.parse(prev.started_at)) {
      newestBy.set(s.opening_id, s);
    }
  }
  const out: { openingId: string; reason: string | null; sittingMin: number }[] = [];
  for (const [openingId, s] of newestBy) {
    if (!s.ended_at || s.end_reason !== "block") continue;
    out.push({
      openingId,
      reason: s.block_reason,
      sittingMin: Math.max(0, Math.floor((now - Date.parse(s.ended_at)) / 60000)),
    });
  }
  return out.sort((a, b) => b.sittingMin - a.sittingMin);
}

export interface WeekPoint {
  /** ISO date (Monday) the week starts on. */
  weekStart: string;
  laborMin: number;
  lostMin: number;
}

const WEEK_MS = 7 * 24 * 3600 * 1000;

/** Monday 00:00 UTC of the week containing `t` — pay periods are Monday
 * weeks, so the trend speaks the same calendar as payroll. */
function mondayOf(t: number): number {
  const d = new Date(t);
  const dow = (d.getUTCDay() + 6) % 7; // Mon=0
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - dow);
}

/**
 * WEEKLY TREND: labor minutes and block-lost minutes per Monday week for
 * the last `weeks` weeks (oldest first, empty weeks included so the shape
 * of the chart is honest). Lost time is attributed to the week the Block
 * happened, sized by the same to-next-touch rule as stallsByReason.
 */
export function weeklyTrend(
  sessions: readonly UnitSession[],
  weeks = 6,
  now: number = Date.now(),
): WeekPoint[] {
  const thisMonday = mondayOf(now);
  const firstMonday = thisMonday - (weeks - 1) * WEEK_MS;
  const points = new Map<number, WeekPoint>();
  for (let i = 0; i < weeks; i++) {
    const start = firstMonday + i * WEEK_MS;
    points.set(start, {
      weekStart: new Date(start).toISOString().slice(0, 10),
      laborMin: 0,
      lostMin: 0,
    });
  }
  const bump = (at: number, key: "laborMin" | "lostMin", min: number) => {
    const p = points.get(mondayOf(at));
    if (p) p[key] += min;
  };

  const byUnit = new Map<string, UnitSession[]>();
  for (const s of sessions) {
    if (s.ended_at) bump(Date.parse(s.started_at), "laborMin", sessionMinutes(s, now));
    const list = byUnit.get(s.opening_id) ?? [];
    list.push(s);
    byUnit.set(s.opening_id, list);
  }
  for (const list of byUnit.values()) {
    const sorted = [...list].sort(
      (a, b) => Date.parse(a.started_at) - Date.parse(b.started_at),
    );
    sorted.forEach((s, i) => {
      if (s.end_reason !== "block" || !s.ended_at) return;
      const blockedAt = Date.parse(s.ended_at);
      const next = sorted.slice(i + 1).find((n) => Date.parse(n.started_at) > blockedAt);
      const resumeAt = next ? Date.parse(next.started_at) : now;
      bump(blockedAt, "lostMin", Math.max(0, Math.floor((resumeAt - blockedAt) / 60000)));
    });
  }
  return [...points.values()];
}

/**
 * ESTIMATE vs ACTUAL: how hot or cold the estimates run, from finished
 * units that had both a number and a recorded time. Median ratio — one
 * disaster window shouldn't swing the verdict. Null below n=5: a
 * percentage from three windows is a guess wearing a suit.
 */
export function estimateVsActual(
  pairs: readonly { estimateMin: number; actualMin: number }[],
): { n: number; medianRatio: number } | null {
  const ratios = pairs
    .filter((p) => p.estimateMin > 0 && p.actualMin > 0)
    .map((p) => p.actualMin / p.estimateMin)
    .sort((a, b) => a - b);
  if (ratios.length < 5) return null;
  const mid = Math.floor(ratios.length / 2);
  const medianRatio =
    ratios.length % 2 ? ratios[mid] : (ratios[mid - 1] + ratios[mid]) / 2;
  return { n: ratios.length, medianRatio };
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
  legacyEvents: readonly { opening_id: string; minutes: number }[] = [],
): { openingId: string; minutes: number }[] {
  const byUnit = new Map<string, number>();
  for (const s of sessions) {
    if (!s.ended_at) continue;
    byUnit.set(s.opening_id, (byUnit.get(s.opening_id) ?? 0) + sessionMinutes(s, now));
  }
  // Old-era minutes only where the sessions ledger is silent — the
  // automatic timing wins per window (same rule as legacyLabor).
  for (const e of legacyEvents) {
    if (!byUnit.has(e.opening_id) && e.minutes > 0) {
      byUnit.set(e.opening_id, e.minutes);
    }
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
): { total: OnToolRow; perPerson: OnToolRow[]; overShiftCount: number; overShiftMin: number } {
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
  // Session minutes are reported RAW here, not trimmed to shiftMin. Trimming
  // used to hide the case where recorded session time runs past the clocked
  // shift (overlapping sessions, a shift edited after the fact, clock
  // drift) — the overage would just vanish from the crew total instead of
  // showing up as something to check. The percentage below still caps at
  // 100%, so display never claims more than a full shift of on-tool time.
  const perPerson: OnToolRow[] = [...people]
    .map((profileId) => {
      const shiftMin = shiftMinBy.get(profileId) ?? 0;
      const sessionMin = sessionMinBy.get(profileId) ?? 0;
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
  // Data-quality signal: who has more on-tool minutes than clocked minutes.
  // Only counts people who actually have a shift — no shift at all is a
  // different (already-visible) problem, not this one.
  const overShift = perPerson.filter((p) => p.shiftMin > 0 && p.sessionMin > p.shiftMin);
  return {
    total: {
      profileId: "crew",
      sessionMin,
      shiftMin,
      pct: shiftMin > 0 ? Math.min(1, sessionMin / shiftMin) : null,
    },
    perPerson,
    overShiftCount: overShift.length,
    overShiftMin: overShift.reduce((t, p) => t + (p.sessionMin - p.shiftMin), 0),
  };
}
