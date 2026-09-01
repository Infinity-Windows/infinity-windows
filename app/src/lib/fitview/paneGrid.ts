// Wave G (2026-09-01): a mark's real CAD cell, captured as mullion columns
// of top-to-bottom segments — "the pane grid" (g-pane-grid-spec.md). Today's
// extraction only ever stores extra.panels, a flat ONE-ROW strip (the
// schema itself can't say "stacked"), so a storefront like Mad Moose mark 7
// — three stacked fixed lites beside a transom-over-door column — rendered
// as four equal-width panels everywhere. `pane_grid` on a mark's
// `project_mark_specs.extra` (jsonb, no migration) is the additional,
// column-major description that lets both renderers (fitviewRenderer.ts's
// elevations, the Studio unit face) draw the real thing.
//
// This module is the ONLY place either renderer reads pane_grid's raw
// shape. Both call `normalizePaneGrid` and draw from its cell list; neither
// reaches into spec.extra.pane_grid directly.
//
// THE GRID CONTRACT itself — PaneGrid/PaneGridColumn/PaneGridSegment and
// the canonical madMooseMark7Grid fixture — lives in ../install/specs.ts,
// the write-time half that validates what extraction stores. The two wave-G
// halves landed independently (#469/#472) with byte-identical copies; this
// module now imports the install half's and only DERIVES from them, so the
// contract can't drift between writer and renderers. Everything below is
// the render-time job the write side doesn't do: resolve omitted
// width_in/height_in into concrete cell positions.

import {
  madMooseMark7Grid,
  type PaneGrid,
  type PaneGridColumn,
  type PaneGridSegment,
} from "../install/specs";

export { madMooseMark7Grid };
export type { PaneGrid, PaneGridColumn, PaneGridSegment };

/** Hinge/meet side of a door leaf — the contract's own "L" | "R". */
export type PaneLeaf = NonNullable<PaneGridSegment["leaf"]>;

/**
 * What {@link parsePaneGrid} hands back: the contract shape with `op`
 * widened to plain string. The write side (`cleanPaneGrid`) gates storage
 * to the strict PaneGridOp vocabulary, but this reader passes anything else
 * through uppercased rather than rejecting the whole grid — a busy CAD
 * sheet's op vocabulary is Ben's to extend, not this parser's to gatekeep,
 * and a grid stored by a newer extractor must still draw on an older
 * client. Derived from the contract types, never redeclared, so a new
 * contract field flows through here automatically.
 */
export interface ParsedPaneGridSegment extends Omit<PaneGridSegment, "op"> {
  op: string;
}

export interface ParsedPaneGridColumn extends Omit<PaneGridColumn, "segments"> {
  segments: ParsedPaneGridSegment[];
}

export interface ParsedPaneGrid {
  columns: ParsedPaneGridColumn[];
}

/** One resolved cell, unit-local inches, top-left origin, column-major
 * reading order (col/row index the source column/segment). */
export interface PaneCell {
  col: number;
  row: number;
  x: number;
  y: number;
  w: number;
  h: number;
  op: string;
  leaf?: PaneLeaf;
}

export interface ResolvedPaneGrid {
  cells: PaneCell[];
  /** Resolved column left-edge + width, left to right — same x/w the cells
   * in that column share, handed over once so a renderer's vertical
   * mullions don't have to re-derive them from the flat cell list. */
  columns: { x: number; w: number }[];
  widthIn: number;
  heightIn: number;
}

function normalizeOp(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const t = raw.trim();
  if (!t) return null;
  return t.toLowerCase() === "door" ? "door" : t.toUpperCase();
}

function normalizeLeaf(raw: unknown): PaneLeaf | undefined {
  if (typeof raw !== "string") return undefined;
  const t = raw.trim().toUpperCase();
  return t === "L" || t === "R" ? (t as PaneLeaf) : undefined;
}

function positiveNumber(raw: unknown): number | undefined {
  return typeof raw === "number" && Number.isFinite(raw) && raw > 0 ? raw : undefined;
}

/**
 * Validate an unknown value into the pane_grid shape — no dimension
 * solving, just "is this a grid at all." Never throws: anything malformed
 * (missing columns, an empty segments list, a segment with no op) comes
 * back null, the same signal an absent pane_grid gives — both are the
 * fallback trigger, not an error to surface mid-render.
 */
