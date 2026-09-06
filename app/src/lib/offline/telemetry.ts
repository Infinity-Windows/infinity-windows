// A short memory of what the phone's connection did, for the diagnostics
// screen. Sixty events, in memory, dependency-free.
//
// "It didn't save" is unanswerable today: by the time somebody reads the
// message the moment is gone and nothing wrote it down. This ring keeps the
// events that explain a bad field session — a request that timed out, a
// screen that fell back to its saved copy, a queue flush and what it sent, a
// job saved for offline — so the answer is one screenshot of /diagnostics
// away. Never persisted: it is about THIS session, and a phone's storage is
// for the job, not for logs.

export type OfflineEventType = "timeout" | "saved-copy" | "flush" | "save-job" | "reload";

export interface OfflineEvent {
  type: OfflineEventType;
  /** Where it happened: a screen or resource name, e.g. "supabase", "jobs". */
  scope?: string;
  /** A number that matters: items sent, items saved, pictures missing. */
  count?: number;
  message?: string;
  at: number;
}

export const RING_MAX = 60;

const ring: OfflineEvent[] = [];
const listeners = new Set<() => void>();
// The snapshot handed to readers. Rebuilt only when the ring changes, and
// otherwise the SAME array every time: useSyncExternalStore compares the
// reference, and a getter that built a fresh array per call rendered
// /diagnostics in a loop until React gave up ("Maximum update depth").
let snapshot: readonly OfflineEvent[] = [];

function changed(): void {
  snapshot = [...ring].reverse();
  for (const cb of listeners) {
    try {
      cb();
    } catch {
      /* a listener must never break the log */
    }
  }
}

export function logOfflineEvent(entry: Omit<OfflineEvent, "at">, now: number = Date.now()): void {
  ring.push({ ...entry, at: now });
  if (ring.length > RING_MAX) ring.splice(0, ring.length - RING_MAX);
  changed();
}

/** Newest first. The same array until the next event, never a fresh copy. */
export function getOfflineEvents(): readonly OfflineEvent[] {
  return snapshot;
}

export function subscribeOfflineEvents(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/** For tests and for a "clear" control if one is ever wanted. */
export function clearOfflineEvents(): void {
  ring.length = 0;
  changed();
}

export interface OfflineSummary {
  timeouts: number;
  savedCopies: number;
  flushes: number;
  sent: number;
  savedJobs: number;
  reloads: number;
}

/** Counts by kind, for the one-line summary above the list. PURE. */
export function summarizeOfflineEvents(events: readonly OfflineEvent[]): OfflineSummary {
  const s: OfflineSummary = { timeouts: 0, savedCopies: 0, flushes: 0, sent: 0, savedJobs: 0, reloads: 0 };
  for (const e of events) {
    if (e.type === "timeout") s.timeouts += 1;
    else if (e.type === "saved-copy") s.savedCopies += 1;
    else if (e.type === "flush") {
      s.flushes += 1;
      s.sent += e.count ?? 0;
    } else if (e.type === "save-job") s.savedJobs += 1;
    else if (e.type === "reload") s.reloads += 1;
  }
  return s;
}
