// Pure schedule-notice logic: turns a person's currently-published
// assignments into (1) the revision-aware fingerprint tokens that decide
// whether the "schedule-published" row in Notifications reopens after a
// substantive date/hour change, and (2) the honest, bilingual detail lines
// the row shows for what is CURRENTLY scheduled — never an invented
// before/after diff.
//
// WHY A SEPARATE FILE FROM notify.ts: notify.ts decides WHO to (re)notify on
// an edit (push/audit concern, unowned here). This file is the in-app
// Notifications feed's own read of the CURRENT state, keyed by
// `notice_revision` (20261048000000) rather than membership diffing.

import { formatConflictClock } from "./conflictDisplay";
import type { Lang } from "../i18n/translate";

/** The minimal shape a row needs to fingerprint and render. */
export interface NoticeAssignment {
  id: string;
  start_date: string;
  end_date: string;
  start_time: string | null;
  end_time?: string | null;
  notice_revision?: number;
  kind: "install" | "delivery";
  project?: { job_code: string; name: string } | null;
  delivery?: { label: string | null } | null;
}

/**
 * Revision-aware dismissal fingerprint tokens. A row whose `notice_revision`
 * is 0 or missing (not yet bumped, pre-migration, or a stale/offline-cache
 * read) keeps its bare id — the EXACT legacy token, duplicates included, so
 * every existing cleared digest stays cleared. A row the trigger has bumped
 * at least once becomes `id:revision`, so the digest's dismissal key changes
 * and the row reappears. Order follows the input (callers sort the result
 * for a canonical fingerprint, matching the existing helper's convention).
 */
export function noticeFingerprintTokens(
  assignmentIds: readonly string[],
  revisionById: ReadonlyMap<string, number | undefined>,
): string[] {
  return assignmentIds.map((id) => {
    const revision = revisionById.get(id);
    return typeof revision === "number" && Number.isSafeInteger(revision) && revision > 0 ? `${id}:${revision}` : id;
  });
}

/** Index a list of assignments by id for `noticeFingerprintTokens`. */
export function revisionById(
  assignments: readonly NoticeAssignment[],
): Map<string, number | undefined> {
  const map = new Map<string, number | undefined>();
  for (const a of assignments) map.set(a.id, a.notice_revision);
  return map;
}

function jobLabel(a: NoticeAssignment, strings: NoticeRowStrings): string {
  if (a.kind === "delivery") return a.delivery?.label?.trim() || strings.delivery;
  const code = a.project?.job_code?.trim();
  const name = a.project?.name?.trim();
  if (code && name) return `${code} · ${name}`;
  return code || name || strings.job;
}

function monthDayLabel(iso: string, lang: Lang): string {
  const locale = lang === "es" ? "es-MX" : "en-US";
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString(locale, {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

/** "Sep 30" for a single day, "Sep 30–Oct 2" for a range. */
export function noticeDateLabel(a: Pick<NoticeAssignment, "start_date" | "end_date">, lang: Lang): string {
  return a.start_date === a.end_date
    ? monthDayLabel(a.start_date, lang)
    : `${monthDayLabel(a.start_date, lang)}–${monthDayLabel(a.end_date, lang)}`;
}

/** Bilingual fallback copy for the two honest non-answers a stored clock can
 * give: genuinely not set, or present but not well-formed. */
export interface NoticeHourStrings {
  notSet: string;
  checkTime: string;
  noHoursSet: string;
}

export interface NoticeRowStrings extends NoticeHourStrings {
  job: string;
  delivery: string;
}

/** "8:00 AM–4:00 PM" (en) / "08:00–16:00" (es), or an honest not-set/invalid
 * marker — never a guessed time. Mirrors ConflictPairDetails' same rule. */
export function noticeHoursLabel(a: Pick<NoticeAssignment, "start_time" | "end_time">, lang: Lang, strings: NoticeHourStrings): string {
  const clock = (value: string | null | undefined) =>
    formatConflictClock(value ?? null, lang) ?? (value ? strings.checkTime : strings.notSet);
  if (!a.start_time && !a.end_time) return strings.noHoursSet;
  return `${clock(a.start_time)}–${clock(a.end_time)}`;
}

export interface NoticeRow {
  id: string;
  line: string;
}

/** Default cap on rendered rows — the dismissal fingerprint covers every
 * assignment regardless; this only bounds the feed's own display. */
export const NOTICE_ROW_LIMIT = 5;

/**
 * One line per still-visible published assignment: job, current date(s), and
 * current hours, honest about missing/invalid times — in the viewer's
 * language. De-duplicated on (id, dates, hours) rather than id alone, since a
 * time-off split can legitimately repeat an id across distinct day segments
 * (lib/timeOff/model.ts availableAssignments) that must not be hidden from
 * each other. Sorted by date, then capped, with an honest omitted count —
 * never a deduplication that would change the fingerprint above.
 */
export function buildNoticeRows(
  assignments: readonly NoticeAssignment[],
  lang: Lang,
  strings: NoticeRowStrings,
  limit = NOTICE_ROW_LIMIT,
): { rows: NoticeRow[]; omitted: number } {
  const seen = new Set<string>();
  const unique: NoticeAssignment[] = [];
  for (const a of assignments) {
    const key = `${a.id}|${a.start_date}|${a.end_date}|${a.start_time ?? ""}|${a.end_time ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(a);
  }
  unique.sort((a, b) => a.start_date.localeCompare(b.start_date) || a.id.localeCompare(b.id));
  const rows = unique.slice(0, limit).map((a) => ({
    id: a.id,
    line: `${jobLabel(a, strings)} · ${noticeDateLabel(a, lang)} · ${noticeHoursLabel(a, lang, strings)}`,
  }));
  return { rows, omitted: Math.max(0, unique.length - rows.length) };
}
