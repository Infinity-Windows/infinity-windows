// Wave C's color law for the Scheduling calendar: color names WHICH job,
// shape names WHAT you're looking at. Before this wave, the calendar's
// dots/bars/chips colored by CREW (color.ts's assignmentColorKey — first
// foreman, else first member) because that was the only stable identity
// around; the job code was always sitting right next to the color as text,
// so the two channels disagreed with each other. Horizon's own calendar
// keeps one signal per channel — color is identity, shape is record kind —
// and this wave adopts that split now that job identity is the thing every
// other piece (worked-chips, the day panel, deliveries) needs to key on
// anyway. Shape carries the rest: a solid bar is a planned install span, a
// tinted chip is a day crew actually worked, a ringed chip is a delivery —
// which gets no hue of its own, because a truck can carry many jobs
// (ScheduleAssignment.project_id is null on kind='delivery'; see types.ts).
//
// Same FNV-1a-over-the-id technique lib/storage.ts's containerHue() already
// uses for container badges, just twelve steps instead of six — a real
// job list runs longer than one conex's containers, so the wider spread
// earns its keep. Mints no tokens: like containerHue's --badge-hue, this
// hands components a bare hue NUMBER through a CSS custom property
// (--job-hue); the fixed lightness/chroma that turns it into an actual
// color lives once in index.css, per theme, so the same job reads as the
// same color in both themes and only the theme's L/C moves underneath it.

import type { CSSProperties } from "react";

const JOB_HUE_COUNT = 12;

/**
 * A job's stable color-law hue, derived from its id — never stored,
 * recomputed on the fly every time, so the same job lands on the same one
 * of 12 evenly spaced oklch hues everywhere it's drawn. FNV-1a, 32-bit: a
 * plain, well-distributed hash with no crypto dependency, same family as
 * containerHue's multiply-hash but with a wider mix so ids that only
 * differ in one late character (uuids sharing a prefix, e.g.) still land
 * far apart. `String()` turns a missing/non-string id into "" instead of
 * throwing on `.length`, same guard containerHue carries.
 */
export function jobHue(projectId: string): number {
  const s = String(projectId ?? "");
  let hash = 0x811c9dc5; // FNV offset basis
  for (let i = 0; i < s.length; i++) {
    hash ^= s.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193); // FNV prime
  }
  return (Math.abs(hash) % JOB_HUE_COUNT) * (360 / JOB_HUE_COUNT);
}

/**
 * The color-law hue for one calendar entry, or null when it names no
 * single job — a delivery, whose project_id is always null. Callers render
 * the ringed/neutral delivery shape when this comes back null rather than
 * inventing a job-colored lie for a truck that serves several jobs.
 */
export function assignmentJobHue(a: { project_id: string | null }): number | null {
  return a.project_id ? jobHue(a.project_id) : null;
}

/**
 * The inline style that paints one calendar entry (bar, chip, or dot) under
 * this color law — the one place all four calendar surfaces (MonthView,
 * WeekView, TimelineView, CrewBoard) resolve it, so they can never drift
 * onto four slightly different rules. An explicit per-block override
 * (AssignmentEditor's manual swatch — unchanged by this wave) wins outright
 * by setting --sched-color directly, same custom property every one of
 * those elements already painted itself with. Otherwise only --job-hue is
 * set, and each element's own CSS class turns it into --sched-color
 * (oklch(fixed L, fixed C, var(--job-hue)) — the --badge-hue technique).
 * Neither var is set for a delivery with no override: it has no single job
 * to be honest about, so its CSS class paints the neutral ring instead of
 * a guessed color.
 */
export function calendarColorStyle(a: {
  project_id: string | null;
  color?: string | null;
}): CSSProperties {
  if (a.color) return { "--sched-color": a.color } as CSSProperties;
  const hue = assignmentJobHue(a);
  return (hue != null ? { "--job-hue": hue } : {}) as CSSProperties;
}
