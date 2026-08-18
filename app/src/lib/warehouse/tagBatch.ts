// The tag screen's worksheet (owner spec, 2026-08-18).
//
// Declare the window once and the screen becomes a little worksheet of its
// parts: one line per piece, everything shared held at the top (job,
// category, the window number), everything per-piece on its line (the
// sticker, the fraction, which piece it is). The foreman matches lines to
// boxes by the fraction — the maker prints "1/3" on the box, the line says
// #16 1/3, the line's sticker goes on that box.
//
// Pure line-model math, so the interaction can be tested without a DOM and
// the screen stays a thin renderer of it.

import type { StoragePackage } from "../storage";
import { unitParts } from "./unitParts";

export interface TagLine {
  /** Stable per-line key for React and for selection. */
  key: string;
  /** The blank sticker this line will bind — auto-assigned, swappable. */
  sticker: StoragePackage | null;
  /** 1-based part number within the window. */
  partIndex: number;
  partType: string | null;
  /** The maker's own mark for this piece, when it differs from ours. */
  mfrMark: string;
}

/**
 * Build N lines, each with a free sticker already attached — nobody picks
 * stickers by hand, the codes are random anyway (owner). Falls back to a
 * sticker-less line when the roll runs dry, which the screen must surface
 * rather than silently binding fewer than asked.
 */
export function buildLines(
  count: number,
  roll: StoragePackage[],
  startIndex = 1,
): TagLine[] {
  return Array.from({ length: count }, (_, i) => ({
    key: `line-${startIndex + i}`,
    sticker: roll[i] ?? null,
    partIndex: startIndex + i,
    partType: null,
    mfrMark: "",
  }));
}

/** "#16 2/3" — what the line shows once the window number is typed. */
export function lineLabel(
  markCode: string,
  partIndex: number,
  partTotal: number,
): string {
  const mark = markCode.trim() ? `#${markCode.trim().toUpperCase()} ` : "";
  return `${mark}${partIndex}/${partTotal}`;
}

/**
 * What typing a window number means for the batch when that window already
 * has packages (the missed fourth box, the add-on ordered later): the new
 * lines CONTINUE the numbering, and every older label's "of N" grows to
 * match. Null when the window is fresh and the batch stands alone.
 */
export interface ExistingParts {
  have: number;
  /** The highest part number already taken; new lines start after it. */
  maxIndex: number;
  oldTotal: number | null;
  /** What "of N" becomes for everyone once these lines are added. */
  newTotal: number;
}

export function existingParts(
  packages: StoragePackage[],
  projectId: string,
  markCode: string,
  adding: number,
): ExistingParts | null {
  if (!markCode.trim() || !projectId) return null;
  const r = unitParts(packages, projectId, markCode);
  if (r.rows.length === 0) return null;
  const maxIndex = r.rows.reduce((m, p) => Math.max(m, p.part_index ?? 0), 0);
  return {
    have: r.rows.length,
    maxIndex,
    oldTotal: r.expectedTotal,
    newTotal: Math.max(maxIndex, r.expectedTotal ?? 0) + adding,
  };
}
