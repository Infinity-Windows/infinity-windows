// React binding for the connection state: online at all, and weak right now.

import { useEffect, useState, useSyncExternalStore } from "react";
import { isWeakSignalRecent, subscribeWeakSignal } from "./weakSignal";

function subscribeOnline(cb: () => void): () => void {
  window.addEventListener("online", cb);
  window.addEventListener("offline", cb);
  return () => {
    window.removeEventListener("online", cb);
    window.removeEventListener("offline", cb);
  };
}

function readOnline(): boolean {
  return typeof navigator === "undefined" || navigator.onLine !== false;
}

export interface ConnectionState {
  online: boolean;
  weak: boolean;
}

export function useConnection(): ConnectionState {
  const online = useSyncExternalStore(subscribeOnline, readOnline, () => true);
  const weakNow = useSyncExternalStore(subscribeWeakSignal, isWeakSignalRecent, () => false);
  // The mark expires on its own after the window; nothing emits then, so
  // re-read once it should have lapsed.
  const [, bump] = useState(0);
  useEffect(() => {
    if (!weakNow) return;
    const t = setTimeout(() => bump((n) => n + 1), 20_500);
    return () => clearTimeout(t);
  }, [weakNow]);
  return { online, weak: online && isWeakSignalRecent() };
}
