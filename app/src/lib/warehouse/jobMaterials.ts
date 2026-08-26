// Pure grouping logic behind the per-job materials ledger's pool editor
// (ticket 23), split out of the page so it can be unit-tested directly and
// so the page file stays a Fast-Refresh-friendly, component-only export.

import type { StoragePackage } from "../storage";

/** One pool package's own row — kept apart (not just summed) so each can be
 * edited on its own line (ticket 23: there can be more than one truck's
 * worth of pool glass sitting against the same mark). */
export interface PoolRow {
  id: string;
  pieceCount: number;
  boundAt: string | null;
}

export interface MarkRow {
  counts: Record<string, number>;
  poolRows: PoolRow[];
  total: number;
}

/** "from Aug 25 truck" — null when there's nothing to date it by. Only shown
 * when a mark has more than one pool row; one row needs no qualifier. */
export function truckLabel(boundAt: string | null): string | null {
  if (!boundAt) return null;
  const d = new Date(boundAt);
  if (Number.isNaN(d.getTime())) return null;
  return `from ${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })} truck`;
}

function markOf(p: StoragePackage): string {
  return (
    ((p.package_marks ?? [])[0] as { mark_code?: string } | undefined)?.mark_code ??
    p.mfr_mark ??
    "?"
  );
}

/**
 * Boxes (counted by stage) and pool packages (kept as individual, editable
 * rows — ticket 23) grouped by mark code, sorted numerically. "More than one
 * truck's worth of glass on one mark" is exactly the kind of thing worth
 * pinning without a full page render.
 */
export function groupPackagesByMark(
  boxes: StoragePackage[],
  pool: StoragePackage[],
): [string, MarkRow][] {
  const m = new Map<string, MarkRow>();
  for (const p of boxes) {
    const mark = markOf(p);
    const row = m.get(mark) ?? { counts: {}, poolRows: [], total: 0 };
    row.counts[p.status] = (row.counts[p.status] ?? 0) + 1;
    row.total += 1;
    m.set(mark, row);
  }
  for (const p of pool) {
    const mark = markOf(p);
    const row = m.get(mark) ?? { counts: {}, poolRows: [], total: 0 };
    row.poolRows.push({ id: p.id, pieceCount: p.piece_count ?? 0, boundAt: p.bound_at });
    m.set(mark, row);
  }
  return [...m.entries()].sort((a, b) =>
    a[0].localeCompare(b[0], undefined, { numeric: true }),
  );
}
