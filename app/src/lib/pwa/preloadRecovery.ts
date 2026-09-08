// Recover from a chunk that no longer exists after a deploy.
//
// Every deploy renames the hashed chunks. A phone that opened the app in the
// morning and taps the map that afternoon asks for a chunk the server no
// longer has — Vite raises `vite:preloadError`, and without a handler the
// screen dies with "Failed to fetch dynamically imported module". The
// service worker's precache usually covers this, but not always: a first
// visit that never finished precaching, a browser that evicted the cache, a
// tab that outlived two deploys. This app ships ten times a day, so "usually"
// is not enough.
//
// The rule: reload once, and only once per minute, so a genuinely broken
// deploy cannot bounce the phone in a loop. Never over unsaved work — an
// installer mid-way through an opening sheet gets a sentence and keeps their
// work; the reload is theirs to choose.
//
// This handles PRODUCTION, where a failed chunk fetch raises `vite:preloadError`.
// The Vite DEV SERVER never raises that event: a rejected dynamic import (a
// React.lazy route whose module 404s) propagates straight through React into
// whatever ErrorBoundary catches it. Seen twice in full e2e runs under the dev
// server, 2026-09-07 — StudioList.tsx failed to fetch and the person got the
// crash screen instead of the one-time reload this file already knows how to
// do. `isChunkLoadError` + `recoverFromChunkLoadError` below are exported so
// ErrorBoundary.tsx can apply the exact same rule from componentDidCatch.

import { logOfflineEvent } from "../offline/telemetry";
import { pushToast } from "../toast";
import { readCachedLang } from "../i18n/cache";
import { CATALOG } from "../i18n/catalog";
import { translate } from "../i18n/translate";
import { hasUnsavedWork } from "./unsavedWork";

export const PRELOAD_RELOAD_AT_KEY = "wops-preload-reloaded-at";
/** Do not auto-reload again within this window: a loop is worse than a white screen. */
export const PRELOAD_RELOAD_LOOP_WINDOW_MS = 60_000;

export type PreloadDecision = "reload" | "notify";

/**
 * What to do about a failed chunk load. PURE.
 * - unsaved work on screen → tell the person, never reload under them;
 * - already reloaded within the window → tell the person, do not loop;
 * - otherwise → reload once.
 */
export function decidePreloadRecovery(f: {
  lastReloadAt: number | null;
  now: number;
  unsavedWork: boolean;
}): PreloadDecision {
  if (f.unsavedWork) return "notify";
  if (f.lastReloadAt !== null && Number.isFinite(f.lastReloadAt) && f.now - f.lastReloadAt < PRELOAD_RELOAD_LOOP_WINDOW_MS) {
    return "notify";
  }
  return "reload";
}

/**
 * Messages browsers and bundlers raise for a failed dynamic `import()`. This
 * is the SAME failure `vite:preloadError` reports in production; in dev
 * there is no Vite wrapper, so it has to be recognized by text instead. Kept
 * in one place, case-insensitive, so the production and dev paths cannot
 * quietly drift apart:
 *   - "Failed to fetch dynamically imported module" — Chrome / Edge
 *   - "error loading dynamically imported module" — Chrome / Edge, older wording
 *   - "Importing a module script failed" — Firefox
 *   - "Loading chunk" — webpack (kept in case a page still ships one)
 *   - "ChunkLoadError" — webpack's Error.name for the above
 */
const CHUNK_LOAD_ERROR_PATTERNS: RegExp[] = [
  /failed to fetch dynamically imported module/i,
  /error loading dynamically imported module/i,
  /importing a module script failed/i,
  /loading chunk/i,
  /chunkloaderror/i,
];

/**
 * True for a thrown value that is a browser/bundler dynamic-import failure.
 * PURE. Only real `Error`s match — React always wraps a caught render throw
 * in one, so a bare string or plain object here is something else entirely,
 * not a chunk load wearing a different shape.
 */
export function isChunkLoadError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const text = `${err.name} ${err.message}`;
  return CHUNK_LOAD_ERROR_PATTERNS.some((re) => re.test(text));
}

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface PreloadRecoveryDeps {
  target: { addEventListener(type: string, cb: (e: Event) => void): void; removeEventListener(type: string, cb: (e: Event) => void): void };
  storage: StorageLike | null;
  reload: () => void;
  now: () => number;
  unsavedWork: () => boolean;
  notify: (message: string) => void;
  log: (message: string) => void;
}

function defaultStorage(): StorageLike | null {
  try {
    return typeof sessionStorage === "undefined" ? null : sessionStorage;
  } catch {
    return null;
  }
}

function readLast(storage: StorageLike | null): number | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(PRELOAD_RELOAD_AT_KEY);
    if (!raw) return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

function sentence(): string {
  const lang = readCachedLang() ?? "en";
  return translate(CATALOG, lang, "pwa.staleChunk");
}

/** The subset of PreloadRecoveryDeps the decision-and-act step actually needs. */
type ActDeps = Omit<PreloadRecoveryDeps, "target">;

function resolveActDeps(over: Partial<PreloadRecoveryDeps> = {}): ActDeps {
  return {
    storage: over.storage === undefined ? defaultStorage() : over.storage,
    reload: over.reload ?? (() => window.location.reload()),
    now: over.now ?? Date.now,
    unsavedWork: over.unsavedWork ?? hasUnsavedWork,
    notify: over.notify ?? ((m) => pushToast(m, "info")),
    log: over.log ?? ((m) => logOfflineEvent({ type: "reload", scope: "stale-chunk", message: m })),
  };
}

/**
 * Decide what to do about a failed chunk load, and do it: reload once, or
 * tell the person (see `decidePreloadRecovery` for the rule). This is the
 * `vite:preloadError` handler's own body, factored out so a caller who
 * catches the same failure a different way — ErrorBoundary.componentDidCatch
 * in dev, where `vite:preloadError` never fires — can invoke it directly.
 * Same injectable deps as `installPreloadRecovery`, same defaults.
 */
export function recoverFromChunkLoadError(deps: Partial<PreloadRecoveryDeps> = {}): PreloadDecision {
  const d = resolveActDeps(deps);
  const now = d.now();
  const decision = decidePreloadRecovery({
    lastReloadAt: readLast(d.storage),
    now,
    unsavedWork: d.unsavedWork(),
  });
  if (decision === "reload") {
    try {
      d.storage?.setItem(PRELOAD_RELOAD_AT_KEY, String(now));
    } catch {
      /* no storage: the window guard is best effort */
    }
    d.log("reloaded once for a stale chunk");
    d.reload();
    return decision;
  }
  d.log("stale chunk; asked the person to refresh");
  d.notify(sentence());
  return decision;
}

/**
 * Listen for Vite's preload error and act on the decision above. Returns the
 * uninstall function. Call once from main.tsx; everything is injectable for
 * the test.
 */
export function installPreloadRecovery(over: Partial<PreloadRecoveryDeps> = {}): () => void {
  if (typeof window === "undefined" && !over.target) return () => undefined;
  const target = over.target ?? window;
  const handler = (e: Event) => {
    // Vite would otherwise throw the error into the component that asked for
    // the chunk. Whatever we decide, the person should not see a white screen.
    e.preventDefault();
    recoverFromChunkLoadError(over);
  };
  target.addEventListener("vite:preloadError", handler);
  return () => target.removeEventListener("vite:preloadError", handler);
}
