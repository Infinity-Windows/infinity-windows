/**
 * "Remove this login and start fresh" — the decision half.
 *
 * WHY THIS IS TWO SHAPES AND NOT ONE. The owner asked for the ability to
 * delete an account outright. That is exactly right for the case he was
 * describing — a login typed wrong, a person who never showed up, a duplicate
 * — and exactly wrong for a person who worked here. `profiles.id` references
 * `auth.users(id) ON DELETE CASCADE` (20260715240000_crew_dispatch.sql), so
 * deleting the auth user deletes the profile, and from there:
 *
 *   CASCADE — the rows go with it. Punches, receipts, wages, safety cards,
 *     signed toolbox talks, points, tracked tasks, chat. A paycheck dispute two
 *     years from now would have nothing to read.
 *   SET NULL — the row survives with nobody on it. install_events.installer_id
 *     and .credited_to: the window stays installed and nobody installed it.
 *   RESTRICT (no ON DELETE clause at all) — the delete simply FAILS.
 *     unit_sessions.profile_id, unit_redos.pressed_by, daily_logs.filed_by,
 *     summons.requested_by, opening_phases.started_by/.submitted_by,
 *     time_shift_edits.edited_by, flash_run_assignments.assigned_by.
 *
 * So the decision is made by the data, not by the person pressing the button:
 * count the rows first. Nothing on file → the hard delete is safe and the
 * email is genuinely free. Anything on file → nothing is deleted, ever; the
 * login is closed and the profile is marked retired instead.
 *
 * WHY THE EMAIL IS RENAMED RATHER THAN THE ROW DELETED. The point of the
 * feature is "start fresh": the same person (or the same address) must be able
 * to be invited again and land on a NEW account. Supabase Auth holds emails
 * unique across auth.users, so a banned account keeps its address hostage
 * forever — `create_invite` would answer "that email already has an account"
 * and there would be no way past it. Renaming the banned user's address to a
 * tombstone (`<uid>@removed.invalid`) frees the real address without touching
 * one row of history: every record still points at the same profile id, which
 * is what every join in this database is keyed on. `.invalid` is the RFC 2606
 * reserved TLD — it can never be a real mailbox, so a tombstone cannot collide
 * with anybody's address, and the uid guarantees two tombstones never collide
 * with each other.
 *
 * WHY THE TABLE NAMES ARE NOT IN THIS FILE. The counting is done by
 * `person_record_counts` (20260987000000) and the words are in
 * app/src/lib/purgeWords.ts. Wave Z's standing guarantee is that no edge
 * function ever names the wage table — they hold the service-role key, which
 * bypasses RLS entirely — and app/src/lib/payRates.test.ts enforces that by
 * scanning every file under supabase/functions. This module is under that
 * directory, so it holds the decision and no schema at all.
 */

/** `table.column` → how many rows this person has there. */
export type HistoryCounts = Record<string, number>;

/**
 * The count the server returns when it could not take the real ones — a
 * database that has not had 20260987000000 yet, or anything that failed. Not a
 * table: a stand-in for "we do not know", which always has to read as "there is
 * history here", because keeping a record you did not need is recoverable and
 * deleting one you did is not.
 */
export const UNKNOWN_RECORDS = "unknown.records";

/**
 * Does this person have anything on file worth keeping?
 *
 * Deliberately reads the WHOLE counts object rather than a known list of keys:
 * a count for a table added after this file was written still means "there is
 * something here", and the safe answer to a surprise is always "keep it".
 */
export function hasWorkHistory(counts: HistoryCounts): boolean {
  return Object.values(counts).some((n) => Number(n) > 0);
}

/** Which of the two things happens. Named for what the owner will read back. */
export type PurgeShape = "deleted" | "retired";

export function shapeFor(counts: HistoryCounts): PurgeShape {
  return hasWorkHistory(counts) ? "retired" : "deleted";
}

/** `<uid>@removed.invalid` — see the header on why a tombstone, not a delete. */
export function tombstoneEmail(userId: string): string {
  return `${userId}@removed.invalid`;
}

/** Would this address be one of ours? Used to keep a tombstone out of the UI. */
export function isTombstoneEmail(email: string | null | undefined): boolean {
  return /@removed\.invalid$/i.test((email ?? "").trim());
}
