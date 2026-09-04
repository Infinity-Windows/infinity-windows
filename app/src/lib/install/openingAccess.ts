// Who may create or remove a window/door on a job, and what the crew is told
// when they may not — plus the sentence shown before a removal actually goes
// through. No React, no Supabase, so the wording and the rules can be proven
// without a browser.
//
// Adding an opening and removing one are foreman+ in the database
// (20260730180000_foreman_only_opening_create_delete.sql), which is what makes
// re-reading a planset a foreman's job: a re-extract is a delete followed by an
// insert, and both halves are guarded.

import type { OpeningCondition, OpeningStatus } from "./types";

/**
 * The exact sentences the database raises. Duplicated here so the app can show
 * them on their own rather than as PostgREST's `… [42501]`, and asserted
 * against the migration text by openingAccess.test.ts, so the two can never
 * drift apart silently.
 */
export const OPENING_CREATE_DENIED =
  "Only a foreman or above can add windows or doors to a job.";
export const OPENING_DELETE_DENIED =
  "Only a foreman or above can remove a window or door from a job.";
export const OPENING_RESTORE_DENIED =
  "Only a foreman or above can put a window or door back on a job.";
export const REMOVED_LIST_DENIED =
  "Only a foreman or above can see what was removed from a job.";

/**
 * Every sentence the database raises at somebody holding a phone, as a shape.
 *
 * Matched on the wording rather than the SQLSTATE, because Postgres reuses
 * `42501` for every ordinary permission error — an RLS denial included — and
 * those say nothing a person can act on. Anything matching here is rethrown as
 * a bare Error so it reaches the crew on its own, without PostgREST's trailing
 * `[42501]`; anything else is left alone for `formatApiError`.
 *
 * openingAccess.test.ts holds these against the migrations, both ways: every
 * sentence here must exist in the SQL, and every sentence the SQL raises must
 * match one of these. Adding a refusal to the database without teaching the app
 * to read it fails the test rather than reaching a foreman as raw Postgres text.
 */
const CREW_SENTENCES = [
  /^Only a foreman or above can /,
  /^That window or door /,
  /^There is already a #.+ on this job, /,
  /^Use Remove or Put back /,
  // Wave Y: filing an install under a name the crew list does not have. Not a
  // rank refusal — it is "that person is not one of ours" — but it is aimed at
  // a person on a phone in exactly the same way, so it travels the same road.
  /^That person is not on the crew list/,
  // Wave Y again, from the table guard: reaching into somebody else's filed
  // install. Names two people who MAY, so it does not start "Only a foreman".
  /^Only the person who filed this install, or a foreman, /,
];

/**
 * The plain sentence behind a deliberate database refusal, or null if this
 * failure is something else entirely.
 */
export function foremanOnlyRefusal(err: unknown): string | null {
  if (err == null || typeof err !== "object") return null;
  const message = (err as { message?: unknown }).message;
  if (typeof message !== "string") return null;
  const trimmed = message.trim();
  return CREW_SENTENCES.some((re) => re.test(trimmed)) ? trimmed : null;
}

/** What a removal would take with it, as far as the review screen can see. */
export interface DeletableOpening {
  opening_code: string;
  status: OpeningStatus;
  ro_width_in: number | null;
  ro_height_in: number | null;
  condition: OpeningCondition;
  flag_note: string | null;
  assigned_to: string | null;
  assignee?: { display_name: string } | null;
}

/**
 * Everything recorded against an opening that goes into hiding with it, worst
 * first. Install history leads: it is the one thing nobody could type back in,
 * which is precisely why removal stopped destroying it.
 */
function losses(opening: DeletableOpening, referencedElsewhere: boolean): string[] {
  const out: string[] = [];
  if (opening.status === "installed" || referencedElsewhere) {
    out.push("its install history");
  }
  if (opening.assigned_to) {
    const who = opening.assignee?.display_name?.trim();
    out.push(who ? `the work assigned to ${who}` : "the work assigned to someone");
  }
  if (opening.ro_width_in != null || opening.ro_height_in != null) {
    out.push("the rough opening someone measured");
  }
  if (opening.condition && opening.condition !== "unknown") {
    out.push("the condition check");
  }
  if (opening.flag_note?.trim()) {
    out.push("the flag raised on it");
  }
  return out;
}

/** "a, b and c" — an Oxford-free list a non-technical reader can skim. */
function joinList(parts: string[]): string {
  if (parts.length <= 1) return parts[0] ?? "";
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/**
 * What the foreman is asked before an opening is removed.
 *
 * Removing a duplicate the extract invented and removing a window someone has
 * already worked on are the same two taps, so the question has to say which one
 * this is. Naming what goes with it is the whole point — a bare "Are you sure?"
 * is what let this be dangerous.
 *
 * The last line used to read "It cannot be undone", which was true when this
 * really did delete the row and cascade its install history away. It hides the
 * mark now, so saying that would be a lie in the one place a foreman most needs
 * to be told the truth: the moment before they tap yes.
 */
export function describeOpeningDeletion(params: {
  opening: DeletableOpening;
  referencedElsewhere: boolean;
  jobLabel?: string | null;
}): string {
  const { opening, referencedElsewhere } = params;
  const mark = `#${opening.opening_code}`;
  const job = params.jobLabel?.trim();
  const head = `Remove ${mark}${job ? ` from ${job}` : ""}?`;
  const back = "You can put it back from Removed at the bottom of this screen.";
  const lost = losses(opening, referencedElsewhere);
  if (lost.length === 0) {
    return `${head}\n\nNothing has been recorded against it yet, so this just takes the mark off the job. ${back}`;
  }
  return `${head}\n\nIt goes off the job along with ${joinList(lost)} — nothing is deleted. ${back}`;
}
