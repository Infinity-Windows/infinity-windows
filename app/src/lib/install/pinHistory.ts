// Pure logic behind "undo the mark I just moved" on the project map.
//
// The map's numbered circles are draggable, and until now a drag overwrote the
// position the planset extraction had put the mark at, with nothing recorded.
// The database now keeps an origin per mark and one row per move
// (20260730130000_opening_pin_history.sql); everything in this file turns those
// rows into the decisions and the plain English the map needs. No React, no
// Supabase — so the rules can be proven without a browser.

/** One recorded move of one mark, newest-first in the stack. */
export interface PinMove {
  id: string;
  project_id: string;
  opening_id: string;
  moved_by: string | null;
  moved_at: string;
  from_pin_x: number;
  from_pin_y: number;
  from_page_number: number | null;
  to_pin_x: number;
  to_pin_y: number;
  to_page_number: number | null;
  undone_at: string | null;
  undone_by: string | null;
  note: string | null;
}

/** The bit of an opening this module cares about. */
export interface PinnedMark {
  id: string;
  opening_code: string;
  pin_x: number | null;
  pin_y: number | null;
  origin_pin_x?: number | null;
  origin_pin_y?: number | null;
}

/**
 * Is this mark sitting somewhere other than where the extraction put it?
 *
 * A mark with no recorded origin answers false, not "moved". Those are the rows
 * created before this feature existed on a job whose plan was never re-read —
 * we do not know where they started, and claiming otherwise would put a reset
 * button on a dot that has nowhere to go back to.
 */
export function isMarkMoved(mark: PinnedMark): boolean {
  if (mark.pin_x == null || mark.pin_y == null) return false;
  if (mark.origin_pin_x == null || mark.origin_pin_y == null) return false;
  return mark.pin_x !== mark.origin_pin_x || mark.pin_y !== mark.origin_pin_y;
}

/** Ids of every mark that has been dragged off its extracted spot. */
export function movedMarkIds(marks: PinnedMark[]): Set<string> {
  return new Set(marks.filter(isMarkMoved).map((m) => m.id));
}

/**
 * The move an Undo press should walk back: the most recent one nobody has
 * undone yet. Ties on the timestamp fall back to the id so two moves recorded
 * in the same millisecond still have a fixed order.
 */
export function nextUndoableMove(moves: PinMove[]): PinMove | null {
  let best: PinMove | null = null;
  for (const move of moves) {
    if (move.undone_at) continue;
    if (
      !best ||
      move.moved_at > best.moved_at ||
      (move.moved_at === best.moved_at && move.id > best.id)
    ) {
      best = move;
    }
  }
  return best;
}

/** How many presses of Undo are left before the job is back to the extraction. */
export function undoableCount(moves: PinMove[]): number {
  return moves.filter((m) => !m.undone_at).length;
}

/** "Just now", "5 min ago", "2 hr ago", "3 days ago". */
export function movedAgoLabel(movedAt: string, nowMs: number): string {
  const at = Date.parse(movedAt);
  if (Number.isNaN(at)) return "earlier";
  const min = Math.floor(Math.max(0, nowMs - at) / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} hr ago`;
  const days = Math.floor(hr / 24);
  return days === 1 ? "1 day ago" : `${days} days ago`;
}

export interface MoveDescriptionInput {
  move: PinMove;
  /** Mark number as it is printed on the dot, e.g. "37". */
  markLabel: string;
  /** Who moved it, already resolved to a name. */
  movedByName?: string | null;
  /** True when the signed-in person is the one who moved it. */
  byCurrentUser?: boolean;
  nowMs: number;
}

/**
 * The sentence on the Undo button.
 *
 * Attribution is not decoration. A job is shared, so the next thing on the
 * stack may be a correction someone made on purpose out on site, and the owner
 * has to be able to see that BEFORE pressing rather than after. "Undo moving
 * mark 12 (moved by Mike, 2 hr ago)" is a question anyone can answer; "Undo" on
 * its own is not.
 */
export function describePinMove(input: MoveDescriptionInput): string {
  const { move, markLabel, movedByName, byCurrentUser, nowMs } = input;
  const when = movedAgoLabel(move.moved_at, nowMs);
  const who = byCurrentUser
    ? "you"
    : movedByName?.trim()
      ? movedByName.trim()
      : "someone else";
  return `Undo moving mark ${markLabel} — ${who}, ${when}`;
}

/** Plain-English confirmation for the revert-everything button. */
export function describeResetAll(movedCount: number, jobName: string): string {
  if (movedCount === 0) {
    return `Every mark on ${jobName} is already where the plan put it. Nothing to undo.`;
  }
  const marks = movedCount === 1 ? "1 mark" : `${movedCount} marks`;
  return `Put ${marks} on ${jobName} back where the plan put them? This undoes every move anyone has made on this job's marks, including any that were moved on purpose to match the building.`;
}

/** The one-line status above the buttons. */
export function describeMovedSummary(movedCount: number): string {
  if (movedCount === 0) return "Every mark is where the plan put it.";
  if (movedCount === 1) return "1 mark has been moved off the plan.";
  return `${movedCount} marks have been moved off the plan.`;
}
