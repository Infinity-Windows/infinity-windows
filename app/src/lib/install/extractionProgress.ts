// Pure helpers for the specs-extraction progress bar and resume.
//
// Spec extraction runs page by page in the browser, so leaving the screen kills
// it. Progress is therefore persisted per page (`project_planset_pages`) rather
// than kept in component state: the bar can then show real stored progress, it
// survives a refresh, and an interrupted run picks up at the first page that
// never completed instead of redoing the whole sheet.
//
// Everything here is PURE so the arithmetic behind "Page 7 of 14 · 23 marks
// found" and "which pages still need doing" is testable without a browser.

import type { SpecPageStatus } from "./specPageStatus";

/** A page outcome as stored, i.e. `SpecPageStatus` plus when it was written. */
export interface StoredPageProgress extends SpecPageStatus {
  updatedAt: string | null;
}

/** What the progress bar renders. */
export interface ExtractionProgress {
  /** Pages of the planset in total (0 when unknown). */
  total: number;
  /** Pages that completed, successfully or not. */
  attempted: number;
  /** Pages that completed cleanly. */
  done: number;
  /** Pages that completed but failed to read. */
  failed: number[];
  /** Marks transcribed so far across all completed pages. */
  marks: number;
  /** 0–100, clamped. 0 when `total` is unknown. */
  percent: number;
  /** True once every page has been attempted. */
  complete: boolean;
}

function byPage(pages: StoredPageProgress[]): Map<number, StoredPageProgress> {
  const map = new Map<number, StoredPageProgress>();
  for (const page of pages) {
    if (!Number.isInteger(page.pageNumber) || page.pageNumber < 1) continue;
    map.set(page.pageNumber, page);
  }
  return map;
}

/**
 * Fold stored page rows into the numbers the bar shows.
 *
 * Pages beyond `total` are ignored rather than pushing the bar past 100%: a
 * planset's `page_count` can be re-written by a later upload, and a stale row
 * must not make a finished run look impossible.
 */
export function summarizeProgress(
  total: number,
  pages: StoredPageProgress[],
): ExtractionProgress {
  const safeTotal = Number.isFinite(total) && total > 0 ? Math.floor(total) : 0;
  const map = byPage(pages);

  let attempted = 0;
  let done = 0;
  let marks = 0;
  const failed: number[] = [];

  for (const [pageNumber, page] of map) {
    if (safeTotal > 0 && pageNumber > safeTotal) continue;
    attempted += 1;
    marks += Math.max(0, page.markCount);
    if (page.ok) done += 1;
    else failed.push(pageNumber);
  }

  failed.sort((a, b) => a - b);
  const percent =
    safeTotal > 0 ? Math.min(100, Math.round((attempted / safeTotal) * 100)) : 0;

  return {
    total: safeTotal,
    attempted,
    done,
    failed,
    marks,
    percent,
    complete: safeTotal > 0 && attempted >= safeTotal,
  };
}

/**
 * Pages that still need a vision call, in order.
 *
 * A page counts as done only when it completed cleanly (`ok`). A page that
 * completed with zero marks IS done — that's a genuinely empty sheet, and
 * re-reading it forever would be the silence bug in reverse. Failed pages come
 * back into the queue so a resume retries them.
 */
export function pendingPages(
  total: number,
  pages: StoredPageProgress[],
  /** Optional explicit subset (a targeted retry); still filtered to real pages. */
  only?: number[],
): number[] {
  const safeTotal = Number.isFinite(total) && total > 0 ? Math.floor(total) : 0;
  if (safeTotal === 0) return [];
  const map = byPage(pages);

  const candidates =
    only && only.length > 0
      ? [...new Set(only)].filter((p) => Number.isInteger(p) && p >= 1 && p <= safeTotal).sort((a, b) => a - b)
      : Array.from({ length: safeTotal }, (_, i) => i + 1);

  if (only && only.length > 0) return candidates;
  return candidates.filter((page) => !map.get(page)?.ok);
}

/**
 * Should the UI offer "Resume extraction" for this planset?
 *
 * True whenever a specs planset is parked in `extracting` and nothing is
 * driving it in this tab. Because the run only ever lives in a browser tab,
 * a stored `extracting` we aren't currently running is by definition abandoned
 * — that is exactly the wedged state this feature exists to unstick, and it's
 * how Black Desert's interrupted planset becomes recoverable without touching
 * the database by hand.
 */
export function canResumeExtraction(
  planset: { kind?: string | null; status?: string | null } | null | undefined,
  runningPlansetId: string | null,
  plansetId: string,
): boolean {
  if (!planset) return false;
  if (planset.kind !== "specs") return false;
  if (planset.status !== "extracting") return false;
  return runningPlansetId !== plansetId;
}

/** "Page 7 of 14 · 23 marks so far" — the line under the bar. */
export function describeProgress(
  progress: ExtractionProgress,
  /** The page currently being read, when a run is live in this tab. */
  activePage: number | null,
): string {
  if (progress.total === 0) return "Preparing…";

  const marks =
    progress.marks > 0
      ? ` · ${progress.marks} mark${progress.marks === 1 ? "" : "s"} so far`
      : "";

  if (activePage != null) {
    return `Reading page ${activePage} of ${progress.total}${marks}`;
  }
  if (progress.complete) {
    const failed = progress.failed.length;
    return failed > 0
      ? `Finished ${progress.total} pages · ${failed} still need re-reading${marks}`
      : `Finished all ${progress.total} pages${marks}`;
  }
  const remaining = progress.total - progress.attempted;
  return `Stopped after ${progress.attempted} of ${progress.total} pages · ${remaining} left${marks}`;
}
