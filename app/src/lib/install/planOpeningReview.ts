import { parsePlanMarkAnnotation } from "./planMarks";

type Opening = { mark: string; floor: string | null; sheet: number; x: number; y: number };
export type ExpectedOpening = { mark: string; floor: string; count: number };

export function parsePreviewOpeningMarks(text: string) {
  const parsed = parsePlanMarkAnnotation(text);
  if (parsed) return parsed;
  // Explicit field suffixes on a single numbered mark (Building 3 uses 1-A).
  const mark = text.trim().match(/^#?(\d{1,4}-[A-Z])$/i);
  return mark ? [mark[1].toUpperCase()] : null;
}

export function openingCountKey(mark: string, floor: string | null) {
  const family = mark.trim().toUpperCase().replace(/^#/, "").replace(/^(\d+)-[A-Z]$/, "$1");
  return `${floor ?? ""}|${family}`;
}

export function compareOpeningCounts(rows: readonly Opening[], reference: readonly ExpectedOpening[]) {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const key = openingCountKey(row.mark, row.floor);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return reference.flatMap(item => {
    const found = counts.get(openingCountKey(item.mark, item.floor)) ?? 0;
    return found === item.count ? [] : [{ ...item, found }];
  });
}

/**
 * The count check every job gets: a shop drawing that states a quantity says
 * how many openings on the plan should be matched to it. Returned for every
 * definition with a quantity, so the screen can say how many agree as well as
 * which do not. A definition with no quantity makes no claim and is skipped.
 */
export function compareCadQuantities<T extends { key: string; quantity: number | null }>(
  matched: readonly (string | undefined)[], drafts: readonly T[],
) {
  const counts = new Map<string, number>();
  for (const key of matched) if (key) counts.set(key, (counts.get(key) ?? 0) + 1);
  return drafts.flatMap(draft => draft.quantity && draft.quantity > 0
    ? [{ draft, expected: draft.quantity, found: counts.get(draft.key) ?? 0 }] : []);
}

export function overlappingOpeningIndexes(rows: readonly Opening[]) {
  const flagged = new Set<number>();
  rows.forEach((row, index) => {
    for (let next = index + 1; next < rows.length; next++) {
      const other = rows[next];
      if (row.sheet !== other.sheet || Math.hypot(row.x - other.x, row.y - other.y) > .0025) continue;
      flagged.add(index);
      flagged.add(next);
    }
  });
  return flagged;
}
