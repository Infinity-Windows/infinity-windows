// React binding for the offline outbox. A tiny useSyncExternalStore hook that
// re-renders whenever pending counts change, plus a one-time effect to start
// the background drainer. No context needed — the outbox is a module singleton.

import { useEffect, useSyncExternalStore } from "react";
import { getCounts, getHeldCount, initOutboxAutoFlush, subscribe } from "./outbox";
import { pillSummary, type OpCounts, type PillSummary } from "./outbox-core";

export interface OutboxState {
  counts: OpCounts;
  pill: PillSummary;
  /** Writes on this phone that belong to someone who is not signed in now. */
  held: number;
}

/** Subscribe to live pending counts + the derived pill summary. */
export function useOutbox(): OutboxState {
  const counts = useSyncExternalStore(subscribe, getCounts, getCounts);
  const held = useSyncExternalStore(subscribe, getHeldCount, getHeldCount);
  useEffect(() => {
    initOutboxAutoFlush();
  }, []);
  return { counts, pill: pillSummary(counts), held };
}
