// Pure visible-window filtering. The Timeline/Gantt must never render (or
// fetch) all 6 months at once — it works on the assignments overlapping the
// currently-visible [from, to] window. These helpers pick that subset and the
// virtualized row/column ranges.

import { daysBetween, rangesOverlap } from "./dates";

export interface WindowAssignment {
  id: string;
  start_date: string;
  end_date: string;
}

/** Assignments overlapping the inclusive [from, to] window, input order kept. */
export function filterVisible<T extends WindowAssignment>(
  assignments: T[],
  fromISO: string,
  toISO: string,
): T[] {
  return assignments.filter((a) =>
    rangesOverlap(a.start_date, a.end_date, fromISO, toISO),
  );
}

export interface ColumnWindow {
  /** First visible column index (inclusive), clamped to [0, totalDays). */
  startIndex: number;
  /** Last visible column index (inclusive), clamped to [0, totalDays). */
  endIndex: number;
}

/**
 * Which day-columns are visible given a horizontal scroll offset — the seam
 * that lets the Gantt only mount the columns on screen (+ an overscan buffer).
 */
export function visibleColumnRange(
  scrollLeft: number,
  viewportWidth: number,
  colWidth: number,
  totalDays: number,
  overscan = 3,
): ColumnWindow {
  if (colWidth <= 0 || totalDays <= 0) return { startIndex: 0, endIndex: 0 };
  const first = Math.floor(scrollLeft / colWidth) - overscan;
  const last = Math.ceil((scrollLeft + viewportWidth) / colWidth) + overscan;
  return {
    startIndex: Math.max(0, first),
    endIndex: Math.min(totalDays - 1, Math.max(0, last)),
  };
}

export interface RowWindow {
  startIndex: number;
  endIndex: number;
}

/** Which stacked rows are visible given a vertical scroll offset. */
export function visibleRowRange(
  scrollTop: number,
  viewportHeight: number,
  rowHeight: number,
  totalRows: number,
  overscan = 4,
): RowWindow {
  if (rowHeight <= 0 || totalRows <= 0) return { startIndex: 0, endIndex: 0 };
  const first = Math.floor(scrollTop / rowHeight) - overscan;
  const last = Math.ceil((scrollTop + viewportHeight) / rowHeight) + overscan;
  return {
    startIndex: Math.max(0, first),
    endIndex: Math.min(totalRows - 1, Math.max(0, last)),
  };
}

/** Total day-columns spanned by a [from, to] window, inclusive (≥ 0). */
export function windowDayCount(fromISO: string, toISO: string): number {
  return Math.max(0, daysBetween(fromISO, toISO) + 1);
}
