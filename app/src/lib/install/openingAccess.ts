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

/**
 * Every foreman-only guard on this table opens the same way, so one detector
 * covers moving a mark, adding one and removing one — and whatever is guarded
 * next, without another round of plumbing.
 */
const FOREMAN_ONLY = /^Only a foreman or above can /;

/**
 * The plain sentence behind a foreman-only refusal, or null if this failure is
 * something else entirely.
 *
 * Matched on the message rather than the `42501` code alone, because Postgres
 * uses that code for every ordinary permission error — an RLS denial included —
 * and those say nothing a person can act on.
 */
export function foremanOnlyRefusal(err: unknown): string | null {
  if (err == null || typeof err !== "object") return null;
  const message = (err as { message?: unknown }).message;
  if (typeof message !== "string") return null;
  const trimmed = message.trim();
  return FOREMAN_ONLY.test(trimmed) ? trimmed : null;
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
 * Everything recorded against an opening that a removal would destroy, worst
 * first. An installed opening leads, because deleting it cascades its install
 * history away and that is the one thing nobody can type back in.
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
 * Deleting a duplicate the extract invented and deleting a window someone has
 * already installed are the same two taps, so the question has to say which one
 * this is. Naming the losses is the whole point — a bare "Are you sure?" is
 * what let this be dangerous.
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
  const lost = losses(opening, referencedElsewhere);
  if (lost.length === 0) {
    return `${head}\n\nNothing has been recorded against it yet, so this only removes the mark. It cannot be undone.`;
  }
  return `${head}\n\nThis also deletes ${joinList(lost)}. It cannot be undone.`;
}
