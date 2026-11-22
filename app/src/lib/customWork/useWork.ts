import { formatApiError } from "../errors";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient, isCancelledError } from "@tanstack/react-query";
import { useClock } from "../clockContext";
import { isToolboxGateError } from "../install/installTimer";
import { listWorkSessions, listWorkTypes, listWorkUnits } from "./api";
import {
  dropWorkCommand,
  enqueueWork,
  enqueueWorkBatch,
  readWorkQueue,
  syncWork,
  WORK_COMMAND_SENT,
  WORK_QUEUE_EVENT,
} from "./queue";
import { previewCommands, type WorkAction, type WorkCommand, type WorkSession, type WorkUnit } from "./model";
import { subscribeSynced, todaysSignatureOnPhone } from "../offline/outbox";

export function useWork(projectId?: string, recentFrom?: number) {
  const clock = useClock();
  const qc = useQueryClient();
  const user = clock.profileId;
  const sessionRoot = recentFrom ? "recentWorkSessions" : "customWorkSessions";
  const sessionKey = projectId ?? (recentFrom ? "all" : "mine");
  const afterOutbox = useCallback(() => {
    const signature = todaysSignatureOnPhone(user);
    return [
      ...(clock.pending ? [clock.pending.entryId] : []),
      ...(signature ? [signature.entryId] : []),
    ];
  }, [user, clock.pending]);
  const [queueError, setQueueError] = useState("");
  const [queue, setQueue] = useState<WorkCommand[]>([]);
  const units = useQuery({
    queryKey: ["customWorkUnits", user, projectId ?? "all"],
    queryFn: () => listWorkUnits(projectId),
    enabled: !!user,
    refetchOnWindowFocus: true,
  });
  const sessions = useQuery({
    queryKey: [sessionRoot, user, sessionKey, ...(recentFrom ? [recentFrom] : [])],
    queryFn: () => listWorkSessions(projectId, projectId || recentFrom ? undefined : user!,
      recentFrom ? { from: recentFrom, includeOpen: true } : undefined),
    placeholderData: recentFrom === undefined ? undefined : (previous, query) => {
      const [root, viewer, scope, from] = query?.queryKey ?? [];
      return root === sessionRoot && viewer === user && scope === sessionKey &&
        typeof from === "number" && from > recentFrom ? previous : undefined;
    },
    enabled: !!user,
    refetchInterval: 30000,
  });
  const types = useQuery({
    queryKey: ["customWorkTypes", user],
    queryFn: listWorkTypes,
    enabled: !!user,
  });
  const refresh = useCallback(async () => {
    await Promise.all(
      [
        "serviceActive",
        "serviceVisit",
        "customWorkUnits",
        "customWorkSessions",
        "recentWorkSessions",
        "opening-work-progress",
        "planActivityDone",
        "myInstallerPlan",
        "dataReview",
        "dailyLogDraft",
        "customWorkTypes",
        "customWorkHistory",
        "crewWorkRecords",
        "stageContributorSummary",
        "myOpenSession",
        "myActivePhases",
      ].map((root) => qc.invalidateQueries({ queryKey: [root] })),
    );
  }, [qc]);
  const refreshAfterSync = useCallback(async () => {
    // A unit tap needs fresh unit/session data before its button becomes ready
    // again. Service and report views should refresh too, but their reads must
    // not hold up the installer's next tap on a weak connection.
    const essential = ["customWorkUnits", "customWorkSessions", "customWorkTypes"];
    const secondary = [
      "planActivityDone",
      "myInstallerPlan",
      "recentWorkSessions",
      "serviceActive",
      "serviceVisit",
      "customWorkHistory",
      "opening-work-progress",
      "dataReview",
      "dailyLogDraft",
      "crewWorkRecords",
      "myOpenSession",
      "myActivePhases",
    ];
    void Promise.allSettled(
      secondary.map((root) => qc.invalidateQueries({ queryKey: [root] })),
    );
    // A refresh that is cancelled because the next saved change replaced it
    // (see `confirmed` below) is not a failure. Left to throw, it showed
    // "CancelledError" on Workday and locked the controls for a moment after
    // a clock-in start (seen 2026-11-20).
    await Promise.all(
      essential.map((root) => qc.invalidateQueries({ queryKey: [root] }).catch((e) => {
        if (!isCancelledError(e)) throw e;
      })),
    );
  }, [qc]);
  const sync = useCallback(async () => {
    if (user) {
      // Opening Work while nothing is queued must not refetch its unit lists
      // immediately after their first load. Reconnecting is different: other
      // crew may have changed records while this phone had no signal.
      const before = readWorkQueue(user);
      if (!before.length) return;
      await syncWork(user);
      const remaining = new Set(readWorkQueue(user).map((c) => c.id));
      if (before.some((c) => !remaining.has(c.id))) await refreshAfterSync();
    }
  }, [user, refreshAfterSync]);
  useEffect(() => {
    const read = () => {
      try {
        setQueue(user ? readWorkQueue(user) : []);
        setQueueError("");
      } catch (e) {
        setQueueError(formatApiError(e));
      }
    };
    const online = () => {
      if (!user) return;
      void syncWork(user)
        .then(refresh)
        .catch((e) => setQueueError(formatApiError(e)));
    };
    const confirmed = (event: Event) => {
      const command = (event as CustomEvent<WorkCommand>).detail;
      if (command.userId !== user) return;
      const unitKey = ["customWorkUnits", user, projectId ?? "all"];
      const key = [sessionRoot, user, sessionKey, ...(recentFrom ? [recentFrom] : [])];
      const savedUnits = qc.getQueryData<WorkUnit[]>(unitKey);
      const savedSessions = qc.getQueryData<WorkSession[]>(key);
      const next = previewCommands(savedUnits ?? [], savedSessions ?? [], [command]);
      // Keep the acknowledged change visible between removing it from the
      // device queue and refreshing the server lists.
      if (savedUnits && (next.units.some(unit => unit.id === command.data.id) || command.action === "start" && command.data.unit_id)) {
        void qc.cancelQueries({ queryKey: unitKey, exact: true }, { revert: false });
        qc.setQueryData(unitKey, projectId ? next.units.filter(unit => unit.project_id === projectId) : next.units);
      }
      if (savedSessions && ["start", "stop", "session", "machinery_correction", "workday_activity"].includes(command.action)) {
        void qc.cancelQueries({ queryKey: key, exact: true }, { revert: false });
        qc.setQueryData(key, projectId ? next.sessions.filter(session => session.project_id === projectId) : next.sessions);
      }
    };
    read();
    const unsubscribePunches = subscribeSynced(online);
    window.addEventListener(WORK_COMMAND_SENT, confirmed);
    window.addEventListener(WORK_QUEUE_EVENT, read);
    window.addEventListener("storage", read);
    window.addEventListener("online", online);
    if (navigator.onLine) void sync().catch((e) => setQueueError(formatApiError(e)));
    return () => {
      window.removeEventListener(WORK_QUEUE_EVENT, read);
      unsubscribePunches();
      window.removeEventListener(WORK_COMMAND_SENT, confirmed);
      window.removeEventListener("storage", read);
      window.removeEventListener("online", online);
    };
  }, [user, projectId, qc, sync, refresh, sessionRoot, sessionKey, recentFrom]);
  useEffect(() => {
    void qc.invalidateQueries({ queryKey: ["customWorkSessions", user] });
    if (navigator.onLine) void sync().catch(e => setQueueError(formatApiError(e)));
  }, [
    qc,
    user,
    clock.shift?.id,
    clock.shift?.status,
    clock.shift?.break_started_at,
    sync,
  ]);
  const command = useCallback(
    async (action: WorkAction, data: Record<string, unknown>, options?: { background: boolean }) => {
      if (!user) throw new Error("Sign in before saving work.");
      const id = crypto.randomUUID();
      await enqueueWork({ id, userId: user, action, data, afterOutbox: action === "session" || action === "machinery_correction" || action === "plan_activity_done" || action === "plan_unit_lead" ? [] : afterOutbox() });
      if (options?.background) {
        void sync().catch(e => setQueueError(formatApiError(e)));
        return;
      }
      await sync();
      // A refused request normally stays queued, with its error, for review
      // (queue.ts) — the captured times are what a foreman reviews. The one
      // refusal with nothing to review is the toolbox signature: a unit or
      // Prep-time start turned away because today's talk is not signed
      // (20261031000000; under the paid-time rule a person can be on the
      // clock unsigned). Nothing was written, and a retry after signing
      // would carry the unsigned tap's time — so that request is dropped,
      // and the refusal is thrown to the tap that sent it so the screen can
      // say it in the phone's words and point at the talk.
      const refused = readWorkQueue(user).find((c) => c.id === id)?.error;
      if (refused && isToolboxGateError(refused)) {
        await dropWorkCommand(user, id);
        throw new Error(refused);
      }
    },
    [user, sync, afterOutbox],
  );
  /** Dependent changes saved together before any network wait (see
   * enqueueWorkBatch) — "Unit complete" is a stop plus the complete mark. */
  const commandMany = useCallback(
    async (
      list: { action: WorkAction; data: Record<string, unknown>; intent?: WorkCommand["intent"] }[],
      options?: { background: boolean },
    ) => {
      if (!user) throw new Error("Sign in before saving work.");
      await enqueueWorkBatch(
        list.map((x) => ({
          id: crypto.randomUUID(),
          userId: user,
          afterOutbox: afterOutbox(),
          action: x.action,
          data: x.data,
          ...(x.intent ? { intent: x.intent } : {}),
        })),
      );
      if (options?.background) void sync().catch(e => setQueueError(formatApiError(e)));
      else await sync();
    },
    [user, sync, afterOutbox],
  );
  const preview = useMemo(
    () => previewCommands(units.data ?? [], sessions.data ?? [], queue),
    [units.data, sessions.data, queue],
  );
  return {
    clock,
    user,
    units: preview.units,
    sessions: preview.sessions,
    types: types.data ?? [],
    queue,
    queueError,
    command,
    commandMany,
    refresh,
    sync,
    loading: units.isLoading || sessions.isLoading || types.isLoading,
    // Work types only fill the new-unit suggestions. Starting or finishing a
    // unit can proceed while those suggestions load, but the type-management
    // view still waits for its complete list before showing editable rows.
    loadingOlderSessions: sessions.isFetching && sessions.isPlaceholderData,
    actionsLoading: units.data === undefined || sessions.data === undefined,
    // Not a cancelled read: `confirmed` above cancels a refresh on purpose
    // when it puts the just-saved change on screen, and that showed as
    // "CancelledError" for a second after a clock-in start (seen 2026-11-20).
    error: [units.error, sessions.error, types.error].find((e) => e && !isCancelledError(e)) ?? null,
    active:
      preview.sessions.find((s) => s.profile_id === user && !s.ended_at) ??
      null,
  };
}
export type WorkStore = ReturnType<typeof useWork>;
