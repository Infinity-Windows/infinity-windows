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
// Database, auth and signed-link requests get a short deadline; photo uploads
// get two minutes so a stalled upload cannot hold the entire offline queue.
// A planset download or an
// AI answer legitimately takes longer than any sensible deadline, and
// aborting a 4 MB sheet at fifteen seconds on a bad link would be the very
// failure this exists to end.

import { logOfflineEvent } from "./telemetry";

export const WEAK_SIGNAL_WINDOW_MS = 20_000;
export const REQUEST_TIMEOUT_MS = 15_000;
export const PHOTO_UPLOAD_TIMEOUT_MS = 120_000;

/**
 * The buckets whose uploads get PHOTO_UPLOAD_TIMEOUT_MS. Every other bucket's
 * upload has no deadline here at all (issue-photos, for one), which the
 * outbox's send watchdog has to know: it may never be the tighter limit on an
 * upload that is merely slow.
 */
export const TIMED_UPLOAD_BUCKETS: readonly string[] = ["install-media", "service-media", "ai-field-memos"];

/** The deadline an upload into this bucket gets from timedFetch, or null for none. */
export function uploadTimeoutMs(bucket: string): number | null {
  return TIMED_UPLOAD_BUCKETS.includes(bucket) ? PHOTO_UPLOAD_TIMEOUT_MS : null;
}

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

/** Signed links are small JSON requests, not file downloads. One stuck link
 * used to hold the whole photo gallery's Promise.all spinner indefinitely. */
export function shouldTime(url: string): boolean {
  return url.includes("/rest/v1/") || url.includes("/auth/v1/") ||
    url.includes("/storage/v1/object/sign/");
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
  const url = urlOf(input);
  const method = (init?.method ?? (typeof Request !== "undefined" && input instanceof Request ? input.method : "GET")).toUpperCase();
  const isWrite = method === "POST" || method === "PUT";
  const fieldMemoUpload = isWrite && url.includes("/storage/v1/object/ai-field-memos/");
  const photoUpload = isWrite && TIMED_UPLOAD_BUCKETS.some((bucket) => url.includes(`/storage/v1/object/${bucket}/`));
  const d: TimedFetchDeps = {
    fetch: deps?.fetch ?? globalThis.fetch.bind(globalThis),
    timeoutMs: deps?.timeoutMs ?? (photoUpload ? PHOTO_UPLOAD_TIMEOUT_MS : REQUEST_TIMEOUT_MS),
    now: deps?.now ?? Date.now,
    onTimeout: deps?.onTimeout ?? markWeakSignal,
    onOk: deps?.onOk ?? markRequestOk,
  };
  if (!photoUpload && !shouldTime(url)) {
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
  let rejectDeadline: ((reason: Error) => void) | undefined;
  const deadline = new Promise<never>((_resolve, reject) => { rejectDeadline = reject; });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
    if (fieldMemoUpload) rejectDeadline?.(new TypeError("Request timed out: weak signal"));
  }, d.timeoutMs);
  try {
    const request = d.fetch(input, { ...init, signal: controller.signal });
    // A voice upload is saved only after its response body is complete. Weak
    // service can deliver headers then stall; preserve the original for retry.
    const complete = fieldMemoUpload ? request.then(async (res) => {
      const body = await res.arrayBuffer();
      return new Response(res.status === 204 ? null : body, { status: res.status, statusText: res.statusText, headers: res.headers });
    }) : request;
    const res = await (fieldMemoUpload ? Promise.race([complete, deadline]) : complete);
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
