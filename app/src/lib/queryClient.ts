import { QueryClient } from "@tanstack/react-query";
import { createSyncStoragePersister } from "@tanstack/query-sync-storage-persister";
import { getProjectUnits, getProjectWindows, listProjects } from "./api";
import { getTypeBrainStats, listOpenings, listPlansets } from "./install/api";

// offlineFirst: when there's no connection, queries resolve from the persisted
// cache instead of hanging — the whole install flow keeps working in dead spots.
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      networkMode: "offlineFirst",
      gcTime: 1000 * 60 * 60 * 24 * 7, // keep a week of job data
      staleTime: 1000 * 30,
      retry: 1,
    },
    mutations: {
      networkMode: "offlineFirst",
    },
  },
});

export const persister =
  typeof window !== "undefined"
    ? createSyncStoragePersister({
        storage: window.localStorage,
        key: "wops-query-cache",
      })
    : undefined;

/** Queries worth keeping offline. Excludes heavy/binary and volatile searches. */
const OFFLINE_KEYS = new Set([
  "projects",
  "openings",
  "openingCounts",
  "projectWindows",
  "projectUnits",
  "windowTypes",
  "typeBrain",
  "plansets",
  "opening",
  "myOpenings",
  "myProfile",
  // New modules — keep the installer's day usable in dead spots.
  "openShift",
  "myShifts",
  "costCodes",
  "learnProgress",
  "priorityTerms",
  "ledger",
  "pointsLeaderboard",
  "tools",
  "supplies",
  "todayTalk",
]);

export function shouldPersistQuery(queryKey: readonly unknown[]): boolean {
  const root = queryKey[0];
  return typeof root === "string" && OFFLINE_KEYS.has(root);
}

/**
 * Download a job's full data pack so the install flow works with no signal:
 * openings, unit list, demand, and each type's brain (tips/times/dims).
 */
export async function prefetchJobPack(projectId: string): Promise<number> {
  await Promise.all([
    queryClient.prefetchQuery({ queryKey: ["projects"], queryFn: listProjects }),
    queryClient.prefetchQuery({
      queryKey: ["openings", projectId],
      queryFn: () => listOpenings(projectId),
    }),
    queryClient.prefetchQuery({
      queryKey: ["projectUnits", projectId],
      queryFn: () => getProjectUnits(projectId),
    }),
    queryClient.prefetchQuery({
      queryKey: ["projectWindows", projectId],
      queryFn: () => getProjectWindows(projectId),
    }),
    queryClient.prefetchQuery({
      queryKey: ["plansets", projectId],
      queryFn: () => listPlansets(projectId),
    }),
  ]);

  const openings =
    queryClient.getQueryData<{ window_type_id: string | null }[]>([
      "openings",
      projectId,
    ]) ?? [];
  const typeIds = [
    ...new Set(
      openings.map((o) => o.window_type_id).filter((v): v is string => Boolean(v)),
    ),
  ];
  await Promise.all(
    typeIds.map((typeId) =>
      queryClient.prefetchQuery({
        queryKey: ["typeBrain", typeId],
        queryFn: () => getTypeBrainStats(typeId),
      }),
    ),
  );

  return typeIds.length;
}
