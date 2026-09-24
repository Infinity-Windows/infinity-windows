// A lazily-loaded screen that cannot hang forever (K0.7).
//
// Every route in App.tsx is wrapped in `lazyRoute()` below, so its code
// downloads only once somebody actually navigates there (see App.tsx's own
// comment on why). On good signal that download is instant; on one bar in a
// conex it can sit for a very long time, and the shared Suspense fallback used
// to just keep spinning — no way to tell "slow" from "broken," and nothing to
// tap. This file gives every lazy screen the SAME 20-second deadline: past it,
// the skeleton is replaced by a sentence and two ways out (lazyRouteFallback.tsx
// has that half — split out so this file's real export, the `lazyRoute`
// FUNCTION, doesn't share a module with a component; see its header).
//
// The other half of the problem is `React.lazy` itself: it memoizes the
// `import()` call FOREVER, resolved or rejected, on the lazy descriptor object
// it hands back. A "Try again" that just re-renders the same descriptor
// replays the exact same dead promise — see preloadRecovery.ts's header for
// where that bit the crash screen. `lazyRoute()` below keeps its lazy
// descriptor in REACT STATE instead of a module-level `const`, and swaps in a
// BRAND NEW one (so a brand new `import()` call) every time "Try again" fires.
// Because that state lives on the component instance, not at module scope, it
// also resets for free whenever the component remounts.
//
// That fixes React's OWN caching, but there is a SECOND, deeper layer this
// file cannot reach: the BROWSER's module registry also remembers a genuinely
// REJECTED `import()` (a 404, an aborted request) for the life of the current
// page, so a fresh `lazy(factory)` calling that same specifier again still
// re-throws the old failure with no new network attempt — only a real reload
// gets a clean registry. That is exactly the case ErrorBoundary.tsx handles:
// when the error IT caught is a chunk-load error, ITS "Try again" reloads
// instead of just clearing state (never over unsaved work). What THIS file's
// own retry (the one on the timed-out fallback below) is for is the shallower
// case — an import that is merely SLOW or still pending, never having reached
// a hard rejection at all, where the browser has nothing cached to get in the
// way. Proved apart: e2e/lazy-route-hang.spec.ts (slow) vs.
// e2e/crash-screen.spec.ts (rejected, needs ErrorBoundary's reload).
//
// (A request that never settles at all — not even a rejection — is the one
// case NEITHER retry can force a new network attempt for: the browser's
// module map dedupes a second `import()` of the same URL against the still-
// pending first one, and there is nothing to reload into either, since
// nothing ever failed. "Try again" degrades to "keep waiting on the same
// request" there, which is honest — the escape hatch for that case is "Go to
// Work," not a retry that cannot be more true than the network actually is.)

import { lazy, Suspense, useState, type ComponentProps, type ComponentType, type ReactNode } from "react";
import { TimedFallback } from "./lazyRouteFallback";

/** The deadline every lazy route gets, unless a caller overrides it (tests only). */
export const LAZY_ROUTE_TIMEOUT_MS = 20_000;

/**
 * Test-only override, read fresh every time a lazy route starts waiting.
 * Nothing in production ever sets this, so the branch below is dead weight
 * there — harmless, same as ModelStudio's `window.__studio` debug handle.
 * Set via `page.addInitScript` (see e2e/support/badSignal.ts) so it exists
 * before the app's own first paint, which a `page.evaluate` after navigation
 * could not guarantee.
 */
function timeoutMs(): number {
  if (typeof window === "undefined") return LAZY_ROUTE_TIMEOUT_MS;
  const override = (window as unknown as { __forgeLazyRouteTimeoutMs?: unknown })
    .__forgeLazyRouteTimeoutMs;
  return typeof override === "number" && Number.isFinite(override) && override > 0
    ? override
    : LAZY_ROUTE_TIMEOUT_MS;
}

/**
 * Wrap an `import()` factory as an ordinary component with its own retry and
 * 20-second deadline built in — used exactly like `React.lazy`:
 *
 *   const Foo = lazyRoute(() => import("./pages/Foo").then((m) => ({ default: m.Foo })));
 *   // later: <Foo {...props} />
 *
 * `loadingFallback` is shown in place of the default skeleton before the
 * deadline — most routes don't need one, but a couple (the Studio, the GC
 * link page) had their own wording worth keeping.
 *
 * Typed exactly the way `React.lazy` itself is typed (`T extends
 * ComponentType<any>`, inferred from the resolved module) rather than a
 * separate `P extends object` props parameter: App.tsx's page components are
 * a mix of zero-prop and prop-taking functions, and inferring a shared `P`
 * from that mix through an extra layer sent TypeScript to `never` instead of
 * each component's real prop type. Returning `T` (cast at the one point the
 * wrapper's own signature can't spell it out) keeps every call site checked
 * against its OWN component's actual props, same as `lazy()` gave it before.
 */
export function lazyRoute<T extends ComponentType<any>>(
  factory: () => Promise<{ default: T }>,
  options: { loadingFallback?: ReactNode } = {},
): T {
  const loading = options.loadingFallback;
  function LazyRoute(props: ComponentProps<T>) {
    // The lazy descriptor lives in STATE, not a module-level const: retrying
    // calls setLoaded with a brand new lazy(factory), which is a brand new
    // import() call, unpolluted by whatever the last one resolved or rejected
    // to. (Passing a function to setState stores IT as the value, rather than
    // being read as an updater — the same trick the initializer form uses to
    // compute the first one lazily, once, on mount.)
    const [Loaded, setLoaded] = useState<T>(() => lazy(factory) as unknown as T);
    // `attempt` exists to be a Suspense `key`: changing it discards the WHOLE
    // subtree (fallback included), so a retry that is still waiting gets a
    // fresh skeleton and a fresh 20-second clock — not the "hung" message
    // reappearing instantly because the same fallback instance never unmounted.
    const [attempt, setAttempt] = useState(0);
    const retry = () => {
      setAttempt((a) => a + 1);
      setLoaded(() => lazy(factory) as unknown as T);
    };
    return (
      <Suspense
        key={attempt}
        fallback={<TimedFallback loading={loading} timeoutMs={timeoutMs()} onRetry={retry} />}
      >
        <Loaded {...props} />
      </Suspense>
    );
  }
  return LazyRoute as unknown as T;
}
