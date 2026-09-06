// Reading learning time back: the two RPCs behind the owner's table, and the
// shaping the table needs.
//
// The adding up happens in SQL (learning_time_report / learning_video_report in
// 20260993000000) so the totals are the same numbers whoever asks. What is here
// is the trip, the date windows, and the fold from "rows per item" into "one
// person per line" — which is a rendering decision, not an arithmetic one.
//
// Both reads degrade to an empty list against a database that has not had the
// migration yet, so the page opens and says "nothing recorded yet" instead of
// showing an installer-facing error about a table.

import { supabase } from "./supabase";
import { isMissingFunction, isMissingTable } from "./schemaErrors";
import { startOfWeek, type LearningItemKind } from "./learningTime";

export interface LearningTimeRow {
  profileId: string;
  displayName: string;
  itemKind: LearningItemKind | string;
  itemKey: string;
  activeSeconds: number;
  /** How many separate visits this item was opened in. */
  visits: number;
  lastSeenAt: string;
}

export interface LearningVideoRow {
  profileId: string;
  displayName: string;
  videoId: string;
  videoTitle: string;
  timesWatched: number;
  /** The best single visit, in covered seconds. */
  bestSeconds: number;
  /** Every visit's covered seconds, merged — the person's whole coverage. */
  unionSeconds: number;
  /** How long the lesson runs, or null when no player ever reported it. */
  durationSeconds: number | null;
  completed: boolean;
  lastWatchedAt: string;
}

/** The windows the page offers. `null` from means "everything on file". */
export type LearningRange = "week" | "four-weeks" | "all";

/** The `from` timestamp for a window, local, or null for all time. */
export function rangeStart(range: LearningRange, now: Date = new Date()): Date | null {
  if (range === "all") return null;
  const monday = startOfWeek(now);
  if (range === "week") return monday;
  // Four weeks means this week and the three before it, so a Monday morning
  // does not show an almost-empty page.
  const back = new Date(monday);
  back.setDate(back.getDate() - 21);
  return back;
}

export async function listLearningTime(
  range: LearningRange,
  now: Date = new Date(),
): Promise<LearningTimeRow[]> {
  const from = rangeStart(range, now);
  const { data, error } = await supabase.rpc("learning_time_report", {
    p_from: from ? from.toISOString() : null,
    p_to: null,
  });
  if (error) {
    if (isMissingFunction(error) || isMissingTable(error, "learning_time")) return [];
    throw error;
  }
  return (data ?? []).map((r: Record<string, unknown>) => ({
    profileId: String(r.profile_id),
    displayName: String(r.display_name ?? "Someone"),
    itemKind: String(r.item_kind),
    itemKey: String(r.item_key),
    activeSeconds: Number(r.active_seconds ?? 0),
    visits: Number(r.visits ?? 0),
    lastSeenAt: String(r.last_seen_at ?? ""),
  }));
}

export async function listLearningVideoWatches(
  range: LearningRange,
  now: Date = new Date(),
): Promise<LearningVideoRow[]> {
  const from = rangeStart(range, now);
  const { data, error } = await supabase.rpc("learning_video_report", {
    p_from: from ? from.toISOString() : null,
    p_to: null,
  });
  if (error) {
    if (isMissingFunction(error) || isMissingTable(error, "learning_video_watches")) {
      return [];
    }
    throw error;
  }
  return (data ?? []).map((r: Record<string, unknown>) => ({
    profileId: String(r.profile_id),
    displayName: String(r.display_name ?? "Someone"),
    videoId: String(r.video_id),
    videoTitle: String(r.video_title ?? "Lesson"),
    timesWatched: Number(r.times_watched ?? 0),
    bestSeconds: Number(r.best_seconds ?? 0),
    unionSeconds: Number(r.union_seconds ?? 0),
    durationSeconds:
      r.duration_seconds === null || r.duration_seconds === undefined
        ? null
        : Number(r.duration_seconds),
    completed: Boolean(r.completed),
    lastWatchedAt: String(r.last_watched_at ?? ""),
  }));
}

