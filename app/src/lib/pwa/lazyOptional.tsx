// A lazily-loaded PART of a screen whose code can fail to download without
// taking the screen down with it.
//
// Crash report 8WEYC (2026-09-22): "Cannot read properties of undefined
// (reading 'default')" inside VoiceTextarea > VoiceControl > Lazy. The mic
// beside every notes field is loaded on demand, and its download failed. Two
// things then went wrong at once:
//
//   - preloadRecovery.ts swallowed Vite's `vite:preloadError` even when it was
//     not reloading, and a swallowed error makes Vite's preload helper RESOLVE
//     the import with `undefined` instead of rejecting it. The build puts each
//     `.then((m) => ({ default: m.X }))` inside that helper, so React.lazy was
//     handed `undefined` and read `.default` off it.
//   - React.lazy cannot fail softly: whatever goes wrong is thrown to the
//     nearest error boundary, and the only one is the app's root (main.tsx).
//     A mic that could not download replaced the whole app, and whatever the
//     person had typed, with the crash screen.
//
// lazyOptional() is React.lazy for the parts a screen can live without. When
// the code does not arrive, whether the import rejects or resolves to nothing,
// it renders `fallback` (nothing, by default) and the rest of the screen
// carries on. It never throws into the tree. Put it inside the same <Suspense>
// a React.lazy component would need; that is still what shows while loading.
//
// It tries again on a LATER mount, never in a loop on the same one. The
// browser remembers a failed module download for the life of the page
// (lazyRoute.tsx's header), so a retry usually fails at once without touching
// the network, and that failure raises `vite:preloadError` again. That event
// is how the page gets its one reload when nothing is at stake
// (preloadRecovery.ts), and so how the part comes back. Retries are at most one
// per LAZY_OPTIONAL_RETRY_AFTER_MS for every mount together, and none while
// the phone says it is offline: a screen of notes fields on no signal must not
// become a storm of failing downloads and reloads.
//
// Routes do not use this. They go through lazyRoute() (K0.7): a route IS the
// screen, so its failure belongs to ErrorBoundary.

import {
  lazy,
  useState,
  type ComponentProps,
  type ComponentType,
  type LazyExoticComponent,
  type ReactNode,
} from "react";

/** A later mount downloads again only once the last failure is at least this old. */
export const LAZY_OPTIONAL_RETRY_AFTER_MS = 30_000;

// ComponentType<any> for the same reason lazyRoute.tsx gives: each call site
// keeps its own component's props through the `T` the wrapper is cast to.
type AnyComponent = ComponentType<any>;

interface Attempt {
  Loaded: LazyExoticComponent<AnyComponent>;
  /** When this attempt ended without a usable module; null while pending or once loaded. */
  failedAt: number | null;
}

/** True for a module whose default export can be rendered: a function, or memo/forwardRef's object. */
function hasComponent(m: unknown): m is { default: AnyComponent } {
  if (typeof m !== "object" || m === null) return false;
  const c = (m as { default?: unknown }).default;
  return typeof c === "function" || (typeof c === "object" && c !== null);
}

/**
 * Wrap an `import()` factory as an ordinary component, like React.lazy, that
 * renders `fallback` instead of throwing when the code cannot be loaded:
 *
 *   const Mic = lazyOptional(() => import("./Mic").then((m) => ({ default: m.Mic })));
 *   // later: <Suspense fallback={null}><Mic {...props} /></Suspense>
 */
export function lazyOptional<T extends AnyComponent>(
  load: () => Promise<{ default: T }>,
  fallback: ReactNode = null,
): T {
  function Unavailable() {
    return <>{fallback}</>;
  }

  /** The attempt every new mount joins until it fails and grows old enough to retry. */
  let current: Attempt | null = null;

  function start(): Attempt {
    const attempt: Attempt = {
      failedAt: null,
      Loaded: lazy<AnyComponent>(async () => {
        try {
          const m: unknown = await load();
          if (hasComponent(m)) return m;
        } catch {
          // Nothing to add here: preloadRecovery.ts has already logged the
          // failed download and decided whether the page reloads.
        }
        attempt.failedAt = Date.now();
        return { default: Unavailable };
      }),
    };
    return attempt;
  }

  function retryDue(a: Attempt): boolean {
    if (a.failedAt === null) return false;
    if (Date.now() - a.failedAt < LAZY_OPTIONAL_RETRY_AFTER_MS) return false;
    return typeof navigator === "undefined" || navigator.onLine !== false;
  }

  function LazyOptional(props: ComponentProps<T>) {
    // Fixed when this mount starts, so no re-render can swap it: a failure
    // shows the fallback until the part mounts again. A mount React throws
    // away while it waits (Suspense discards a first render that suspends)
    // lands back here and finds the attempt that just settled, which is too
    // new to retry, so it can never spin up another download.
    const [attempt] = useState(() => {
      if (current === null || retryDue(current)) current = start();
      return current;
    });
    const { Loaded } = attempt;
    return <Loaded {...props} />;
  }

  return LazyOptional as unknown as T;
}
