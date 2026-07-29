/**
 * Provisional window types are not catalog products.
 *
 * Spec extraction creates a row per unresolved mark on a planset — "Mark #1",
 * "Mark #2" — and flags it `provisional`. There are dozens of them, roughly a
 * fifth of the table, and they crowd out real products in every list that shows
 * the catalog. They are kept (openings point at them) but never browsed.
 */
export function isProvisional(type: { provisional?: boolean | null }): boolean {
  return type.provisional === true;
}

/**
 * The real catalog: every non-provisional type, plus whichever type is already
 * selected, so an opening that points at an extracted mark still shows what it
 * points at instead of appearing blank.
 */
export function realCatalogTypes<T extends { id: string; provisional?: boolean | null }>(
  types: T[],
  keepId?: string | null,
): T[] {
  return types.filter((t) => !isProvisional(t) || (keepId != null && t.id === keepId));
}
