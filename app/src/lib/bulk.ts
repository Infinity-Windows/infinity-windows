// Pure helpers shared by the multi-select bulk-action UIs (the Receive
// "this session" list and the Slot-labels list). Kept framework- and DB-free
// so the selection math and bulk-receive sequencing stay unit-testable without
// React or Supabase, mirroring the load-out selection helpers in `loadout.ts`.

/**
 * Toggle an id in a selection set, returning a NEW set (so React state updates
 * stay immutable). Adding an id selects it; toggling again deselects.
 */
export function toggleId(selected: Set<string>, id: string): Set<string> {
  const next = new Set(selected);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

/** True when there is at least one id and every id is currently selected. */
export function allIdsSelected(ids: string[], selected: Set<string>): boolean {
  return ids.length > 0 && ids.every((id) => selected.has(id));
}

/**
 * "Select all" toggle: clear the selection when everything is already selected,
 * otherwise select every id. Returns a NEW set.
 */
export function toggleAllIds(ids: string[], selected: Set<string>): Set<string> {
  return allIdsSelected(ids, selected) ? new Set<string>() : new Set(ids);
}

/**
 * Drop any selected ids that are no longer present in `ids` (e.g. a filter
 * changed or rows were removed), preserving the rest. Returns a NEW set.
 */
export function pruneSelection(
  ids: string[],
  selected: Set<string>,
): Set<string> {
  const present = new Set(ids);
  const next = new Set<string>();
  for (const id of selected) if (present.has(id)) next.add(id);
  return next;
}

/** Clamp a requested bulk-receive quantity to a sane integer in [1, max]. */
export function clampReceiveCount(value: number, max = 50): number {
  if (!Number.isFinite(value)) return 1;
  const n = Math.floor(value);
  if (n < 1) return 1;
  if (n > max) return max;
  return n;
}

export interface BulkRunResult<T> {
  successes: T[];
  failures: { index: number; error: unknown }[];
}

/**
 * Run an async unit-action `count` times, sequentially, collecting successes
 * and per-index failures instead of aborting on the first error. This lets the
 * bulk-receive UI mint as many units as it can and then report partial
 * failures gracefully rather than losing the ones that succeeded.
 */
export async function runBulkSequential<T>(
  count: number,
  fn: (index: number) => Promise<T>,
): Promise<BulkRunResult<T>> {
  const successes: T[] = [];
  const failures: { index: number; error: unknown }[] = [];
  for (let i = 0; i < count; i++) {
    try {
      successes.push(await fn(i));
    } catch (error) {
      failures.push({ index: i, error });
    }
  }
  return { successes, failures };
}
