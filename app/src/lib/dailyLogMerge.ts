// Merge a phone's queued daily log with a shared server row.
// A full replacement is allowed only when the phone names the server revision
// it actually saw and that revision still matches. Legacy queue entries and
// stale drafts preserve server fields and append new notes. The outbox reads
// first, then the database checks that revision atomically at write time.

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
  baseRevision?: number | null;
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

/** Preserve a phone's conflicting optional answers in the narrative when the
 * server field wins. Otherwise the queue would silently throw those answers
 * away, especially for entries made by an older client without baseRevision. */
function phoneDetails(queued: QueuedDailyLog, server: DailyLog): string[] {
  const details: string[] = [];
  const add = (label: string, phone: string | null | undefined, current: string | null | undefined) => {
    if (phone?.trim() && current?.trim() && phone.trim() !== current.trim())
      details.push(`${label}: ${phone.trim()}`);
  };
  add("Headline", queued.headline, server.headline);
  add("Day flow", queued.dayFlow, server.day_flow);
  add("Weather", queued.weather, server.weather);
  for (const [key, label] of [
    ["went_well", "Went well"], ["went_poorly", "Went poorly"],
    ["would_have_helped", "Would have helped"], ["what_worked", "What worked"],
  ] as const) add(label, queued.reflection?.[key], server.reflection?.[key]);
  return details;
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

  // Only a confirmed unchanged base authorizes a full replacement, including
  // deliberate deletions. Older queue entries have no such proof.
  if (queued.baseRevision != null && queued.baseRevision === server.revision) return plain;

  const serverNotes = server.notes?.trim() ?? "";
  const queuedNotes = queued.notes.trim();
  // Containing the server notes says nothing about changes to weather, flow,
  // headline or reflections since this phone went offline.

  // If the phone already contains the server's notes, keep that edit once;
  // text overlap still does not authorize replacing any other field.
  const notes = !queuedNotes
    ? serverNotes
    : serverNotes.includes(queuedNotes)
      ? serverNotes
      : serverNotes && queuedNotes.includes(serverNotes)
        ? queuedNotes
      : `${serverNotes}\n\n${appendedLine()}\n${queuedNotes}`;
  const details = phoneDetails(queued, server);
  const detailBlock = `— other details recorded on the offline phone\n${details.join("\n")}`;
  const notesWithDetails = details.length && !notes.includes(detailBlock)
    ? `${notes}\n\n${detailBlock}`
    : notes;

  return {
    headline: firstNonEmpty(server.headline, queued.headline),
    notes: notesWithDetails,
    dayFlow: server.day_flow ?? queued.dayFlow,
    reflection: mergeReflection(server.reflection, queued.reflection),
    weather: firstNonEmpty(server.weather, queued.weather),
  };
}