export interface PersonLearning {
  profileId: string;
  displayName: string;
  /**
   * The person's total. It is the sum of the 'tab' rows ONLY, and that is not
   * an oversight: every minute in Learn lands on a tab row, and the term, quiz,
   * sequence and video rows are the SAME minutes named more precisely. Adding
   * the kinds together would count the good ones twice.
   */
  totalSeconds: number;
  /** Seconds by kind, for the breakdown line. See the note above. */
  byKind: Record<string, number>;
  /** The busiest items, most time first. */
  items: LearningTimeRow[];
  videos: LearningVideoRow[];
  lastSeenAt: string;
}

/**
 * How many named items one person's card lists before it stops. PURE data, and
 * a rendering decision: somebody skimming the glossary makes forty term rows,
 * and forty lines under a name is a wall, not an answer. The card says how many
 * more there are rather than pretending there are none.
 */
export const ITEMS_SHOWN = 5;

/**
 * What to call one item row on screen. PURE — unit-tested.
 *
 * The owner's question is "how long, AND ON WHAT ITEM", so these keys have to
 * become names. A term's key is a glossary id and a lesson's is a uuid, and
 * both are looked up in `names` — the map the page builds from the glossary it
 * already ships and the lessons the report already returned. A quiz or sequence
 * key is always 'round', which is not a name anybody wants to read, so those
 * are called after their kind.
 *
 * Anything that cannot be found reads as its raw key rather than as nothing: an
 * owner shown an id the app no longer recognises is being told the truth, and
 * a blank line would be a lie about a row that exists.
 */
export function itemLabel(
  row: LearningTimeRow,
  names: ReadonlyMap<string, string>,
  kindLabels: Readonly<Record<string, string>>,
): string {
  if (row.itemKind === "quiz" || row.itemKind === "sequence") {
    return kindLabels[row.itemKind] ?? row.itemKind;
  }
  return names.get(row.itemKey) ?? row.itemKey;
}

/**
 * Rows per item → one line per person, sorted by time. PURE — unit-tested.
 *
 * Everybody who appears in EITHER read gets a line, so somebody who has only
 * ever watched a lesson is not missing from a page about learning.
 */
export function foldByPerson(
  time: readonly LearningTimeRow[],
  videos: readonly LearningVideoRow[],
): PersonLearning[] {
  const byId = new Map<string, PersonLearning>();
  const get = (profileId: string, displayName: string): PersonLearning => {
    let row = byId.get(profileId);
    if (!row) {
      row = {
        profileId,
        displayName,
        totalSeconds: 0,
        byKind: {},
        items: [],
        videos: [],
        lastSeenAt: "",
      };
      byId.set(profileId, row);
    }
    return row;
  };

  for (const r of time) {
    const person = get(r.profileId, r.displayName);
    person.byKind[r.itemKind] = (person.byKind[r.itemKind] ?? 0) + r.activeSeconds;
    if (r.itemKind === "tab") person.totalSeconds += r.activeSeconds;
    person.items.push(r);
    if (r.lastSeenAt > person.lastSeenAt) person.lastSeenAt = r.lastSeenAt;
  }
  for (const v of videos) {
    const person = get(v.profileId, v.displayName);
    person.videos.push(v);
    if (v.lastWatchedAt > person.lastSeenAt) person.lastSeenAt = v.lastWatchedAt;
  }

  for (const person of byId.values()) {
    // The tab rows are the total, so the breakdown lists the named items under
    // it — showing "tab: 2h" beside "glossary: 2h" would read as four hours.
    person.items = person.items
      .filter((i) => i.itemKind !== "tab")
      .sort((a, b) => b.activeSeconds - a.activeSeconds);
    person.videos.sort((a, b) => b.unionSeconds - a.unionSeconds);
  }

  return [...byId.values()].sort(
    (a, b) =>
      b.totalSeconds - a.totalSeconds ||
      a.displayName.localeCompare(b.displayName),
  );
}