export function parsePaneGrid(raw: unknown): ParsedPaneGrid | null {
  if (!raw || typeof raw !== "object") return null;
  const columnsRaw = (raw as { columns?: unknown }).columns;
  if (!Array.isArray(columnsRaw) || columnsRaw.length === 0) return null;
  const columns: ParsedPaneGridColumn[] = [];
  for (const c of columnsRaw) {
    if (!c || typeof c !== "object") return null;
    const segmentsRaw = (c as { segments?: unknown }).segments;
    if (!Array.isArray(segmentsRaw) || segmentsRaw.length === 0) return null;
    const segments: ParsedPaneGridSegment[] = [];
    for (const s of segmentsRaw) {
      if (!s || typeof s !== "object") return null;
      const op = normalizeOp((s as { op?: unknown }).op);
      if (!op) return null;
      const height_in = positiveNumber((s as { height_in?: unknown }).height_in);
      const leaf = normalizeLeaf((s as { leaf?: unknown }).leaf);
      segments.push(
        height_in != null
          ? leaf
            ? { op, height_in, leaf }
            : { op, height_in }
          : leaf
            ? { op, leaf }
            : { op },
      );
    }
    const width_in = positiveNumber((c as { width_in?: unknown }).width_in);
    columns.push(width_in != null ? { width_in, segments } : { segments });
  }
  return { columns };
}

/**
 * Divide `total`-minus-known equally among however many siblings omitted a
 * dimension. Without a total to check against (no hint given), fall back to
 * the average of the siblings that DID specify one — "equally" beats
 * "zero" for a guess with nothing else to go on; a grid with nothing known
 * at all defaults every column/segment to 1in rather than collapsing to
 * zero-size cells that would divide-by-zero downstream.
 */
function fillOmitted(known: number[], omittedCount: number, total: number | undefined): number {
  if (omittedCount === 0) return 0;
  const sumKnown = known.reduce((t, v) => t + v, 0);
  if (total != null) return Math.max(0, total - sumKnown) / omittedCount;
  return known.length ? sumKnown / known.length : 1;
}

/**
 * Resolve omitted width_in/height_in and produce the normalized cell list —
 * unit-local inches, top-left origin. Takes the widened parse shape; a
 * strictly-typed contract {@link PaneGrid} (the fixture, a test literal) is
 * structurally assignable and passes straight in. `hint` (typically the
 * mark's own spec.width_in/height_in — CONTEXT.md's "survey-measured sizes
 * GOVERN THE ORDER") only matters when the grid itself left a dimension
 * out; every real fixture read off the Mad Moose CADs so far is fully
 * dimensioned and ignores it entirely.
 */
export function resolvePaneGrid(
  grid: ParsedPaneGrid,
  hint?: { widthIn?: number; heightIn?: number },
): ResolvedPaneGrid {
  const knownW = grid.columns.filter((c) => c.width_in != null).map((c) => c.width_in as number);
  const eachW = fillOmitted(knownW, grid.columns.length - knownW.length, hint?.widthIn);

  const columns: { x: number; w: number }[] = [];
  const cells: PaneCell[] = [];
  let x = 0;
  let maxHeight = 0;
  grid.columns.forEach((col, ci) => {
    const w = col.width_in ?? eachW;
    columns.push({ x, w });

    const knownH = col.segments
      .filter((s) => s.height_in != null)
      .map((s) => s.height_in as number);
    const eachH = fillOmitted(knownH, col.segments.length - knownH.length, hint?.heightIn);

    let y = 0;
    col.segments.forEach((seg, ri) => {
      const h = seg.height_in ?? eachH;
      cells.push({ col: ci, row: ri, x, y, w, h, op: seg.op, leaf: seg.leaf });
      y += h;
    });
    maxHeight = Math.max(maxHeight, y);
    x += w;
  });

  return { cells, columns, widthIn: x, heightIn: maxHeight };
}

/**
 * The one entry point either renderer actually calls: parse + resolve in a
 * single step, null on anything malformed or absent — the fallback trigger
 * both halves gate on ("no pane_grid -> today's flat drawing, unchanged").
 */
export function normalizePaneGrid(
  raw: unknown,
  hint?: { widthIn?: number; heightIn?: number },
): ResolvedPaneGrid | null {
  const grid = parsePaneGrid(raw);
  return grid ? resolvePaneGrid(grid, hint) : null;
}
