// Job staging bays: the two shelves (J-<JOBCODE>-A and -B) that keep one job's
// windows together before they go out.
//
// The rule that every job has both is enforced in the database now (see
// supabase/migrations/20260729220000_staging_bays_guaranteed.sql). What lives
// here is the other half of that fix: making sure a foreman is never told to
// put a job's windows somewhere else without being told that is what is
// happening. Before this, suggest_location() quietly answered with a shared
// stock shelf and the screens repeated it as if it were the job's own bay.

import type { Location } from "./types";

/**
 * Marker the database puts in the error `hint` when it refuses to suggest a
 * shelf because the job has no staging bay. Kept in step with
 * `using hint = 'no_staging_bay'` in suggest_location().
 */
export const NO_STAGING_BAY_HINT = "no_staging_bay";

/** The two slot letters every job gets. */
export const STAGING_SLOTS = ["A", "B"] as const;

interface HintedError {
  hint?: unknown;
  details?: unknown;
}

function hinted(err: unknown): HintedError | null {
  return err && typeof err === "object" ? (err as HintedError) : null;
}

/** True when the DB refused to suggest a shelf because the job has no bay. */
export function isMissingStagingBayError(err: unknown): boolean {
  return hinted(err)?.hint === NO_STAGING_BAY_HINT;
}

/** Job code the refusal was about, when the DB supplied one. */
export function missingStagingBayJobCode(err: unknown): string | null {
  const detail = hinted(err)?.details;
  return typeof detail === "string" && detail.trim() ? detail.trim() : null;
}

/** A job's own staging bays, out of a full location list. */
export function stagingBaysFor(
  locations: Location[],
  jobCode: string | null | undefined,
): Location[] {
  if (!jobCode) return [];
  return locations
    .filter((l) => l.zone === "J" && l.rack === jobCode)
    .sort((a, b) => a.slot.localeCompare(b.slot));
}

/**
 * Which of A/B a job is missing. A retired bay counts as missing, because it
 * is gone from every picker and from suggest_location() either way.
 *
 * An unknown job code reports nothing rather than "both missing": until the
 * job has loaded we have no evidence of a gap, and a screen that cries wolf
 * during every page load is a screen people learn to ignore.
 */
export function missingStagingSlots(
  locations: Location[],
  jobCode: string | null | undefined,
): string[] {
  if (!jobCode) return [];
  const present = new Set(
    stagingBaysFor(locations, jobCode)
      .filter((l) => l.active)
      .map((l) => l.slot),
  );
  return STAGING_SLOTS.filter((slot) => !present.has(slot));
}

/**
 * The line shown when the suggested shelf is NOT this job's own bay.
 *
 * This is the case the database still allows: the job's bays exist but are
 * full, so putaway falls back to general stock. That is the right thing to do
 * — the windows have to go somewhere — but it must never happen quietly,
 * because a job's units mixed into shared stock get installed at the wrong
 * address.
 */
export function sharedShelfWarning(
  hasJob: boolean,
  location: Location | null,
): string | null {
  if (!hasJob || !location || location.zone === "J") return null;
  return (
    `${location.address} is a shared stock shelf, not this job's own staging bay. ` +
    `The job's bays are full, so these windows will be sitting with other jobs' material.`
  );
}

/** The line shown when the job has no staging bay at all. */
export function missingBayMessage(jobCode: string | null): string {
  return (
    `${jobCode ? `Job ${jobCode}` : "This job"} has no staging bay, so there is no shelf of its own ` +
    `to put this window on. Create the job's staging bays from the job's Warehouse tab — ` +
    `otherwise this job's windows end up mixed in with everyone else's.`
  );
}

/** What a putaway suggestion actually amounts to, warnings included. */
export interface PutawaySuggestion {
  /** The shelf to use, or null when there isn't a safe answer. */
  location: Location | null;
  /** Plain-English warning the screens must show. Null when all is well. */
  warning: string | null;
  /** True when the job has no staging bay and nothing was suggested. */
  missingBay: boolean;
  /** Job code the missing-bay refusal named, when it named one. */
  jobCode: string | null;
}

/** Nothing to say: an unassigned unit going to stock is normal. */
export function plainSuggestion(location: Location | null): PutawaySuggestion {
  return { location, warning: null, missingBay: false, jobCode: null };
}
