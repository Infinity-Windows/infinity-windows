import { MutationCache, QueryClient } from "@tanstack/react-query";
import { createSyncStoragePersister } from "@tanstack/query-sync-storage-persister";
import { getProjectWindows, listProjects } from "./api";
import {
  getTypeBrainStats,
  listMarkSpecs,
  listOpenings,
  listPlansets,
} from "./install/api";
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
  // Every job, whatever its status. The unit sheet sits behind a guard that
  // asks this list whether the job is tracking-only (RequireDataJob in
  // App.tsx), and a guard that cannot answer holds a loading screen. Offline
  // that read never resolves — with no connection react-query PAUSES the retry
  // instead of failing it, so the query stays pending for as long as the phone
  // has no signal — and the sheet the whole install loop runs on sat at
  // "Loading…" the entire time. Found by the offline e2e spec, 2026-09-04.
  "projectsAll",
  "openings",
  "scopeCounts",
  "projectWindows",
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
  // Same shape of bug as toolboxToday, found on review 2026-09-02: the
  // OPENING was cached (so `needs_flashing = true` came back after an offline
  // reload) and the flashing phase row that CLEARS it was not. A unit whose
  // flashing was already done then read as still owing it, Submit went dead
  // with no way out, and the install could not even be queued for later. The
  // fact that clears a gate has to be as offline-durable as the fact that
  // raises it.
  "openingPhases",
  // The same law, one step on (installer research item 2, 2026-09-04): the
  // fact that says WHAT to install has to be as durable as the facts that
  // clear the gates around it. The spec card — sizes, hardware, the OXXO
  // layout, the paperwork somebody reads standing at the opening — was the one
  // thing the unit sheet could not show with no signal, and the "no spec sheet
  // for this mark" notice is itself gated on the spec list being non-empty, so
  // offline the installer got silence instead of a reason. An installer who
  // can read the spec checks it; one who cannot, guesses.
  "markSpecs",
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
 * The whole test App.tsx applies before writing a query to disk: the right
 * key, and an answer that is not still in the air.
 *
 * The status half is not a nicety — it is what keeps the cache readable at
 * all. React Query dehydrates a query that is still PENDING with its
 * in-flight `promise` attached; `JSON.stringify` turns a promise into `{}`,
 * and on the next launch hydrate calls `.then` on that `{}`, throws, and
 * discards the ENTIRE persisted cache as a precaution. Passing only a key
 * test (which is what this replaced) let any query that happened to be
 * mid-flight when the snapshot was taken poison the whole file — so the
 * offline lists above, every one of them added after a real field incident,
 * could silently restore nothing at all. Found by the offline e2e spec
 * (e2e/offline-spec-card.spec.ts), 2026-09-04.
 *
 * PENDING and nothing else. A query whose last refetch FAILED still holds the
 * data from the read before it, and that is precisely the phone this cache
 * exists for: "bars but no data" fails a background refetch on a sheet that
 * was showing the spec fine a minute ago. React Query keeps `state.data`
 * through a failed refetch, and hydrate restores it (it says so itself —
 * "you can opt into dehydrating failed queries, and those can have data from
 * previous successful fetches"). Narrowing this to `=== "success"` looked
 * tidier and quietly deleted the offline copy of markSpecs, openingPhases and
 * toolboxToday from the next snapshot, because the persister rewrites the
 * whole file on every save. Keep the data; drop only what cannot survive
 * JSON.
 */
export function shouldPersistQueryState(
  queryKey: readonly unknown[],
  status: "pending" | "error" | "success",
): boolean {
  return status !== "pending" && shouldPersistQuery(queryKey);
}

/**
 * Download a job's full data pack so the install flow works with no signal:
 * openings, unit list, demand, each type's brain (tips/times/dims), and the
 * per-mark specs the installer reads at the window.
 */
export async function prefetchJobPack(projectId: string): Promise<number> {
  await Promise.all([
    queryClient.prefetchQuery({ queryKey: ["projects"], queryFn: listProjects }),
    // Keeping the key in OFFLINE_KEYS only preserves a spec list somebody has
    // already opened. Downloading the job pack is the promise that the phone
    // has the job on it BEFORE the truck leaves, so the specs have to ride
    // along or the first unit of the day is the one with no card.
    queryClient.prefetchQuery({
      queryKey: ["markSpecs", projectId],
      queryFn: () => listMarkSpecs(projectId),
    }),
    queryClient.prefetchQuery({
      queryKey: ["openings", projectId],
      queryFn: () => listOpenings(projectId),
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
