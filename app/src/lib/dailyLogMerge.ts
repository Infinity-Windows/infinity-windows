// Merge a phone's queued daily log with a shared server row.
// A full replacement is allowed only when the phone names the server revision
// it actually saw and that revision still matches. Legacy queue entries and
// stale drafts preserve server fields and append new notes. The outbox reads
// first, then the database checks that revision atomically at write time.

import type { DailyLog, DailyLogReflection, DayFlow } from "./dailyLogs";
import type { DailyLogProgressFields } from "./dailyLogStages";

/** The daily log as it sat on the phone when the queue took it. */
export interface QueuedDailyLog extends DailyLogProgressFields {
  projectId: string;
  logDate: string;
  headline: string | null;
  notes: string;
  dayFlow: DayFlow | null;
  reflection: DailyLogReflection | null;
  weather: string | null;
  baseRevision?: number | null;
  /**
   * Did THIS phone actually answer for the fourteen structured fields above,
   * or are they the empty defaults because the entry that queued this never
   * knew about them (a client older than this wave, or a malformed replay)?
   * Required, not inferred from emptiness — a person can deliberately clear
   * every structured field to empty, and that must still count as answered.
   * Required so every construction site states it on purpose, the same
   * discipline baseRevision already gets.
   *
   * This is what the independent Astra review's finding #1 was about: the
   * CONFLICT path (pickProgress) was always safe — an empty queued value
   * already loses to a non-empty server one — but the `plain` path below
   * (a confirmed-matching base) sends `queued` as a full, deliberate
   * replacement, and a legacy caller's empty defaults are not that.
   */
  progressProvided: boolean;
}

/** Exactly the arguments `file_daily_log` takes. */
export interface MergedDailyLog extends DailyLogProgressFields {
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

/** One structured field where the phone's queued answer and the server's
 * current answer disagreed. Carried for LOCAL review only (lib/
 * dailyLogProgressConflicts.ts) — never written to daily_logs.notes, which
 * stg_day shares with a builder login, and never auto-resolved. */
export interface ProgressConflict {
  field: keyof DailyLogProgressFields;
  /** The phone's own value, preserved so a human can restore it later. The
   * row itself is left factually unchanged for this field (see pickProgress). */
  queuedValue: unknown;
}

// A progress report is one observation. Never manufacture a report by
// combining counts/stages from different revisions, including deliberate clears.
function mergeProgress(queued:QueuedDailyLog,server:DailyLog,conflicts:ProgressConflict[]):DailyLogProgressFields {
  const keys: (keyof DailyLogProgressFields)[]=['workStages','stageProgress','covers','delays','safetyStatus','weatherImpact','missingTomorrow','tomorrowStages','tomorrowCrewExpected','tomorrowPlan','unitsToday','unitsToDate','unitsRemaining','unitsRemainingDetail'];
  for(const field of keys){
    if(queued.progressProvided && JSON.stringify(queued[field])!==JSON.stringify(server[field]))conflicts.push({field,queuedValue:queued[field]});
  }
  return Object.fromEntries(keys.map(field=>[field,server[field]])) as unknown as DailyLogProgressFields;
}

export interface MergeOutcome {
  merged: MergedDailyLog;
  /** Empty on the ordinary path. Non-empty only when a structured field
   * genuinely disagreed between the phone and the server — see
   * ProgressConflict. */
  progressConflicts: ProgressConflict[];
  /**
   * What the caller must send as `p_progress_provided`. True whenever
   * `merged`'s fourteen structured fields are a deliberate, safe-to-apply
   * answer (this phone answered for them, or — on a conflict — every field
   * was already resolved field-by-field to either side's genuine value).
   * False only on the `plain`/matching-base path when this phone's own
   * entry never answered for them at all: sending `merged`'s (empty)
   * progress fields with provided=true there would overwrite real data
   * with silence, which is exactly the bug this flag exists to prevent.
   */
  progressProvided: boolean;
}

/**
 * What to send to `file_daily_log` for this queued entry, given whatever the
 * server has for that job-day right now (`null` when nobody has filed one).
 */
export function mergeQueuedDailyLog(
  queued: QueuedDailyLog,
  server: DailyLog | null,
): MergeOutcome {
  const plain: MergedDailyLog = {
    headline: queued.headline,
    notes: queued.notes,
    dayFlow: queued.dayFlow,
    reflection: queued.reflection,
    weather: queued.weather,
    workStages: queued.workStages,
    stageProgress: queued.stageProgress,
    covers: queued.covers,
    delays: queued.delays,
    safetyStatus: queued.safetyStatus,
    weatherImpact: queued.weatherImpact,
    missingTomorrow: queued.missingTomorrow,
    tomorrowStages: queued.tomorrowStages,
    tomorrowCrewExpected: queued.tomorrowCrewExpected,
    tomorrowPlan: queued.tomorrowPlan,
    unitsToday: queued.unitsToday,
    unitsToDate: queued.unitsToDate,
    unitsRemaining: queued.unitsRemaining,
    unitsRemainingDetail: queued.unitsRemainingDetail,
  };
  // Nobody else filed at all: the ordinary case, and it stays exactly what the
  // person typed — including progress, since there is nothing to preserve.
  if (!server) return { merged: plain, progressConflicts: [], progressProvided: queued.progressProvided };

  // Only a confirmed unchanged base authorizes a full replacement, including
  // deliberate deletions. Older queue entries have no such proof. progressProvided
  // carries straight through from the QUEUED entry's own claim: true only when
  // THIS phone actually answered for the structured fields it is about to send
  // as a full replacement — never assumed from a non-empty server row existing.
  if (queued.baseRevision != null && queued.baseRevision === server.revision) {
    return { merged: plain, progressConflicts: [], progressProvided: queued.progressProvided };
  }

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
  // TEXT-ONLY fields keep the legacy additive merge exactly as before —
  // the brief's own instruction. Structured progress fields NEVER join this
  // narrative (pickProgress above); safety status most of all, since this
  // text is what stg_day hands to a builder login.
  const details = phoneDetails(queued, server);
  const detailBlock = `— other details recorded on the offline phone\n${details.join("\n")}`;
  const notesWithDetails = details.length && !notes.includes(detailBlock)
    ? `${notes}\n\n${detailBlock}`
    : notes;

  const progressConflicts: ProgressConflict[] = [];
  const progress = mergeProgress(queued, server, progressConflicts);

  return {
    merged: {
      headline: firstNonEmpty(server.headline, queued.headline),
      notes: notesWithDetails,
      dayFlow: server.day_flow ?? queued.dayFlow,
      reflection: mergeReflection(server.reflection, queued.reflection),
      weather: firstNonEmpty(server.weather, queued.weather),
      ...progress,
    },
    progressConflicts,
    // Preserve the whole current observation; the queued one waits for review.
    progressProvided: false,
  };
}
