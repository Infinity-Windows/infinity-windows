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

/**
 * The sentence a removed login gets wherever somebody tries to revive it.
 *
 * Lives here rather than in manage-crew-access because three doors say it —
 * "Let them back in", "New password code" and a second attempt at removal —
 * and they must say the same thing.
 */
export const ALREADY_REMOVED =
  'That login was removed for good, so there is nothing to switch back on. Add them again under "Add someone" and they\'ll get a fresh login.';

/** Removing the login the automated checks sign in with. */
export const PURGE_TEST_LOGIN_REFUSED =
  "That's the automation login the tests sign in with, not a person's login. " +
  "Removing it would break the checks that run before every deploy.";

/** The database is behind the app, so a removal could not be written down. */
export const PURGE_CANNOT_RECORD =
  "This needs the app's latest database update, which hasn't landed yet. " +
  "Switch their access off for now and remove the login after the next deploy.";

/**
 * Everything the third door refuses on the strength of the target row alone.
 *
 * Pure and separate from the endpoint so it can be read and tested in one
 * piece: this is a ONE-WAY DOOR, and the refusals are the only thing standing
 * between a wrong tap and a login nobody can rebuild.
 *
 * `canRecordRetirement` is the one that is not about the person. On a database
 * that has not had 20260987000000 yet there is no `profiles.retired_at` to
 * stamp, and the removal would still run: the account gets banned, its email
 * gets handed back, and then the write that says "removed for good" fails. What
 * is left looks exactly like an ordinary switched-off account — it sits in
 * "Access switched off" under a working "Let them back in" button, which
 * un-bans an account whose only address is now `<uid>@removed.invalid`. Nobody
 * can sign in to it and nothing says why. The backend deploys as its own
 * workflow and has silently failed before, so this is not a hypothetical. The
 * refusal is checked BEFORE anything is banned or renamed, and the preview runs
 * the same ladder, so the sheet says so before the owner commits.
 */
export function purgeRowRefusal(args: {
  isPartner: boolean;
  isTest: boolean;
  alreadyRetired: boolean;
  canRecordRetirement: boolean;
}): { error: string; status: number } | null {
  // A builder's login is not a crew login and is not managed from this screen —
  // it is granted and taken away with the job grants, and deleting one here
  // would silently drop a builder off jobs nobody on this screen can see.
  if (args.isPartner) {
    return {
      error:
        "That's a builder's login, not a crew login. Take it away from the builder's own jobs instead.",
      status: 409,
    };
  }
  // The shared QA login. Either shape ends it for good — the delete removes the
  // account, and the retire hands its address to a tombstone — so the password
  // in ~/.config/infinity-windows/test-installer.env would stop working and
  // every end-to-end check that signs in with it would stay red until somebody
  // re-provisioned it by hand. docs/test-account.md.
  if (args.isTest) {
    return { error: PURGE_TEST_LOGIN_REFUSED, status: 409 };
  }
  if (args.alreadyRetired) {
    return { error: ALREADY_REMOVED, status: 409 };
  }
  if (!args.canRecordRetirement) {
    return { error: PURGE_CANNOT_RECORD, status: 409 };
  }
  return null;
}
