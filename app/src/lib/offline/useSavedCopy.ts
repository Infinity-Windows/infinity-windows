// "Showing the last saved copy": when a screen is drawing data it cannot
// refresh right now, say so — in one line, the same line everywhere.
//
// React Query keeps the last good answer through a paused or failed refetch;
// that is what makes the app usable in a dead spot. It also means a screen
// can be quietly a day old. The installer cannot tell a fresh list from a
// saved one, and "the app says it's ready" was, more than once, the app
// saying what it last heard. This hook is the tell.

import { useEffect } from "react";
import { logOfflineEvent } from "./telemetry";
import { useConnection } from "./useWeakSignal";

export interface SavedCopyQuery {
  data: unknown;
  isError: boolean;
  fetchStatus: "fetching" | "paused" | "idle";
}

/** True when `query` has data and cannot refresh it right now. PURE. */
export function isSavedCopy(q: SavedCopyQuery, online: boolean, weak: boolean): boolean {
  if (q.data === undefined || q.data === null) return false;
  return !online || weak || q.fetchStatus === "paused" || q.isError;
}

export type SavedCopyReason = "offline" | "weak" | "failed" | null;

export function savedCopyReason(q: SavedCopyQuery, online: boolean, weak: boolean): SavedCopyReason {
  if (!isSavedCopy(q, online, weak)) return null;
  if (!online || q.fetchStatus === "paused") return "offline";
  if (weak) return "weak";
  return "failed";
}

/** Reason the screen is on its saved copy, or null when it is live. Logs once per switch. */
export function useSavedCopy(q: SavedCopyQuery, scope: string): SavedCopyReason {
  const { online, weak } = useConnection();
  const reason = savedCopyReason(q, online, weak);
  useEffect(() => {
    if (reason) logOfflineEvent({ type: "saved-copy", scope, message: reason });
  }, [reason, scope]);
  return reason;
}
