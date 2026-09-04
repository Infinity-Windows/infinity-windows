// How big is this job, and how much of it is doors? — wave X (X3/X4).
//
// The card and the job header say the same sentence in two lengths, so the
// rules for building it live here once, pure and React-free: which parts appear
// at all, in what order, and which of a plural pair of catalog keys each one
// takes. Tests read this file, not a rendered card.
//
// The NUMBERS come from the database (the project_scope_counts view,
// 20260980000000). The only thing decided here is what to say about them.

import type { TKey } from "./i18n";
import { fitviewModel, preferModelOutline } from "./fitview/adapter";
import { storiesOf } from "./fitview/stories";

/**
 * One job's row of project_scope_counts. `unknown_units` is the honest bucket:
 * marks whose spec text does not say what they are, and every mark written
 * before the backfill ran. openings = windows + doors + unknown, always, which
 * is what stops the parts of the line arguing with each other.
 */
export interface ScopeCounts {
  project_id: string;
  openings: number;
  installed: number;
  windows: number;
  doors: number;
  door_sliders: number;
  door_french: number;
  door_bifold: number;
  door_swing: number;
  door_other: number;
  unknown_units: number;
}

/** One piece of the line: a catalog key plus the number to drop into it. */
export interface ScopePart {
  key: TKey;
  n: number;
}

/**
 * English and Spanish both pluralize these with a plain +s, and the framework
 * interpolates but has no plural rule — so the caller picks the key by count,
 * exactly as the crew flow already does (`mywork.newUnits.one` / `.many`).
 */
function plural(base: string, n: number): TKey {
  return `${base}.${n === 1 ? "one" : "many"}` as TKey;
}

/**
 * The line on a job card: "40 openings · 32 windows · 8 doors · 2 stories".
 *
 * A part it cannot say is left out rather than shown as a zero. A job whose
 * specs nobody has read yet is "40 openings" and nothing else — true, and
 * exactly what the card said before this wave — while "0 doors" would read as
 * a job somebody has checked and found no doors on.
 *
 * A TRACKING-ONLY job with nothing on it is the one case that says words
 * instead of numbers: it has no openings by design (nobody uploads plans for a
 * service call), and "0 openings" on it would look like a job that had gone
 * wrong.
 */
export function scopeLineParts(
  counts: ScopeCounts | null | undefined,
  opts: { stories?: number | null; trackingOnly?: boolean } = {},
): { parts: ScopePart[]; trackingOnly: boolean } {
  const openings = counts?.openings ?? 0;
  if (opts.trackingOnly && openings === 0) return { parts: [], trackingOnly: true };

  const parts: ScopePart[] = [];
  if (openings > 0) parts.push({ key: plural("scope.openings", openings), n: openings });
  if (counts && counts.windows > 0) {
    parts.push({ key: plural("scope.windows", counts.windows), n: counts.windows });
  }
  if (counts && counts.doors > 0) {
    parts.push({ key: plural("scope.doors", counts.doors), n: counts.doors });
  }
  const stories = opts.stories;
  if (stories != null && stories > 0) {
    parts.push({ key: plural("scope.stories", stories), n: stories });
  }
  return { parts, trackingOnly: false };
}

/**
 * Which doors, for the job header: "(5 sliders · 2 French · 1 bifold)".
 *
 * Ordered by the kinds a crew hangs most, not alphabetically, and a kind with
 * none of them is absent. "not stated" is last and is a real answer: those are
 * doors whose paperwork never said which, and a foreman fixing the spec text
 * moves them out of it.
 */
export function doorBreakdownParts(
  counts: ScopeCounts | null | undefined,
): ScopePart[] {
  if (!counts) return [];
  const byKind: [string, number][] = [
    ["scope.door.slider", counts.door_sliders],
    ["scope.door.french", counts.door_french],
    ["scope.door.bifold", counts.door_bifold],
    ["scope.door.swing", counts.door_swing],
    ["scope.door.other", counts.door_other],
  ];
  return byKind
    .filter(([, n]) => n > 0)
    .map(([base, n]) => ({ key: plural(base, n), n }));
}

/**
 * How many storeys to SHOW, from the two things that can know.
 *
 * The traced model wins whenever a job has one: somebody drew that building
 * over its own planset, so it is a survey, while the number on the job form is
 * what a person typed before anyone had been to site. The typed number is the
 * fallback, and "nobody said" is a perfectly good answer — the line simply
 * leaves storeys out.
 *
 * Deliberately ONE-WAY. Nothing here writes the model's count back into
 * `projects.stories`: three writers already share an outline row's `features`,
 * and a fourth writing into a different table on their behalf is how a number
 * nobody can explain gets into a database.
 */
export function storiesToShow(
  outlines: { features: unknown }[] | null | undefined,
  typed: number | null | undefined,
): number | null {
  const row = preferModelOutline(outlines ?? []);
  const model = row ? fitviewModel(row.features) : null;
  if (model) {
    const n = storiesOf(model.building).length;
    if (n > 0) return n;
  }
  return typed != null && typed > 0 ? typed : null;
}
