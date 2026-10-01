import { formatApiError } from "../errors";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useClock } from "../clockContext";
import { isToolboxGateError } from "../install/installTimer";
import { listWorkSessions, listWorkTypes, listWorkUnits } from "./api";
import {
  dropWorkCommand,
  enqueueWork,
  enqueueWorkBatch,
  readWorkQueue,
  syncWork,
  WORK_QUEUE_EVENT,
} from "./queue";
import { previewCommands, type WorkAction, type WorkCommand } from "./model";

export function useWork(projectId?: string) {
  const clock = useClock();
  const qc = useQueryClient();
  const user = clock.profileId;
  const [queueError, setQueueError] = useState("");
  const [queue, setQueue] = useState<WorkCommand[]>([]);
  const units = useQuery({
    queryKey: ["customWorkUnits", user, projectId ?? "all"],
    queryFn: () => listWorkUnits(projectId),
    enabled: !!user,
    refetchOnWindowFocus: true,
  });
  const sessions = useQuery({
    queryKey: ["customWorkSessions", user, projectId ?? "mine"],
    queryFn: () => listWorkSessions(projectId, projectId ? undefined : user!),
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
        "customWorkTypes",
        "customWorkHistory",
        "crewWorkRecords",
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
      "serviceActive",
      "serviceVisit",
      "customWorkHistory",
      "crewWorkRecords",
      "myOpenSession",
      "myActivePhases",
    ];
    void Promise.allSettled(
      secondary.map((root) => qc.invalidateQueries({ queryKey: [root] })),
    );
    await Promise.all(
      essential.map((root) => qc.invalidateQueries({ queryKey: [root] })),
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
    read();
    window.addEventListener(WORK_QUEUE_EVENT, read);
    window.addEventListener("storage", read);
    window.addEventListener("online", online);
    if (navigator.onLine) void sync().catch((e) => setQueueError(formatApiError(e)));
    return () => {
      window.removeEventListener(WORK_QUEUE_EVENT, read);
      window.removeEventListener("storage", read);
      window.removeEventListener("online", online);
    };
  }, [user, sync, refresh]);
  useEffect(() => {
    void qc.invalidateQueries({ queryKey: ["customWorkSessions", user] });
  }, [
    qc,
    user,
    clock.shift?.id,
    clock.shift?.status,
    clock.shift?.break_started_at,
  ]);
  const command = useCallback(
    async (action: WorkAction, data: Record<string, unknown>) => {
      if (!user) throw new Error("Sign in before saving work.");
      const id = crypto.randomUUID();
      await enqueueWork({ id, userId: user, action, data });
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
    [user, sync],
  );
  /** Dependent changes saved together before any network wait (see
   * enqueueWorkBatch) — "Unit complete" is a stop plus the complete mark. */
  const commandMany = useCallback(
    async (
      list: { action: WorkAction; data: Record<string, unknown>; intent?: WorkCommand["intent"] }[],
    ) => {
      if (!user) throw new Error("Sign in before saving work.");
      await enqueueWorkBatch(
        list.map((x) => ({
          id: crypto.randomUUID(),
          userId: user,
          action: x.action,
          data: x.data,
          ...(x.intent ? { intent: x.intent } : {}),
        })),
      );
      await sync();
    },
    [user, sync],
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
    actionsLoading: units.isLoading || sessions.isLoading,
    error: units.error ?? sessions.error ?? types.error,
    active:
      preview.sessions.find((s) => s.profile_id === user && !s.ended_at) ??
      null,
  };
}
export type WorkStore = ReturnType<typeof useWork>;
