import { useCallback, useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useClock } from "../clockContext";
import { getServiceVisit, listServiceVisits, listActiveService } from "./api";
import {
  enqueueService,
  readServiceQueue,
  syncService,
  retryService,
  SERVICE_QUEUE_EVENT,
} from "./queue";
import {
  flushServiceMedia,
  pendingServiceMedia,
  type PendingServiceMedia,
} from "./mediaQueue";
import {
  previewService,
  type ServiceAction,
  type ServiceCommand,
} from "./model";
import { formatApiError } from "../errors";
export function useService(visitId?: string | null) {
  const clock = useClock(),
    user = clock.profileId,
    qc = useQueryClient();
  const [queue, setQueue] = useState<ServiceCommand[]>([]),
    [files, setFiles] = useState<PendingServiceMedia[]>([]),
    [syncError, setSyncError] = useState("");
  const visits = useQuery({
    queryKey: ["serviceVisits", user],
    queryFn: listServiceVisits,
    enabled: !!user,
    refetchInterval: 30000,
  });
  const snapshot = useQuery({
    queryKey: ["serviceVisit", user, visitId],
    queryFn: () => getServiceVisit(visitId!),
    enabled: !!user && !!visitId,
    refetchInterval: 30000,
  });
  const active = useQuery({
    queryKey: ["serviceActive", user],
    queryFn: () => listActiveService(user!),
    enabled: !!user,
    refetchInterval: 15000,
  });
  const refresh = useCallback(async () => {
    await Promise.all(
      [
        "serviceVisit",
        "serviceVisits",
        "serviceActive",
        "customWorkSessions",
        "myOpenSession",
      ].map((root) => qc.invalidateQueries({ queryKey: [root] })),
    );
  }, [qc]);
  const sync = useCallback(async () => {
    if (!user) return;
    setSyncError("");
    try {
      await syncService(user);
      await flushServiceMedia(user);
    } catch (e) {
      setSyncError(formatApiError(e));
    } finally {
      setQueue(readServiceQueue(user));
      setFiles(await pendingServiceMedia(user));
      await refresh();
    }
  }, [user, refresh]);
  useEffect(() => {
    if (!user) return;
    const read = () => {
      try {
        setQueue(readServiceQueue(user));
        void pendingServiceMedia(user)
          .then(setFiles)
          .catch((e) => setSyncError(formatApiError(e)));
      } catch (e) {
        setSyncError(formatApiError(e));
      }
    };
    const online = () => void sync();
    read();
    online();
    window.addEventListener(SERVICE_QUEUE_EVENT, read);
    window.addEventListener("online", online);
    window.addEventListener("storage", read);
    const tick = window.setInterval(online, 30000);
    return () => {
      clearInterval(tick);
      window.removeEventListener(SERVICE_QUEUE_EVENT, read);
      window.removeEventListener("online", online);
      window.removeEventListener("storage", read);
    };
  }, [user, sync]);
  async function command(action: ServiceAction, data: Record<string, unknown>) {
    if (!user) throw new Error("Sign in first.");
    if (readServiceQueue(user).some((c) => c.error))
      throw new Error("Review the saved request before adding more changes.");
    await enqueueService({
      id: crypto.randomUUID(),
      userId: user,
      action,
      data,
    });
    await sync();
    const refused = readServiceQueue(user).find((c) => c.error);
    if (refused) throw new Error(refused.error);
  }
  async function retry() {
    if (user) {
      await retryService(user);
      await sync();
    }
  }
  const data = useMemo(
    () => previewService(snapshot.data, queue),
    [snapshot.data, queue],
  );
  return {
    clock,
    user,
    visits,
    snapshot,
    data,
    active,
    queue,
    files,
    syncError,
    sync,
    command,
    retry,
    refresh,
  };
}
