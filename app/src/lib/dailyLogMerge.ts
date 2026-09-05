// What to send when a daily log written in a dead zone finally reaches a
// server that did not stand still while it waited.
//
// THE SITUATION THIS EXISTS FOR. One job-day has ONE log, shared, and any
// foreman on the job may edit it (Q6 — the row remembers who touched it last).
// So a foreman can type a log in a truck with no signal, drive back, and by
// the time the phone reconnects a second foreman has already filed for that
// same job-day from the office. `file_daily_log` upserts on
// (project_id, log_date). A blind resend would overwrite what the second
// person wrote with what the first person typed an hour earlier — silently,
// on a shared row, with no copy of the lost text anywhere.
//
// THE RULE. Nothing already on the server is thrown away.
//
//   notes      — appended under a line naming whose phone it came from, when
//                the server's copy was touched after this one was queued.
//                Two people's account of the same day is two paragraphs, not
//                a fight over one.
//   headline   — the server's if it has one; the queued one only fills a gap.
//   day_flow   — same. Smooth/Fine/Stuck is a judgement, and the person who
//                was there most recently is the better judge.
//   weather    — same.
//   reflection — merged key by key, the server's answer winning any key both
//                filled. These are four independent one-liners, so keeping
//                both people's is strictly better than picking a side.
//
// WHEN NOTHING RACED. If the server has no log for that job-day, or its row
// has not been touched since this entry was queued, the queued values go
// through unchanged — this is the ordinary case and it must stay boring.

import type { DailyLog, DailyLogReflection, DayFlow } from "./dailyLogs";

/** The daily log as it sat on the phone when the queue took it. */
export interface QueuedDailyLog {
  projectId: string;
  logDate: string;
  headline: string | null;
  notes: string;
  dayFlow: DayFlow | null;
  reflection: DailyLogReflection | null;
  weather: string | null;
  /** ms epoch when this went into the queue — the "since when" of the race. */
  queuedAt: number;
  /** Whose phone it was, for the appended line. */
  authorName: string | null;
}

/** Exactly the arguments `file_daily_log` takes. */
export interface MergedDailyLog {
  headline: string | null;
  notes: string;
  dayFlow: DayFlow | null;
  reflection: DailyLogReflection | null;
  weather: string | null;
}

/** The seam between the queued notes and the ones already on the server. */
export function appendedLine(authorName: string | null): string {
  return authorName
    ? `— added later from ${authorName}'s phone`
    : "— added later from a phone that was offline";
}

function firstNonEmpty(...values: (string | null | undefined)[]): string | null {
  for (const v of values) {
    const trimmed = v?.trim();
    if (trimmed) return trimmed;
  }
  return null;
}

/**
 * True when the server's row changed AFTER this entry was queued — the only
 * case where a blind resend would destroy somebody's writing.
 *
 * An unparseable or missing timestamp counts as "it raced". Being cautious
 * costs an appended paragraph; being wrong costs a day's notes.
 */
export function serverMovedOn(server: DailyLog, queuedAt: number): boolean {
  const stamp = server.updated_at ?? server.created_at;
  const at = stamp ? Date.parse(stamp) : Number.NaN;
  if (!Number.isFinite(at)) return true;
  return at > queuedAt;
}

function mergeReflection(
  server: DailyLogReflection | null,
  queued: DailyLogReflection | null,
): DailyLogReflection | null {
  if (!server) return queued;
  if (!queued) return server;
  // The server's answer wins any key both people filled; the queued one fills
  // the keys the server left blank. Four independent one-liners, so this
  // loses nothing either person wrote.
  const out: DailyLogReflection = { ...queued, ...server };
  for (const [k, v] of Object.entries(out)) {
    if (!v?.trim()) delete out[k as keyof DailyLogReflection];
  }
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * What to send to `file_daily_log` for this queued entry, given whatever the
 * server has for that job-day right now (`null` when nobody has filed one).
 */
export function mergeQueuedDailyLog(
  queued: QueuedDailyLog,
  server: DailyLog | null,
): MergedDailyLog {
  const plain: MergedDailyLog = {
    headline: queued.headline,
    notes: queued.notes,
    dayFlow: queued.dayFlow,
    reflection: queued.reflection,
    weather: queued.weather,
  };
  // Nobody else filed, or nobody has touched it since this was queued: the
  // ordinary case, and it stays exactly what the person typed.
  if (!server || !serverMovedOn(server, queued.queuedAt)) return plain;

  const serverNotes = server.notes?.trim() ?? "";
  const queuedNotes = queued.notes.trim();
  // The identical text back again is not a second account of the day.
  const notes =
    !queuedNotes || serverNotes.includes(queuedNotes)
      ? serverNotes
      : serverNotes
        ? `${serverNotes}\n\n${appendedLine(queued.authorName)}\n${queuedNotes}`
        : queuedNotes;

  return {
    headline: firstNonEmpty(server.headline, queued.headline),
    notes,
    dayFlow: server.day_flow ?? queued.dayFlow,
    reflection: mergeReflection(server.reflection, queued.reflection),
    weather: firstNonEmpty(server.weather, queued.weather),
  };
}
