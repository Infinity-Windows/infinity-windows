// Warm a crew member's spec sheets in the background.
//
// An installer opens My Work on site, taps a window, and waits while the phone
// downloads a 2MB specs planset to show one small picture. Doing that work
// BEFORE they tap — while the list is just sitting there — turns the wait into
// nothing, and because the crops are persisted, it holds across reloads and into
// a dead zone with no signal.
//
// This is a favour, not a feature, so it behaves like one:
//   • it never runs during the first paint (idle callback, or a plain timeout on
//     browsers without one);
//   • it does one crop at a time, yielding to idle between each, so page renders
//     can't jank the list;
//   • it skips entirely on a metered or slow connection — nobody wants their
//     data spent speculatively;
//   • it stops at a small cap, and any failure ends the run quietly. The cards
//     still crop on demand exactly as before.

import { hasCachedCrop, markDrawingDataUrl } from "./drawingCrops";
import { validateBbox } from "./markDrawing";
import type { Planset } from "./types";

/** Most drawings to warm in one pass — a crew member's day, not a whole job. */
const MAX_PREFETCH = 12;

interface PrefetchSpec {
  mark_code: string;
  image_page: number | null;
  image_bbox: unknown;
}

/**
 * True when we should not spend the user's data speculatively: Data Saver is on,
 * or the connection reports itself as 2g/3g-ish. Unknown means fine — most
 * browsers don't implement this, and treating that as "slow" would disable the
 * prefetch everywhere.
 */
export function connectionLooksExpensive(): boolean {
  const nav = navigator as Navigator & {
    connection?: { saveData?: boolean; effectiveType?: string };
  };
  const conn = nav?.connection;
  if (!conn) return false;
  if (conn.saveData) return true;
  const type = conn.effectiveType ?? "";
  return type === "slow-2g" || type === "2g" || type === "3g";
}

/** Run `fn` when the browser is idle (or shortly after, where that's all we have). */
function whenIdle(fn: () => void, timeout = 2000): () => void {
  const w = window as Window & {
    requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
    cancelIdleCallback?: (handle: number) => void;
  };
  if (typeof w.requestIdleCallback === "function") {
    const handle = w.requestIdleCallback(fn, { timeout });
    return () => w.cancelIdleCallback?.(handle);
  }
  const handle = window.setTimeout(fn, 600);
  return () => window.clearTimeout(handle);
}

/**
 * Warm the crops for `specs` off `planset`, one at a time, yielding to idle
 * between each. Returns how many were produced. Never throws.
 */
export async function prefetchMarkDrawings(
  planset: Planset,
  specs: PrefetchSpec[],
  shouldStop: () => boolean = () => false,
): Promise<number> {
  if (connectionLooksExpensive()) return 0;

  const wanted = specs
    .map((s) => ({
      markCode: s.mark_code,
      pageNumber: s.image_page,
      bbox: validateBbox(s.image_bbox),
    }))
    .filter(
      (s): s is { markCode: string; pageNumber: number; bbox: [number, number, number, number] } =>
        s.bbox != null && s.pageNumber != null && Boolean(s.markCode),
    )
    .slice(0, MAX_PREFETCH);

  let warmed = 0;
  for (const item of wanted) {
    if (shouldStop()) break;
    const req = {
      planset,
      pageNumber: item.pageNumber,
      bbox: item.bbox,
      markCode: item.markCode,
    };
    try {
      if (await hasCachedCrop(req)) continue;
      await new Promise<void>((resolve) => whenIdle(() => resolve()));
      if (shouldStop()) break;
      await markDrawingDataUrl(req);
      warmed += 1;
    } catch {
      // Offline, an unrenderable page, no canvas — stop being clever and let the
      // cards do their normal on-demand crop.
      break;
    }
  }
  return warmed;
}

/**
 * Schedule {@link prefetchMarkDrawings} after the current paint and return a
 * cancel function for the caller's effect cleanup.
 */
export function schedulePrefetchMarkDrawings(
  planset: Planset,
  specs: PrefetchSpec[],
): () => void {
  let cancelled = false;
  const cancelIdle = whenIdle(() => {
    if (cancelled) return;
    void prefetchMarkDrawings(planset, specs, () => cancelled);
  });
  return () => {
    cancelled = true;
    cancelIdle();
  };
}


