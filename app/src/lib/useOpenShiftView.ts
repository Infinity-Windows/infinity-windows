// The open shift as the clock screens should show it (Release 0, K0.1): the
// server's answer with the phone's own queued punches applied. One hook, so
// the provider, the landing block and the pages that gate on "is a shift open"
// all agree — the block used to poll the same query key as the provider and
// still disagreed with it the moment a punch was queued.

import { useMemo, useSyncExternalStore } from "react";
import { useQuery, useQueryClient, type QueryClient, type UseQueryResult } from "@tanstack/react-query";
import { mergeClockQueue, type ClockNameLookups, type ClockQueueView } from "./clockQueueView";
import { getClockQueueSnapshot, resolveShiftRef, subscribe } from "./offline/outbox";
import { getOpenShift, type CostCode, type TimeShift } from "./timeclock";
import type { Project } from "./types";

export interface OpenShiftView extends ClockQueueView {
  /** The server's own answer, untouched — what the merge started from. */
  query: UseQueryResult<TimeShift | null>;
  /** False until this phone's queue has been read once since launch. */
  ready: boolean;
}

/**
 * Names for a queued clock-in, from what the phone already holds: the job
 * list (kept offline) and the cost codes the picker loaded. Read at merge
 * time rather than subscribed to — a queued punch is made from a list the
 * person just picked from, so the names are there by the time it exists.
 */
function lookupsFrom(qc: QueryClient): ClockNameLookups {
  return {
    project: (id) => (qc.getQueryData<Project[]>(["projects"]) ?? []).find((p) => p.id === id),
    costCode: (id, projectId) => {
      const lists = [
        qc.getQueryData<CostCode[]>(["clockCostCodes", projectId ?? "all"]),
        qc.getQueryData<CostCode[]>(["clockCostCodes", "all"]),
        qc.getQueryData<CostCode[]>(["costCodes"]),
      ];
      for (const list of lists) {
        const hit = list?.find((c) => c.id === id);
        if (hit) return hit;
      }
      return null;
    },
  };
}

export function useOpenShiftView(
  profileId: string | null,
  opts: { poll?: boolean } = {},
): OpenShiftView {
  const qc = useQueryClient();
  const query = useQuery({
    queryKey: ["openShift", profileId],
    queryFn: () => getOpenShift(profileId!),
    enabled: Boolean(profileId),
    // The provider polls so the nav timer stays honest if the tab was
    // backgrounded through a punch; a page reading the same key need not.
    ...(opts.poll ? { refetchInterval: 60_000, refetchOnWindowFocus: true } : {}),
  });
  const snapshot = useSyncExternalStore(subscribe, getClockQueueSnapshot, getClockQueueSnapshot);
  // App bootstrap hydrates the snapshot; this hook only observes it.
  // The sender's own pending→real map rides along, so a break or clock-out
  // queued behind a clock-in that has since landed still lands on the
  // server's row here. The map is not reactive, and need not be: every
  // change to it is followed by a queue change (the confirmed entry leaving)
  // or a server-shift change (the confirmed row installed), either of which
  // re-runs this merge.
  const view = useMemo(
    () =>
      mergeClockQueue(query.data, snapshot.entries, {
        profileId,
        lookups: lookupsFrom(qc),
        resolveShiftRef,
      }),
    [query.data, snapshot, profileId, qc],
  );
  return { ...view, query, ready: snapshot.ready };
}
