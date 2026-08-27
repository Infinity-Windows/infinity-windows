// Wave L, L2: the draft that writes itself. Pure — every timestamp this
// module reads is already scoped to one job-day by the caller (see
// dailyLogs.ts's buildDraftForJobDay), so this file never asks what day it
// is; it only totals up what it's handed.
//
// notesDraft and headline are a STARTING POINT, not a report: the filing
// dialog (L3) shows both in editable fields, and a foreman may rewrite
// either completely before saving. crewLine is the one non-editable fact
// this module hands back, for the dialog to show alongside the editable
// headline even after a foreman has rewritten it.

import { formatHours } from "./estimate";

export interface DailyLogDraftShift {
  profile_id: string;
  clock_in_at: string;
  clock_out_at: string | null;
  break_seconds: number;
  /** Voided shifts "leave every total instantly" (CONTEXT.md's Void) — the
   * caller may pass them through uncounted rather than filtering first. */
  status: string;
}

export interface DailyLogDraftSession {
  opening_id: string;
  /** The mark, e.g. "W1", "#14-2" (project_openings.opening_code). */
  opening_code: string;
  started_at: string;
  ended_at: string | null;
  end_reason: string | null;
}

export interface DailyLogDraftRedo {
  opening_id: string;
  opening_code: string;
  reason: string;
}

export interface DailyLogDraftInput {
  shifts: DailyLogDraftShift[];
  sessions: DailyLogDraftSession[];
  redos: DailyLogDraftRedo[];
  /** Anchor for an still-open shift/session's elapsed time. Defaults to the
   * real clock; tests pass a fixed instant for determinism. */
  now?: Date;
}

export interface DailyLogDraft {
  headline: string;
  notesDraft: string;
  /** "3 crew · 26.5h" — the objective shift-time facts, always this shape
   * regardless of whatever the foreman rewrites headline/notes to say. */
  crewLine: string;
}

function markSort(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true });
}

/** A shift's minutes on this job today: clock-in to clock-out (or `now` if
 * still open), less its break. Shift time, not session time — the two
 * clocks CONTEXT.md keeps separate (Session vs Shift). */
function shiftMinutes(s: DailyLogDraftShift, now: number): number {
  const start = Date.parse(s.clock_in_at);
  const end = s.clock_out_at ? Date.parse(s.clock_out_at) : now;
  if (Number.isNaN(start) || Number.isNaN(end)) return 0;
  const raw = Math.round((end - start) / 60000) - Math.round((s.break_seconds ?? 0) / 60);
  return Math.max(0, raw);
}

/** A session's minutes, live against `now` when still open — same shape as
 * lib/install/sessions.ts's sessionMinutes, no 480-cap: that cap is specific
 * to what finish_unit feeds the estimating model, not to this draft. */
function sessionMinutes(s: DailyLogDraftSession, now: number): number {
  const start = Date.parse(s.started_at);
  const end = s.ended_at ? Date.parse(s.ended_at) : now;
  if (Number.isNaN(start) || Number.isNaN(end)) return 0;
  return Math.max(0, Math.round((end - start) / 60000));
}

export function buildDailyLogDraft(input: DailyLogDraftInput): DailyLogDraft {
  const now = (input.now ?? new Date()).getTime();

  // ------------------------------------------------------------- crew/hours
  const liveShifts = input.shifts.filter((s) => s.status !== "voided");
  const crew = new Set(liveShifts.map((s) => s.profile_id)).size;
  const minutes = liveShifts.reduce((sum, s) => sum + shiftMinutes(s, now), 0);
  const hours = formatHours(minutes);

  // ------------------------------------------------------- units, by mark
  const byOpening = new Map<string, { code: string; minutes: number; finished: boolean }>();
  for (const s of input.sessions) {
    const entry = byOpening.get(s.opening_id) ?? {
      code: s.opening_code,
      minutes: 0,
      finished: false,
    };
    entry.minutes += sessionMinutes(s, now);
    if (s.end_reason === "finish") entry.finished = true;
    byOpening.set(s.opening_id, entry);
  }
  const finished = [...byOpening.values()]
    .filter((o) => o.finished)
    .map((o) => o.code)
    .sort(markSort);
  const stillOpen = [...byOpening.values()]
    .filter((o) => !o.finished)
    .sort((a, b) => markSort(a.code, b.code));

  // ------------------------------------------------------------------ redos
  const redos = [...input.redos].sort((a, b) => markSort(a.opening_code, b.opening_code));

  // --------------------------------------------------------------- assemble
  const unitWord = finished.length === 1 ? "unit" : "units";
  const headline = `${finished.length} ${unitWord} installed — ${crew} crew, ${hours}`;
  const crewLine = `${crew} crew · ${hours}`;

  const bullets: string[] = [];
  if (finished.length > 0) bullets.push(`Finished: ${finished.join(", ")}`);
  if (stillOpen.length > 0) {
    bullets.push(
      `Still open: ${stillOpen.map((o) => `${o.code} (${formatHours(o.minutes)})`).join(", ")}`,
    );
  }
  if (redos.length > 0) {
    bullets.push(
      `Redone: ${redos.map((r) => `${r.opening_code} — ${r.reason}`).join(", ")}`,
    );
  }

  return { headline, notesDraft: bullets.join("\n"), crewLine };
}
