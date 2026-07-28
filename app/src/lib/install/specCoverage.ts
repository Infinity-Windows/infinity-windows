// Coverage gap report for per-mark specs: which marks on this job still have
// nothing a crew can install from.
//
// A specs extraction is never all-or-nothing. On the real Smith / PV Townhomes
// Bldg 14 job the planset is 6 pages covering 24 marks, and one page's vision
// call came back thin: mark 18B got its spec TEXT but no bounding box, so its
// elevation drawing silently never appeared. Nothing in the app said so — the
// review screen looked complete because 24 rows existed.
//
// This module answers the only question that matters at that point: for the
// marks this job actually HAS openings for, which ones are missing a spec, and
// which ones are missing their drawing? It is PURE — no DB, no network — so the
// report is unit-tested against that real 24-mark set rather than eyeballed.
//
// Marks are compared through `markBase`, which strips the INSTANCE suffix (so
// opening "14-18" is the 18th instance of mark "14", and "18B-3" is mark
// "18B") and case-insensitively ("13a" === "13A"), because the mark
// text comes from three different places: the schedule table, the plan
// callouts, and a vision transcription.

import { markBase } from "./extract";

/** The little a coverage check needs to know about a spec row. */
export interface CoverageSpec {
  mark_code: string;
  style?: string | null;
  glass?: string | null;
  color?: string | null;
  size_code?: string | null;
  width_in?: number | null;
  height_in?: number | null;
  operation?: string | null;
  /** Normalized box locating the mark's elevation drawing, when we have one. */
  image_bbox?: unknown;
}

export interface SpecCoverage {
  /** How many distinct marks this job expects specs for. */
  total: number;
  /** Marks with a meaningful spec AND a drawing box — nothing to chase. */
  ok: string[];
  /** Expected marks with no spec row at all, or a row with no real content. */
  missingSpec: string[];
  /** Marks whose spec text is fine but whose elevation drawing is missing. */
  missingDrawing: string[];
  /** Extracted marks that no opening on this job asks for. */
  unexpected: string[];
}

/** Canonical comparison key for a mark or opening code. */
function key(code: string | null | undefined): string | null {
  if (code == null) return null;
  const base = markBase(String(code));
  const trimmed = base.trim().toUpperCase();
  return trimmed ? trimmed : null;
}

/**
 * Unique base marks a project expects specs for, derived from its opening codes
 * ("14-18" → "18", "13A-1" → "13A"). Sorted the way a human reads a mark list
 * (1, 2, 3, 4A, 4B, 10, 13A …) rather than lexically. PURE.
 */
export function expectedMarksFromOpeningCodes(
  openingCodes: (string | null | undefined)[],
): string[] {
  const seen = new Set<string>();
  for (const code of openingCodes) {
    const k = key(code);
    if (k) seen.add(k);
  }
  return [...seen].sort(compareMarks);
}

/** Numeric-aware mark ordering: 2 before 10, 13A before 13B. */
export function compareMarks(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
}

/**
 * True when a spec row carries at least one field a crew could act on. A row
 * that exists but holds only nulls (an extraction that recognised the mark and
 * nothing else) is a GAP, not coverage — that distinction is the reason this
 * isn't just a row-count check.
 */
export function hasMeaningfulSpec(spec: CoverageSpec): boolean {
  const text = (v: unknown) => typeof v === "string" && v.trim().length > 0;
  return Boolean(
    text(spec.style) ||
      text(spec.glass) ||
      text(spec.color) ||
      text(spec.size_code) ||
      text(spec.operation) ||
      spec.width_in != null ||
      spec.height_in != null,
  );
}

/** True when the row locates its elevation drawing (a 4-number box). */
export function hasDrawing(spec: CoverageSpec): boolean {
  const b = spec.image_bbox;
  return Array.isArray(b) && b.length === 4;
}

/**
 * Compare the marks this job has openings for against the specs that were
 * actually extracted, and bucket every mark.
 *
 * Rules, in the order they're applied per expected mark:
 *   1. no row, or a row with no meaningful field  → `missingSpec`
 *   2. spec text but no drawing box               → `missingDrawing`
 *   3. otherwise                                  → `ok`
 * A mark can only land in ONE bucket, so `ok + missingSpec + missingDrawing`
 * always equals `total` and the summary can be trusted arithmetically. Specs
 * for marks nobody asked for are reported separately as `unexpected` — they're
 * usually a mis-read label, and they don't count against coverage.
 *
 * Duplicate expected marks and duplicate spec rows for the same mark collapse;
 * when two rows share a mark, the more complete one wins so a thin duplicate
 * can't mask a good spec. PURE.
 */
export function computeSpecCoverage(
  expectedMarks: (string | null | undefined)[],
  specs: CoverageSpec[],
): SpecCoverage {
  const expected = expectedMarksFromOpeningCodes(expectedMarks);
  const expectedSet = new Set(expected);

  const byMark = new Map<string, { spec: boolean; drawing: boolean }>();
  for (const spec of specs ?? []) {
    const k = key(spec?.mark_code);
    if (!k) continue;
    const found = { spec: hasMeaningfulSpec(spec), drawing: hasDrawing(spec) };
    const prev = byMark.get(k);
    byMark.set(
      k,
      prev
        ? { spec: prev.spec || found.spec, drawing: prev.drawing || found.drawing }
        : found,
    );
  }

  const ok: string[] = [];
  const missingSpec: string[] = [];
  const missingDrawing: string[] = [];
  for (const mark of expected) {
    const found = byMark.get(mark);
    if (!found || !found.spec) missingSpec.push(mark);
    else if (!found.drawing) missingDrawing.push(mark);
    else ok.push(mark);
  }

  const unexpected = [...byMark.keys()]
    .filter((m) => !expectedSet.has(m))
    .sort(compareMarks);

  return { total: expected.length, ok, missingSpec, missingDrawing, unexpected };
}

/**
 * One compact line for the review screen, e.g.
 *   "22 of 24 marks complete · 1 missing drawing (18B) · 1 missing spec (7)"
 * Returns null when there is nothing to report (no openings yet), and a plain
 * all-clear when coverage is complete — the summary must stay unobtrusive when
 * the job is fine. PURE.
 */
export function describeSpecCoverage(coverage: SpecCoverage): string | null {
  const { total, ok, missingSpec, missingDrawing, unexpected } = coverage;
  if (total === 0) return null;

  const head = `${ok.length} of ${total} marks complete`;
  if (missingSpec.length === 0 && missingDrawing.length === 0 && unexpected.length === 0) {
    return head;
  }

  const parts = [head];
  if (missingDrawing.length > 0) {
    parts.push(
      `${missingDrawing.length} missing drawing (${missingDrawing.join(", ")})`,
    );
  }
  if (missingSpec.length > 0) {
    parts.push(`${missingSpec.length} missing spec (${missingSpec.join(", ")})`);
  }
  if (unexpected.length > 0) {
    parts.push(`${unexpected.length} unexpected (${unexpected.join(", ")})`);
  }
  return parts.join(" · ");
}

/** True when the job has openings and every one of their marks is covered. */
export function isSpecCoverageComplete(coverage: SpecCoverage): boolean {
  return (
    coverage.total > 0 &&
    coverage.missingSpec.length === 0 &&
    coverage.missingDrawing.length === 0
  );
}
