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
//   notes      — appended under a line saying it came in late, unless the
//                queued text already CONTAINS the server's, which is what an
//                ordinary edit looks like: the dialog seeded the box from the
//                server's row and the person typed on the end of it. Two
//                people's account of the same day is two paragraphs, not a
//                fight over one.
//   headline   — the server's if it has one; the queued one only fills a gap.
//   day_flow   — same. Smooth/Fine/Stuck is a judgement, and the person who
//                was there most recently is the better judge.
//   weather    — same.
//   reflection — merged key by key, the server's answer winning any key both
//                filled. These are four independent one-liners, so keeping
//                both people's is strictly better than picking a side.
//
// WHEN NOTHING RACED. If the server has no log for that job-day, or its notes
// are already inside the queued ones, the queued values go through unchanged —
// this is the ordinary case and it must stay boring.
//
// WHY THE TEST IS "DOES THE QUEUED TEXT CONTAIN THE SERVER'S" AND NOT A
// TIMESTAMP. It used to compare the server's updated_at against the moment the
// phone queued the entry, and only merge when the server looked newer. Two
// separate things broke that.
//
//   1. The two numbers come off two different clocks — the phone's and
//      Postgres's. This repo already knows phone clocks lie: lib/clockSkew.ts
//      exists, and ClockSheet has a "my time is wrong" checkbox. A phone a few
//      minutes fast concluded "nobody raced" when somebody had.
//   2. Offline, the dialog cannot READ the existing log at all — the query
//      pauses and the notes box opens empty. So the queued entry never saw the
//      server's row, its own timestamp says nothing about whether it did, and
//      the "nobody raced" branch is exactly the wrong one to take.
//
// Containment answers the question that actually matters — did this text come
// from the server's text? — and needs no clock at all.

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
}

/** Exactly the arguments `file_daily_log` takes. */
export interface MergedDailyLog {
  headline: string | null;
  notes: string;
  dayFlow: DayFlow | null;
  reflection: DailyLogReflection | null;
  weather: string | null;
}

/**
 * The seam between the queued notes and the ones already on the server.
 *
 * It names NOBODY, and that is the point. Daily-log notes are one of the few
 * crew-written things that leave the crew: stg_day hands `headline`, `notes`
 * and `day_flow` to a builder or GC login, and deliberately withholds
 * `filed_by` because who on the crew wrote it is not that login's business.
 * A name spliced into the notes would walk straight through that wall — and
 * the first version of this line put an email address there. Whose phone it
 * was is already on the row (`updated_by`), where the partner wall can hold
 * it back.
 */
export function appendedLine(): string {
  return "— added later from a phone that was offline";
}

function firstNonEmpty(...values: (string | null | undefined)[]): string | null {
  for (const v of values) {
    const trimmed = v?.trim();
    if (trimmed) return trimmed;
  }
  return null;
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
  // Nobody else filed at all: the ordinary case, and it stays exactly what the
  // person typed.
  if (!server) return plain;

  const serverNotes = server.notes?.trim() ?? "";
  const queuedNotes = queued.notes.trim();
  // The queued text already carries the server's inside it, so this IS the
  // server's log with an edit on it — the dialog seeded the box from that row
  // and somebody typed. Nothing to preserve, and the edit wins outright (which
  // is what makes deleting a line still work). The server having nothing to
  // lose lands here too.
  if (!serverNotes || queuedNotes.includes(serverNotes)) return plain;

  // The identical text back again is not a second account of the day — this is
  // the retry after a lost reply, where the server now holds what we sent.
  const notes = !queuedNotes
    ? serverNotes
    : serverNotes.includes(queuedNotes)
      ? serverNotes
      : `${serverNotes}\n\n${appendedLine()}\n${queuedNotes}`;

  return {
    headline: firstNonEmpty(server.headline, queued.headline),
    notes,
    dayFlow: server.day_flow ?? queued.dayFlow,
    reflection: mergeReflection(server.reflection, queued.reflection),
    weather: firstNonEmpty(server.weather, queued.weather),
  };
}
