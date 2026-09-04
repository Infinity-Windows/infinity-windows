/**
 * "Remove this login and start fresh" — the words half.
 *
 * The decision (delete or retire, and the tombstone address) lives in
 * supabase/functions/_shared/purgeLogin.ts, because the server makes it. This
 * file turns the counts that decision was made from into the one sentence the
 * owner reads BEFORE he presses the button:
 *
 *   "Nothing on file for Eduardo — the account will be deleted and the email
 *    freed."
 *   "Enrique has 14 punches and 3 receipts on file — the login will be closed,
 *    the email freed, and every record kept under their name."
 *
 * A generic "are you sure?" is what makes a destructive button dangerous. The
 * sheet says which of the two things is about to happen, in the person's own
 * name, with the numbers the server actually counted.
 *
 * WHY IT IS A SEPARATE FILE FROM THE DECISION. It names tables, and one of
 * them is the wage table. Wave Z's standing guarantee is that no edge function
 * ever names it — the functions hold the service-role key, which bypasses RLS,
 * so one `.from()` there would put every wage in the company one edit away
 * from a model's context, and app/src/lib/payRates.test.ts enforces it by
 * scanning every file under supabase/functions. So the schema lives on this
 * side of the line, where that guarantee is not at stake.
 *
 * THE KEYS ARE A CONTRACT. They are the exact strings
 * `public.person_record_counts` (20260987000000) returns, and
 * purgeLogin.test.ts reads the migration and fails if the two lists ever stop
 * agreeing — a key added on one side only would be a count that is taken and
 * never named, or named and never taken.
 */

import type { HistoryCounts } from "../../../supabase/functions/_shared/purgeLogin";
import {
  hasWorkHistory,
  type PurgeShape,
} from "../../../supabase/functions/_shared/purgeLogin";

/** One count the server takes before deciding, and how to say it out loud. */
export interface HistoryProbe {
  /** Table counted in. */
  table: string;
  /** The column holding a profile id. */
  column: string;
  /** Plain English for one row, and for many. */
  one: string;
  many: string;
}

/**
 * Every table a person's work, money or safety record lives in.
 *
 * COMPLETENESS RULE, so this list can be checked rather than trusted: every
 * RESTRICT foreign key to `profiles` in the schema is in here (there are eight
 * such columns — see the header of _shared/purgeLogin.ts), because a hard
 * delete would otherwise fail outright; every CASCADE one whose rows are a
 * record of work, money or safety is in here, because a hard delete would
 * silently take them. Columns that are SET NULL and merely decorative —
 * `updated_by`, `resolved_by`, `granted_by` and friends — are deliberately NOT
 * here: losing "who ticked this box" is not losing a record of somebody's work,
 * and a person whose only trace is one of those is exactly the mistyped login
 * this feature is for.
 *
 * ORDER MATTERS for the sentence only: the first non-zero counts are the ones
 * named, so the heaviest, most recognisable records come first.
 */
