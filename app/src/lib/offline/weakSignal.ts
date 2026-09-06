// "Weak signal": the state between online and offline that phones actually
// live in.
//
// `navigator.onLine` says whether there is a network, not whether anything
// gets through it. On one bar in a conex, a request hangs for a minute and
// then fails; the app said nothing, the screen kept its spinner, and the
// installer had no way to tell "slow" from "broken". So every request to the
// database is given a deadline. One that misses it is aborted, marked here
// as weak signal for twenty seconds, and the screen falls back to whatever it
// last saved, with a line saying so. A request that succeeds clears the mark.
//
// Only the database and auth calls get a deadline. A planset download or an
// AI answer legitimately takes longer than any sensible deadline, and
// aborting a 4 MB sheet at fifteen seconds on a bad link would be the very
// failure this exists to end.

import { logOfflineEvent } from "./telemetry";

export const WEAK_SIGNAL_WINDOW_MS = 20_000;
export const REQUEST_TIMEOUT_MS = 15_000;

let lastWeakAt = 0;
let lastOkAt = 0;
const listeners = new Set<() => void>();

function emit(): void {
  for (const cb of listeners) {
    try {
      cb();
    } catch {
      /* a listener must never break a request */
    }
  }
}

/** Record that a request just timed out. */
export function markWeakSignal(now: number = Date.now()): void {
  lastWeakAt = now;
  logOfflineEvent({ type: "timeout", scope: "supabase" }, now);
  emit();
}

/** Record that a request came back fine; a recent weak mark is cleared. */
export function markRequestOk(now: number = Date.now()): void {
  lastOkAt = now;
  if (lastWeakAt) {
    lastWeakAt = 0;
    emit();
  }
}

export function isWeakSignalRecent(now: number = Date.now()): boolean {
  return lastWeakAt > 0 && now - lastWeakAt < WEAK_SIGNAL_WINDOW_MS;
}

/** Epoch ms of the last request that succeeded this session, or null. */
export function lastSuccessfulRequestAt(): number | null {
  return lastOkAt || null;
}

export function subscribeWeakSignal(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/** For tests. */
export function resetWeakSignal(): void {
  lastWeakAt = 0;
  lastOkAt = 0;
}

/** Which requests get a deadline: the database and auth, never storage or functions. PURE. */
export function shouldTime(url: string): boolean {
  return url.includes("/rest/v1/") || url.includes("/auth/v1/");
}

export interface TimedFetchDeps {
  fetch: typeof fetch;
  timeoutMs: number;
  now: () => number;
  onTimeout: (now: number) => void;
  onOk: (now: number) => void;
}

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

/**
 * fetch with a deadline for database calls. Handed to the Supabase client as
 * its fetch, so every read and write the app makes passes through here.
 *
 * On timeout the request is aborted and the rejection is a TypeError — the
 * same kind a dropped connection produces — so the client and React Query
 * treat it as the network failure it is and keep the cached data. A request
 * the caller aborted itself is not a timeout and is not marked.
 */
export async function timedFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
  deps?: Partial<TimedFetchDeps>,
): Promise<Response> {
  const d: TimedFetchDeps = {
    fetch: deps?.fetch ?? globalThis.fetch.bind(globalThis),
    timeoutMs: deps?.timeoutMs ?? REQUEST_TIMEOUT_MS,
    now: deps?.now ?? Date.now,
    onTimeout: deps?.onTimeout ?? markWeakSignal,
    onOk: deps?.onOk ?? markRequestOk,
  };
  if (!shouldTime(urlOf(input))) {
    const res = await d.fetch(input, init);
    d.onOk(d.now());
    return res;
  }

  const controller = new AbortController();
  let timedOut = false;
  const outer = init?.signal;
  if (outer) {
    if (outer.aborted) controller.abort();
    else outer.addEventListener("abort", () => controller.abort(), { once: true });
  }
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, d.timeoutMs);
  try {
    const res = await d.fetch(input, { ...init, signal: controller.signal });
    d.onOk(d.now());
    return res;
  } catch (err) {
    if (timedOut) {
      d.onTimeout(d.now());
      throw new TypeError("Request timed out: weak signal");
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
