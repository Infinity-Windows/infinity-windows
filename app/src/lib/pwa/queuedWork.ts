// Everything on this phone that is still waiting to be sent, or is being sent
// right now — read at the moment an automatic reload is about to happen.
//
// WHY. The outboxes replay writes in the background: clock punches, installs,
// photos, receipts, custom-work and servicing commands. A reload in the middle
// of a drain can send the same punch twice, because the reload lands between
// the server taking the write and the phone recording that it was taken — and
// `clock_out` is not idempotent on the server. So none of the automatic update
// paths may fire while a queue holds anything or a drain is running. The
// banner asks again the moment a queue changes (`subscribeQueuedWork`).
//
// There are more queues than the sync pill counts. The pill folds in the main
// outbox, the install outbox and custom work; the legacy upload queue
// (`wops-upload-queue`, install photos and voice memos) and the servicing
// evidence store are read here too, because a reload does not care which pill
// a write is missing from.
//
// Two judgement calls, both deliberate:
//
//   - FAILED items do not count. A dead-lettered write, a refused work command,
//     a transcription waiting for an explicit Retry: each has stopped trying,
//     a reload cannot resend it, and a stuck row must not keep a phone from
//     ever updating again.
//   - A queue that cannot be READ counts as empty. That is the opposite of the
//     AI timing guard's reading (pendingClockWrites: cannot read → pending),
//     and it is right for this question: a store this session cannot open is
//     one it cannot be draining from either, and the "is a drain running"
//     flags are synchronous module state that never touch the store.

import { isDraining, pendingWriteCount, subscribe as subscribeOutbox } from "../offline/outbox";
import {
  isFlushingInstalls,
  pendingInstallCount,
  subscribeSyncListeners,
} from "../install/installOutbox";
import { isFlushingUploads, pendingUploadCount } from "../install/queue";
import { readWorkQueue, WORK_QUEUE_EVENT } from "../customWork/queue";

export interface QueuedWork {
  /** Items still waiting to go out, across every queue. */
  waiting: number;
  /** A drain or flush is running right now, whatever the counts say. */
  sending: boolean;
}

/** Does this reading hold an automatic reload back? */
export function blocksReload(q: QueuedWork): boolean {
  return q.waiting > 0 || q.sending;
}

/**
 * Is a drain or flush running at this instant? Synchronous — the three flags
 * are module state, never the stores — so the hold banner's Refresh button can
 * ask one last time as it is tapped. Items merely WAITING (offline, or the
 * legacy upload queue with nothing flushing it) are safe to reload over: they
 * are durable and nothing is mid-request. The duplicate-send risk is only a
 * drain in flight.
 */
export function isSendingNow(): boolean {
  return isDraining() || isFlushingInstalls() || isFlushingUploads();
}

async function count(read: () => Promise<number> | number): Promise<number> {
  try {
    return await read();
  } catch {
    return 0;
  }
}

/**
 * Read every queue. `userId` scopes the per-person queues (custom work,
 * servicing), which are keyed by account; with no signed-in account those
 * hold nothing this session could be sending.
 */
export async function readQueuedWork(userId: string | null): Promise<QueuedWork> {
  const sending = isSendingNow();
  const reads: Array<Promise<number>> = [
    count(pendingWriteCount),
    count(pendingInstallCount),
    count(pendingUploadCount),
  ];
  if (userId) {
    reads.push(
      count(() => readWorkQueue(userId).filter((c) => !c.error).length),
      // Servicing lives outside the shell bundle; reach it only when asked so
      // the banner does not pull the service screens into the first paint.
      count(async () => {
        const { readServiceQueue } = await import("../servicing/queue");
        return readServiceQueue(userId).filter((c) => !c.error).length;
      }),
      count(async () => {
        const { pendingServiceMedia } = await import("../servicing/mediaQueue");
        return (await pendingServiceMedia(userId)).filter((m) => !m.error).length;
      }),
    );
  }
  const counts = await Promise.all(reads);
  return { waiting: counts.reduce((a, b) => a + b, 0), sending };
}

/**
 * Hear about a queue changing — something enqueued, sent, or given up on.
 * Covers every queue that announces itself; the servicing evidence store does
 * not, which is what HOLD_RECHECK_MS in updateCore is for. Returns the
 * unsubscribe function.
 */
export function subscribeQueuedWork(listener: () => void): () => void {
  const undo: Array<() => void> = [subscribeOutbox(listener), subscribeSyncListeners(listener)];
  if (typeof window !== "undefined") {
    window.addEventListener(WORK_QUEUE_EVENT, listener);
    undo.push(() => window.removeEventListener(WORK_QUEUE_EVENT, listener));
  }
  let disposed = false;
  if (typeof window !== "undefined") {
    void import("../servicing/queue")
      .then(({ SERVICE_QUEUE_EVENT }) => {
        if (disposed) return;
        window.addEventListener(SERVICE_QUEUE_EVENT, listener);
        undo.push(() => window.removeEventListener(SERVICE_QUEUE_EVENT, listener));
      })
      .catch(() => {
        // The servicing chunk failed to load: its backstop re-check still runs.
      });
  }
  return () => {
    disposed = true;
    for (const fn of undo) fn();
  };
}