export const WORK_HISTORY_PROBES: readonly HistoryProbe[] = [
  { table: "time_shifts", column: "profile_id", one: "punch", many: "punches" },
  {
    table: "unit_sessions",
    column: "profile_id",
    one: "work session",
    many: "work sessions",
  },
  {
    table: "install_events",
    column: "installer_id",
    one: "install",
    many: "installs",
  },
  {
    table: "install_events",
    column: "credited_to",
    one: "credited install",
    many: "credited installs",
  },
  { table: "receipts", column: "uploaded_by", one: "receipt", many: "receipts" },
  { table: "pay_rates", column: "profile_id", one: "pay rate", many: "pay rates" },
  {
    table: "certifications",
    column: "profile_id",
    one: "safety card",
    many: "safety cards",
  },
  {
    table: "toolbox_completions",
    column: "profile_id",
    one: "signed safety talk",
    many: "signed safety talks",
  },
  { table: "daily_logs", column: "filed_by", one: "day log", many: "day logs" },
  {
    table: "opening_phases",
    column: "started_by",
    one: "flashing run",
    many: "flashing runs",
  },
  {
    table: "opening_phases",
    column: "submitted_by",
    one: "finished flashing run",
    many: "finished flashing runs",
  },
  {
    table: "flash_run_assignments",
    column: "assigned_by",
    one: "flashing hand-out",
    many: "flashing hand-outs",
  },
  {
    table: "summons",
    column: "requested_by",
    one: "call for help",
    many: "calls for help",
  },
  {
    table: "summon_helpers",
    column: "profile_id",
    one: "time helping somebody",
    many: "times helping somebody",
  },
  { table: "unit_redos", column: "pressed_by", one: "redo", many: "redos" },
  {
    table: "time_shift_edits",
    column: "edited_by",
    one: "timecard edit",
    many: "timecard edits",
  },
  {
    table: "points_ledger",
    column: "profile_id",
    one: "points entry",
    many: "points entries",
  },
  {
    table: "task_sessions",
    column: "profile_id",
    one: "tracked task",
    many: "tracked tasks",
  },
  {
    table: "project_messages",
    column: "author_id",
    one: "chat message",
    many: "chat messages",
  },
] as const;

/** The key a probe's count is filed under. */
export function probeKey(probe: HistoryProbe): string {
  return `${probe.table}.${probe.column}`;
}

/** "14 punches", "1 receipt" — a count in words, for the sentence below. */
function countInWords(probe: HistoryProbe, n: number): string {
  return `${n} ${n === 1 ? probe.one : probe.many}`;
}

/**
 * The non-zero counts, heaviest first, at most `limit` of them.
 *
 * `limit` exists because the sentence is read on a phone: "14 punches, 3
 * receipts and 2 safety cards" is a sentence, and the same line carrying all
 * nineteen probes is a wall.
 */
export function historyHighlights(
  counts: HistoryCounts,
  limit = 3,
): { key: string; words: string }[] {
  const out: { key: string; words: string }[] = [];
  for (const probe of WORK_HISTORY_PROBES) {
    const n = Number(counts[probeKey(probe)] ?? 0);
    if (n > 0) out.push({ key: probeKey(probe), words: countInWords(probe, n) });
    if (out.length >= limit) break;
  }
  return out;
}

/** "a, b and c" — the English list, not the comma-spliced one. */
function joinWords(parts: string[]): string {
  if (parts.length <= 1) return parts[0] ?? "";
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/**
 * The whole sentence the confirm sheet shows, so the owner knows which of the
 * two things he is about to do BEFORE he does it.
 *
 * English only on purpose: Crew access is an owner screen, like the rest of
 * this feature's callers. See the PR body.
 */
export function removalSentence(
  displayName: string | null | undefined,
  counts: HistoryCounts,
): string {
  const name = (displayName ?? "").trim() || "This person";
  if (!hasWorkHistory(counts)) {
    return `Nothing on file for ${name} — the account will be deleted and the email freed.`;
  }
  const shown = historyHighlights(counts);
  if (shown.length === 0) {
    // Something is on file that this build has no words for — including
    // UNKNOWN_RECORDS, the count the server returns when it could not check at
    // all. Say so plainly rather than invent a list; the promise afterwards is
    // the part that matters, and it is the same promise either way.
    return (
      `${name} has work on file — the login will be closed, the email freed, ` +
      `and every record kept under their name.`
    );
  }
  const listed = joinWords(shown.map((h) => h.words));
  const total = Object.values(counts).filter((n) => Number(n) > 0).length;
  const more = total > shown.length ? ", and more," : "";
  return (
    `${name} has ${listed}${more} on file — the login will be closed, ` +
    `the email freed, and every record kept under their name.`
  );
}

/** What the owner reads after it happened. */
export function removalResultSentence(
  displayName: string | null | undefined,
  shape: PurgeShape,
): string {
  const name = (displayName ?? "").trim() || "That login";
  return shape === "deleted"
    ? `${name}'s account is gone and the email is free to use again.`
    : `${name} can't sign in any more, the email is free to use again, and every record is still filed under their name.`;
}
