// Work-screen heads-ups (crew redesign K1.9 / Q25, 2026-09-23): rule-based
// notices, on Work only, never a feed. Each one is a fact the records already
// hold, read off them and shown as one line with a door. Push notifications
// stay reserved for tomorrow's schedule changes and summons — none of these
// ever pushes.
//
// The four rules that exist today (borrowed-equipment overdue joins them in
// Release 5): the toolbox talk not signed while on the clock; a photo that has
// sat unsent for over an hour; an assignment changed since it was published;
// units waiting for QC (foreman+). Ordered by what costs the most if missed.
// At most three show — a fourth line is a list, and a list stops being read.

import type { TKey } from "../i18n/catalog";
import type { TVars } from "../i18n/translate";
import type { ScheduleAssignment } from "../schedule/types";
import { assignmentChanged } from "./today";

export const PHOTO_UNSENT_AFTER_MS = 60 * 60_000;
export const MAX_HEADS_UPS = 3;

export type HeadsUpId = "toolbox-unsigned" | "photo-unsent" | "assignment-changed" | "qc-due";

export interface HeadsUp {
  id: HeadsUpId;
  key: TKey;
  vars?: TVars;
  /** Where the tap goes. */
  to: string;
}

export interface HeadsUpsInput {
  now: number;
  /** Published rows in the schedule window (today + 7). */
  assignments: readonly Pick<ScheduleAssignment, "updated_at" | "published_at" | "status">[];
  /** Photos still queued on this phone, and when the oldest was taken. */
  unsentPhotoCount: number;
  oldestUnsentPhotoAt: number | null;
  onClock: boolean;
  talkExists: boolean | null;
  signedToday: boolean | null;
  /** Units installed and waiting for QC on this person's jobs (foreman+). */
  qcDueCount: number;
}

export function headsUps(i: HeadsUpsInput): HeadsUp[] {
  const out: HeadsUp[] = [];
  if (i.onClock && i.talkExists === true && i.signedToday === false) {
    out.push({ id: "toolbox-unsigned", key: "work.headsUp.toolbox", to: "/safety" });
  }
  if (
    i.unsentPhotoCount > 0 &&
    i.oldestUnsentPhotoAt != null &&
    i.now - i.oldestUnsentPhotoAt >= PHOTO_UNSENT_AFTER_MS
  ) {
    out.push({
      id: "photo-unsent",
      key: i.unsentPhotoCount === 1 ? "work.headsUp.photo.one" : "work.headsUp.photo.many",
      vars: { n: i.unsentPhotoCount },
      to: "/stuck",
    });
  }
  if (i.assignments.some((a) => assignmentChanged(a, i.now))) {
    out.push({ id: "assignment-changed", key: "work.headsUp.assignment", to: "/my-schedule" });
  }
  if (i.qcDueCount > 0) {
    out.push({
      id: "qc-due",
      key: i.qcDueCount === 1 ? "work.headsUp.qc.one" : "work.headsUp.qc.many",
      vars: { n: i.qcDueCount },
      to: "/qc",
    });
  }
  return out.slice(0, MAX_HEADS_UPS);
}
