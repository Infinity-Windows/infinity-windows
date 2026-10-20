// The open shift as the clock screens should show it (Release 0, K0.1): the
// server's answer with the phone's own queued punches applied. One hook, so
// the provider, the landing block and the pages that gate on "is a shift open"
// all agree — the block used to poll the same query key as the provider and
// still disagreed with it the moment a punch was queued.

import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useQuery, useQueryClient, type QueryClient, type UseQueryResult } from "@tanstack/react-query";
import { mergeClockQueue, type ClockNameLookups, type ClockQueueView } from "./clockQueueView";
import { getClockQueueSnapshot, initOutboxAutoFlush, resolveShiftRef, subscribe } from "./offline/outbox";
import { type CostCode, type TimeShift } from "./timeclock";
import type { Project } from "./types";
import { clockReadFor } from "./clockRead";
import { clockReadFingerprint, clockReadState, savedShiftIsPlausible, CLOCK_READ_MAX_AGE_MS, type ClockReadState } from "./clockReadState";
import { signInGeneration, subscribeSignedIn, stillSignedInAs, signInMark } from "./signedIn";

export interface OpenShiftView extends ClockQueueView {
  /** The server's own answer, untouched — what the merge started from. */
  query: UseQueryResult<TimeShift | null>;
  /** False until this phone's queue has been read once since launch. */
  ready: boolean;
  verification: ClockReadState;
  recheck: () => void;
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
  const actorGeneration = useSyncExternalStore(subscribeSignedIn, signInGeneration, signInGeneration);
  const actorMatches = Boolean(profileId && stillSignedInAs(signInMark(), profileId));
  const reader = useMemo(() => clockReadFor(qc, profileId ?? ""), [qc, profileId]);
  const receipt = useSyncExternalStore(reader.subscribe, reader.snapshot, reader.snapshot);
  const [, setNow] = useState(Date.now());
  // The interval causes expiry renders; a newly delivered receipt must be
  // compared with this render's time, not the previous interval's timestamp.
  const now = Date.now();
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const query = useQuery({
    queryKey: ["openShift", profileId],
    queryFn: ({ signal }) => reader.load(signal),
    enabled: Boolean(profileId) && actorMatches,
    retry: false,
    refetchOnMount: "always",
    // The provider polls so the nav timer stays honest if the tab was
    // backgrounded through a punch; a page reading the same key need not.
    ...(opts.poll ? { refetchInterval: 60_000, refetchOnWindowFocus: true } : {}),
  });
  // The query key deliberately stays compatible with existing punch writers.
  // A -> B -> A can otherwise leave A's old in-flight read on that same key.
  const refetch = query.refetch;
  const lastActorGeneration = useRef(actorGeneration);
  useEffect(() => {
    if (lastActorGeneration.current === actorGeneration) return;
    lastActorGeneration.current = actorGeneration;
    const mark = signInMark();
    void qc.cancelQueries({ queryKey: ["openShift", profileId], exact: true }).then(() => {
      if (profileId && stillSignedInAs(mark, profileId)) void refetch();
    });
  }, [actorGeneration, profileId, qc, refetch]);
  const snapshot = useSyncExternalStore(subscribe, getClockQueueSnapshot, getClockQueueSnapshot);
  // The snapshot is filled by the outbox's own startup read; make sure that
  // has been asked for, whoever mounts first (the pill asks too — it's once).
  useEffect(() => {
    initOutboxAutoFlush();
  }, []);
  // The sender's own pending→real map rides along, so a break or clock-out
  // queued behind a clock-in that has since landed still lands on the
  // server's row here. The map is not reactive, and need not be: every
  // change to it is followed by a queue change (the confirmed entry leaving)
  // or a server-shift change (the confirmed row installed), either of which
  // re-runs this merge.
  const entries = useMemo(() => snapshot.entries.filter((entry) =>
    (!entry.ownerId || entry.ownerId === profileId) &&
    (!entry.payload.profileId || entry.payload.profileId === profileId)), [snapshot, profileId]);
  // Sending/queued is the same intent. A failed, removed, or changed punch is
  // not: it must be replayed again instead of inheriting a prior receipt.
  const queueKey = useMemo(() => JSON.stringify(entries.filter((entry) => entry.status !== "failed")
    .map((entry) => [entry.id, entry.op, entry.createdAt, entry.payload])), [entries]);
  const receiptMatches = Boolean(profileId && receipt.mark && stillSignedInAs(receipt.mark, profileId) &&
    receipt.fingerprint === clockReadFingerprint(query.data) && now >= receipt.checkedAt && now - receipt.checkedAt < CLOCK_READ_MAX_AGE_MS);
  const view = useMemo(() => {
    let queueHasState = false;
    let appliedEntryIds: string[] = [];
    let matchedEntryIds: string[] = [];
    let matchedTargets: Record<string, string> = {};
    const matched = (entry: (typeof entries)[number]) => {
      matchedEntryIds.push(entry.id);
      const ref = entry.payload.shiftRef;
      if (typeof ref === "string") matchedTargets[entry.id] = resolveShiftRef(ref) ?? ref;
    };
    const options = {
        profileId,
        lookups: lookupsFrom(qc),
        resolveShiftRef,
        onStateApplied: (entry: (typeof entries)[number]) => { queueHasState = true; appliedEntryIds.push(entry.id); },
        onPunchMatched: matched,
      };
    const merged = mergeClockQueue(query.data, entries, options);
    // A -> B -> A must replay even when actorMatches returns to true.
    const canReplay = actorMatches && signInMark().generation === actorGeneration;
    if (!queueHasState && queueKey !== "[]" && canReplay) {
      queueHasState = reader.hasLocalIntent(queueKey, merged.shift);
      if (queueHasState) {
        appliedEntryIds = reader.localIntentEntryIds(queueKey, merged.shift);
        matchedEntryIds = appliedEntryIds;
        matchedTargets = reader.localIntentTargets(queueKey, merged.shift);
      }
      // The queue and optimistic null can arrive in the same React batch,
      // before a render has recorded the applied clock-out. Replay against
      // the committed row from before that tap, but use it ONLY to prove a
      // matching clock-out. Never restore the row as the displayed shift.
      const base = reader.queueBase();
      if (!queueHasState && query.data == null && savedShiftIsPlausible(base, Date.now())) {
        let applied = false;
        const replayIds: string[] = [];
        const replay = mergeClockQueue(base, entries, { ...options, onStateApplied: (entry) => { applied = true; replayIds.push(entry.id); } });
        queueHasState = applied && replay.shift === null;
        if (queueHasState) appliedEntryIds = replayIds;
      }
    }
    return { ...merged, queueHasState, matchedEntryIds, matchedTargets };
  },
    [query.data, entries, queueKey, profileId, qc, reader, actorMatches, actorGeneration],
  );
  useLayoutEffect(() => {
    if (!actorMatches) return;
    reader.rememberQueueBase(query.data);
    if (snapshot.ready && queueKey !== "[]" && (view.queueHasState ||
        (view.shift && (savedShiftIsPlausible(view.shift, now) || (receiptMatches && !receipt.failed))))) {
      reader.rememberLocalIntent(queueKey, view.shift, view.matchedEntryIds, view.matchedTargets);
    }
  }, [reader, query.data, snapshot.ready, queueKey, view.queueHasState, view.matchedEntryIds, view.matchedTargets,
    view.shift, actorMatches, actorGeneration, now, receiptMatches, receipt.failed]);
  const verification = clockReadState({
    shift: view.shift, profileId, actorMatches: actorMatches && snapshot.ready, checking: receipt.checking || !snapshot.ready,
    verified: receiptMatches && !receipt.failed && !view.pending,
    recentVerifiedNull: receiptMatches && receipt.fingerprint === "null",
    // A deliberately saved empty clock supports cold-relaunch offline Start.
    // It remains saved, never verified. An unmatched/refused queued punch or
    // an unaccepted own ACK is conflicting evidence, so null cannot bypass it.
    savedNull: query.data === null && entries.length === 0 && !receipt.invalidated,
    queueHasState: snapshot.ready && (view.queueHasState || reader.hasAcknowledgedIntent(query.data, now)), now,
  });
  return { ...view, query, ready: snapshot.ready, verification, recheck: () => { void query.refetch({ cancelRefetch: true }); } };
}
