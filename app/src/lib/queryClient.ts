import { MutationCache, QueryClient } from "@tanstack/react-query";
import { createSyncStoragePersister } from "@tanstack/query-sync-storage-persister";
import { getProjectWindows, listProjects } from "./api";
import {
  downloadPlanset,
  findSpecsPlansetFor,
  getTypeBrainStats,
  listElevationViews,
  listMarkSpecs,
  listOpenings,
  listPlanOutlines,
  listPlansets,
} from "./install/api";
import type { Planset } from "./install/types";
import { saveJobOffline, type JobPackProgress, type JobPackResult } from "./offline/jobPack";
import { OFFLINE_KEY_ROOTS } from "./queryKeys";
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

/**
 * Queries worth keeping offline. Excludes heavy/binary and volatile searches.
 *
 * This used to be a hand-kept list here, with the incident that justified
 * each entry in a comment beside it. It is now derived from
 * `QUERY_KEY_ROOTS` in `lib/queryKeys.ts` — that registry has one row for
 * every query-key root in the app, `offline: true` for exactly the roots
 * that were in this list, and the incident comments moved over as each
 * row's `why`. Add a root there, not here; `queryKeys.test.ts` fails on any
 * root used in the app that isn't registered.
 */
export function shouldPersistQuery(queryKey: readonly unknown[]): boolean {
  const root = queryKey[0];
  return typeof root === "string" && OFFLINE_KEY_ROOTS.has(root);
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
 * Put one job on the phone: openings, unit list, demand, each type's brain,
 * the per-mark specs, the map's outlines and elevations, every planset PDF
 * and every mark's picture. The order, the counting and the keep-going rule
 * live in lib/offline/jobPack; this is where the real reads are plugged in.
 *
 * `fetchQuery` with staleTime 0, not prefetchQuery: a tap on "Refresh offline
 * copy" has to actually refresh, and the data comes back so the runner can
 * see which types and sheets the job has. Never rejects unless the code
 * itself cannot load.
 */
export async function prefetchJobPack(
  projectId: string,
  onProgress?: (p: JobPackProgress) => void,
): Promise<JobPackResult> {
  // No retry: a screen retries once so a blip does not show an error; here a
  // failed read is counted and reported, and the button offers to refresh.
  // Retrying 85 steps twice each turned a two-minute save into four.
  const fetch = <T,>(queryKey: readonly unknown[], queryFn: () => Promise<T>) =>
    queryClient.fetchQuery({ queryKey, queryFn, staleTime: 0, retry: 0 });
  return saveJobOffline<Planset>(
    projectId,
    {
      projects: () => fetch(["projects"], listProjects),
      openings: (id) => fetch(["openings", id], () => listOpenings(id)),
      markSpecs: (id) => fetch(["markSpecs", id], () => listMarkSpecs(id)),
      plansets: (id) => fetch(["plansets", id], () => listPlansets(id)),
      projectWindows: (id) => fetch(["projectWindows", id], () => getProjectWindows(id)),
      elevationViews: (id) => fetch(["elevationViews", id], () => listElevationViews(id)),
      planOutlines: (id) => fetch(["planOutlines", id], () => listPlanOutlines(id)),
      typeBrain: (typeId) => fetch(["typeBrain", typeId], () => getTypeBrainStats(typeId)),
      // downloadPlanset keeps the bytes on the phone as a side effect.
      planset: (planset) => downloadPlanset(planset),
      drawing: async (plansets, spec) => {
        // pdf.js rides in its own chunk; only load it when there is a picture
        // to cut.
        const bbox = (await import("./install/markDrawing")).validateBbox(spec.image_bbox);
        const planset = findSpecsPlansetFor(plansets, spec);
        if (!bbox || spec.image_page == null || !planset || !spec.mark_code) return "none";
        const { hasCachedCrop, markDrawingDataUrl } = await import("./install/drawingCrops");
        const req = { planset, pageNumber: spec.image_page, bbox, markCode: spec.mark_code };
        if (!(await hasCachedCrop(req))) await markDrawingDataUrl(req);
        return "saved";
      },
    },
    onProgress,
  );
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
