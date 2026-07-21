// Pure Gantt bar geometry. Each multi-day assignment renders as ONE
// absolutely-positioned bar over a day grid — never N cells — so the timeline
// stays cheap. These helpers turn a date range + a window origin + a column
// width into pixel offset/width, clipping bars that start before or end after
// the visible window.

import { clampISO, daysBetween } from "./dates";

export interface BarGeometry {
  /** Left offset in px from the window origin. */
  left: number;
  /** Bar width in px (≥ colWidth for a single visible day). */
  width: number;
  /** Column index (0-based) of the first visible day of the bar. */
  startCol: number;
  /** Inclusive column index of the last visible day. */
  endCol: number;
  /** True when the bar extends past the window start (draw a left cap). */
  clippedStart: boolean;
  /** True when the bar extends past the window end (draw a right cap). */
  clippedEnd: boolean;
}

/**
 * Geometry for one assignment bar within a window that begins at
 * `windowStartISO` and spans `windowDays` columns of `colWidth` px each.
 * Returns null when the assignment does not intersect the window at all.
 */
export function barGeometry(
  startISO: string,
  endISO: string,
  windowStartISO: string,
  windowDays: number,
  colWidth: number,
): BarGeometry | null {
  if (windowDays <= 0 || colWidth <= 0) return null;

  const rawStart = daysBetween(windowStartISO, startISO);
  const rawEnd = daysBetween(windowStartISO, endISO);
  // No intersection with [0, windowDays-1].
  if (rawEnd < 0 || rawStart > windowDays - 1) return null;

  const startCol = Math.max(0, rawStart);
  const endCol = Math.min(windowDays - 1, rawEnd);
  const spanCols = endCol - startCol + 1;

  return {
    left: startCol * colWidth,
    width: spanCols * colWidth,
    startCol,
    endCol,
    clippedStart: rawStart < 0,
    clippedEnd: rawEnd > windowDays - 1,
  };
}

/** Clamp an assignment's range to the window, returning the visible ISO span. */
export function clampToWindow(
  startISO: string,
  endISO: string,
  windowStartISO: string,
  windowEndISO: string,
): { start: string; end: string } {
  return {
    start: clampISO(startISO, windowStartISO, windowEndISO),
    end: clampISO(endISO, windowStartISO, windowEndISO),
  };
}

export interface LaidOutBar<T> {
  item: T;
  /** Stack lane (0-based) so overlapping bars never cover each other. */
  lane: number;
}

/**
 * Greedy lane packing for one Gantt row: assign each bar the first lane whose
 * last bar ends before this bar starts, so overlapping assignments stack
 * instead of colliding. Input is sorted by start then end for a stable layout.
 */
export function packLanes<T extends { start_date: string; end_date: string }>(
  items: T[],
): LaidOutBar<T>[] {
  const sorted = [...items].sort(
    (a, b) =>
      daysBetween(b.start_date, a.start_date) ||
      daysBetween(b.end_date, a.end_date),
  );
  const laneEnds: string[] = [];
  const out: LaidOutBar<T>[] = [];
  for (const item of sorted) {
    let lane = laneEnds.findIndex(
      (end) => daysBetween(end, item.start_date) > 0,
    );
    if (lane === -1) {
      lane = laneEnds.length;
      laneEnds.push(item.end_date);
    } else {
      laneEnds[lane] = item.end_date;
    }
    out.push({ item, lane });
  }
  return out;
}

/** Highest lane index used (rows needed − 1); −1 for an empty row. */
export function laneCount<T>(bars: LaidOutBar<T>[]): number {
  return bars.reduce((max, b) => Math.max(max, b.lane), -1) + 1;
}
