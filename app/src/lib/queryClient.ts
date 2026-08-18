import { MutationCache, QueryClient } from "@tanstack/react-query";
import { createSyncStoragePersister } from "@tanstack/query-sync-storage-persister";
import { getProjectUnits, getProjectWindows, listProjects } from "./api";
import { getTypeBrainStats, listOpenings, listPlansets } from "./install/api";
import { toastError } from "./toast";

// offlineFirst: when there's no connection, queries resolve from the persisted
// cache instead of hanging — the whole install flow keeps working in dead spots.
export const queryClient = new QueryClient({
  // Any mutation that fails without its own onError surfaces a toast instead of
  // failing silently.
  mutationCache: new MutationCache({
    onError: (error, _vars, _ctx, mutation) => {
      if (!mutation.options.onError) toastError(error);
    },
  }),
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
  // "Where is it?" from the last good read. A conex is a metal box with no
  // bars, and the harder half of working in one is READING — you have to find
  // things in there, not just record what you took (ticket 10). The hub's
  // numbers moved off `inventory` onto packages in ticket 06, so these four
  // are what the Find bar and the cards actually need.
  "storagePackages",
  "storageContainers",
  "scheduledMarks",
  "issues",
  "inventory",
  "findableUnits",
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
  // The talk itself was cached but not whether YOU signed it, so after an
  // offline reload the app could see a talk exists and not that the gate was
  // already cleared — every Start install silently refused, with no message,
  // for as long as there was no signal. That is the exact situation the
  // offline work exists for (installer audit, 2026-08-17).
  "toolboxToday",
  "toolboxHistory",
  // Shelf and bin addresses. Without these a supply with a home spot degrades
  // to "home spot set" — which looks configured and tells nobody where to go,
  // in the conex where the answer matters most.
  "locations",
  // Travel Info — assigned trips must be viewable in transit / dead zones.
  "trips",
  "trip",
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

/**
 * Download everything the warehouse page needs to answer "where is it" with
 * no signal (ticket 10).
 *
 * Called once per session from App.tsx, right after the session is
 * established — sign-in is the moment there is most likely to be signal, and
 * it is well before anyone navigates to the warehouse, let alone walks into a
 * conex. Writing offline was the easy half; this is the half that decides
 * whether the trip inside is useful at all.
 *
 * It used to be called from the warehouse page's own mount (ticket D9), firing
 * at the same instant as that page's own queries. It could not get ahead of
 * anything, which made the "already on the phone" promise above untrue. The
 * warehouse page may still call it; that is harmless — the 30s staleTime makes
 * a repeat inside the same visit a no-op.
 *
 * Deliberately quiet: a failure here means the cache keeps whatever it had,
 * which is exactly the fallback anyway. Never blocks the page, and never
 * rejects, so callers do not need a .catch().
 */
export async function prefetchWarehousePack(): Promise<void> {
  try {
    // Inside the guard on purpose: these are chunks fetched over the network,
    // and a phone on one bar drops a chunk as easily as it drops a read. Left
    // outside, they were the one way this function could still reject — into a
    // `void` call at sign-in with nobody listening.
    const { listActivePackages, listContainers } = await import("./storage");
    const { listIssues } = await import("./issues");
    const { listScheduledMarks } = await import("./warehouse/warehouseCards");
    const { listLocations } = await import("./api");

    await Promise.all([
      queryClient.prefetchQuery({ queryKey: ["projects"], queryFn: listProjects }),
      queryClient.prefetchQuery({
        queryKey: ["storagePackages"],
        queryFn: listActivePackages,
      }),
      queryClient.prefetchQuery({
        queryKey: ["storageContainers"],
        queryFn: listContainers,
      }),
      queryClient.prefetchQuery({ queryKey: ["issues"], queryFn: listIssues }),
      // Racks and staging bays. Without these the warehouse page still answers
      // "where is it" offline, but a staged package answers "on a shelf"
      // instead of "staged for BLACK22" — the generic sentence F6 was raised to
      // get rid of, back again in the one place it costs the most.
      queryClient.prefetchQuery({ queryKey: ["locations"], queryFn: listLocations }),
      // Racks and staging bays. Without these the warehouse page still answers
      // "where is it" offline, but a staged package answers "on a shelf"
      // instead of "staged for BLACK22" — the generic sentence F6 was raised to
      // get rid of, back again in the one place it costs the most.
    ]);

    const projects =
      queryClient.getQueryData<{ id: string }[]>(["projects"]) ?? [];
    const activeIds = projects.map((p) => p.id);
    if (activeIds.length > 0) {
      await queryClient.prefetchQuery({
        queryKey: ["scheduledMarks", activeIds],
        queryFn: () => listScheduledMarks(activeIds),
      });
    }
  } catch {
    /* offline already, or a read failed — the cache keeps its last good copy */
  }
}
