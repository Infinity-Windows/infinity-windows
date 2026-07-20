// Pure, testable helpers for map-based ordered dispatch on the project map.
// Kept free of React/Supabase so the tap-order → sequence logic, append-after-
// existing numbering, and installer coloring can be unit-tested directly.

/**
 * Small, legible palette used to color assigned pins by installer. Chosen to
 * stay distinct from the pin fill (window/door kind) and border (status)
 * colors, and to avoid the voided-install red (#ef4444).
 */
export const INSTALLER_PALETTE = [
  "#ff6a1a", // coral (theme accent)
  "#a855f7", // purple
  "#ec4899", // pink
  "#06b6d4", // cyan
  "#8b5cf6", // violet
  "#f97316", // orange
] as const;

/**
 * Assign each installer id a stable color by its index in the given ordered
 * list (e.g. active-crew order), cycling the palette. Deterministic: the same
 * ordered ids always map to the same colors.
 */
export function installerColorMap(
  installerIds: readonly string[],
): Map<string, string> {
  const map = new Map<string, string>();
  let i = 0;
  for (const id of installerIds) {
    if (map.has(id)) continue;
    map.set(id, INSTALLER_PALETTE[i % INSTALLER_PALETTE.length]);
    i += 1;
  }
  return map;
}

/** Short initials for an installer badge: "Ammon" → "A", "John Doe" → "JD". */
export function installerInitials(displayName: string): string {
  const words = displayName.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  if (words.length === 1) return words[0].slice(0, 1).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

/**
 * Toggle an opening id in an ordered selection: append if absent, remove if
 * present. Order of the remaining ids (and thus their tap-order numbering) is
 * preserved, which naturally renumbers when one is removed.
 */
export function toggleSelection(
  current: readonly string[],
  id: string,
): string[] {
  return current.includes(id)
    ? current.filter((x) => x !== id)
    : [...current, id];
}

/**
 * Highest sequence already assigned to an installer, ignoring the openings
 * about to be (re)assigned. Returns 0 when the installer has no sequenced work,
 * so callers can start numbering at `nextStart` = result + 1.
 */
export function maxExistingSequence(
  openings: readonly { id: string; assigned_to: string | null; sequence: number | null }[],
  installerId: string,
  excludeIds: readonly string[] = [],
): number {
  const exclude = new Set(excludeIds);
  let max = 0;
  for (const o of openings) {
    if (o.assigned_to !== installerId) continue;
    if (exclude.has(o.id)) continue;
    if (o.sequence != null && o.sequence > max) max = o.sequence;
  }
  return max;
}

export interface SequenceAssignment {
  openingId: string;
  sequence: number;
}

/**
 * Turn an ordered selection of opening ids into concrete sequence assignments,
 * numbering them 1..N starting after `startAfter` (0 → start at 1). Passing the
 * installer's current max sequence as `startAfter` appends the new work after
 * their existing list instead of clobbering it.
 */
export function buildSequenceAssignments(
  orderedIds: readonly string[],
  startAfter = 0,
): SequenceAssignment[] {
  return orderedIds.map((openingId, i) => ({
    openingId,
    sequence: startAfter + i + 1,
  }));
}

/** Minimal opening shape the ordering helpers need. */
interface SeqOpening {
  id: string;
  assigned_to: string | null;
  sequence: number | null;
}

/**
 * Ids currently assigned to an installer (optionally excluding some), in saved
 * `sequence` order. Openings without a sequence sink to the end; ties (and
 * nulls) keep their incoming order so the result is stable. This is the
 * installer's already-dispatched route as the foreman last saved it.
 */
export function sortedAssignedIds(
  openings: readonly SeqOpening[],
  installerId: string,
  excludeIds: readonly string[] = [],
): string[] {
  const exclude = new Set(excludeIds);
  return openings
    .map((o, i) => ({ o, i }))
    .filter(({ o }) => o.assigned_to === installerId && !exclude.has(o.id))
    .sort((a, b) => {
      const sa = a.o.sequence ?? Number.MAX_SAFE_INTEGER;
      const sb = b.o.sequence ?? Number.MAX_SAFE_INTEGER;
      if (sa !== sb) return sa - sb;
      return a.i - b.i;
    })
    .map(({ o }) => o.id);
}

/** One row of an installer's full ordered worklist (existing + newly tapped). */
export interface WorklistItem {
  id: string;
  /** Continuous 1..N order across the whole list, so the final order is clear. */
  order: number;
  /** True for a pin tapped now but not yet committed to the installer. */
  isNew: boolean;
  /** Saved sequence for an existing assignment; null for a newly-tapped one. */
  sequence: number | null;
}

/**
 * Merge an installer's already-assigned openings (in saved sequence order) with
 * the ids tapped in the current selection, into one continuously-numbered list:
 * existing #1..M first, then the new taps appended #M+1..N — exactly the order
 * the work will end up in once the selection is committed (which appends after
 * the installer's current max sequence). Ids in `selection` are treated as new
 * even if already assigned, matching the append-on-commit behavior.
 */
export function buildInstallerWorklist(
  openings: readonly SeqOpening[],
  installerId: string,
  selection: readonly string[],
): WorklistItem[] {
  const seqById = new Map(openings.map((o) => [o.id, o.sequence]));
  const existing = sortedAssignedIds(openings, installerId, selection);
  const items: WorklistItem[] = [];
  let order = 0;
  for (const id of existing) {
    order += 1;
    items.push({ id, order, isNew: false, sequence: seqById.get(id) ?? null });
  }
  for (const id of selection) {
    order += 1;
    items.push({ id, order, isNew: true, sequence: null });
  }
  return items;
}

/**
 * Move an id one step up (dir -1) or down (dir +1) within an ordered list,
 * returning a new array. Out-of-range moves (already at an edge, or unknown id)
 * return an unchanged copy so callers can call unconditionally.
 */
export function reorderById(
  ids: readonly string[],
  id: string,
  dir: -1 | 1,
): string[] {
  const idx = ids.indexOf(id);
  if (idx < 0) return [...ids];
  const target = idx + dir;
  if (target < 0 || target >= ids.length) return [...ids];
  const next = [...ids];
  [next[idx], next[target]] = [next[target], next[idx]];
  return next;
}

/**
 * Map each id to its 1..N position in an ordered list (first occurrence wins).
 * Used to stamp explicit "do this Nth" order numbers on the installer's screen.
 */
export function orderNumberMap(orderedIds: readonly string[]): Map<string, number> {
  const map = new Map<string, number>();
  orderedIds.forEach((id, i) => {
    if (!map.has(id)) map.set(id, i + 1);
  });
  return map;
}
