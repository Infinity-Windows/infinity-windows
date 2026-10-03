import type { QueryClient } from "@tanstack/react-query";

const PRIVATE_ROOTS = new Set(["valuesMyTasks", "valuesMySummary", "valuesOwnerReport"]);

/** Drop only in-memory values projections at identity/role/preview boundaries.
 * Durable owner-keyed drafts live in IndexedDB and are deliberately separate. */
export function clearPrivateValuesQueries(client: QueryClient): void {
  client.removeQueries({ predicate: (query) => PRIVATE_ROOTS.has(String(query.queryKey[0])) });
}
