import type { QueryClient } from "@tanstack/react-query";

/**
 * Refresh everything that is derived from a job's openings.
 *
 * A re-extract does not edit openings, it REPLACES them: every row is deleted
 * and re-inserted with a new id. Any cached list still holding the old ids
 * hands out links that resolve to nothing, which is how an installer ends up
 * staring at a dead screen. One list of keys, used by the re-extract and by the
 * realtime subscription, so the two cannot drift apart again.
 */
export function invalidateOpeningQueries(
  queryClient: QueryClient,
  projectId: string | undefined,
): void {
  queryClient.invalidateQueries({ queryKey: ["opening"] });
  queryClient.invalidateQueries({ queryKey: ["myOpenings"] });
  queryClient.invalidateQueries({ queryKey: ["openingCounts"] });
  if (!projectId) return;
  queryClient.invalidateQueries({ queryKey: ["openings", projectId] });
  queryClient.invalidateQueries({ queryKey: ["dispatch", projectId] });
  queryClient.invalidateQueries({ queryKey: ["voidedOpenings", projectId] });
}
