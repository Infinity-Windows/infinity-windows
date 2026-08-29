// Wave D: pure logic for the 30-day trash. Server-time based on purpose —
// clockSkew.ts's own precedent is why: every timestamp this app writes is
// the SERVER's now(), never the device's clock, so "days left" has to be
// computed against the server's now (fetchServerNowMs, wave T's server_now
// RPC) rather than the phone's own Date.now(), which can be minutes or
// hours wrong without the owner ever noticing.

export const TRASH_WINDOW_DAYS = 30;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Whole days elapsed since a job was trashed, floored, never negative. */
export function daysSinceDeleted(deletedAtIso: string, serverNowMs: number): number {
  const deletedAtMs = new Date(deletedAtIso).getTime();
  return Math.max(0, Math.floor((serverNowMs - deletedAtMs) / MS_PER_DAY));
}

/**
 * Days left before the 30-day window closes (0 = the deadline has arrived —
 * "being erased", Undo gone — even if the nightly sweep hasn't run yet).
 * Mirrors restore_project's own `now() >= deleted_at + interval '30 days'`
 * refusal exactly, so the UI's countdown and the server's actual refusal
 * agree at the boundary.
 */
export function daysLeftInTrash(deletedAtIso: string, serverNowMs: number): number {
  return Math.max(0, TRASH_WINDOW_DAYS - daysSinceDeleted(deletedAtIso, serverNowMs));
}

/** "deleted 3 days ago — 27 days left" / "deleted today — 30 days left" / "being erased". */
export function trashStatusLine(deletedAtIso: string, serverNowMs: number): string {
  const elapsed = daysSinceDeleted(deletedAtIso, serverNowMs);
  const left = daysLeftInTrash(deletedAtIso, serverNowMs);
  if (left <= 0) return "being erased";
  const ago = elapsed === 0 ? "deleted today" : `deleted ${elapsed} day${elapsed === 1 ? "" : "s"} ago`;
  return `${ago} — ${left} day${left === 1 ? "" : "s"} left`;
}

export interface ProjectDeleteCounts {
  openings: number;
  packages: number;
  photos: number;
}

/** Plain-count(n) pluralization, shared by the confirm message below. */
function countWord(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/**
 * The confirm dialog's exact text (owner ask: "confirm dialog states the
 * real cost in numbers before the tap"). A pure function of already-fetched
 * counts so it's testable without a network call.
 */
export function buildDeleteConfirmMessage(jobLabel: string, counts: ProjectDeleteCounts): string {
  return (
    `Delete ${jobLabel}? This job has ${countWord(counts.openings, "opening")}, ` +
    `${countWord(counts.packages, "package")}, and ${countWord(counts.photos, "photo")}.\n\n` +
    `It disappears everywhere, and you have 30 days to undo from Job history.`
  );
}
