import { formatApiError } from "../errors";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useClock } from "../clockContext";
import { listWorkSessions, listWorkTypes, listWorkUnits } from "./api";
import {
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
  const sync = useCallback(async () => {
    if (user) {
      await syncWork(user);
      await refresh();
    }
  }, [user, refresh]);
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
      void sync().catch((e) => setQueueError(formatApiError(e)));
    };
    read();
    window.addEventListener(WORK_QUEUE_EVENT, read);
    window.addEventListener("storage", read);
    window.addEventListener("online", online);
    if (navigator.onLine) online();
    return () => {
      window.removeEventListener(WORK_QUEUE_EVENT, read);
      window.removeEventListener("storage", read);
      window.removeEventListener("online", online);
    };
  }, [user, sync]);
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
      await enqueueWork({
        id: crypto.randomUUID(),
        userId: user,
        action,
        data,
      });
      await sync();
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
    error: units.error ?? sessions.error ?? types.error,
    active:
      preview.sessions.find((s) => s.profile_id === user && !s.ended_at) ??
      null,
  };
}
export type WorkStore = ReturnType<typeof useWork>;
