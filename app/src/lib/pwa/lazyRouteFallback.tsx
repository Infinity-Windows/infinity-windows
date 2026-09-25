// The UI half of K0.7's lazy-route deadline (see lazyRoute.tsx for the retry
// mechanics). Split into its own file, exporting only the one component
// `lazyRoute.tsx` needs, because that file's real export is `lazyRoute()` — a
// factory function, not a component — and a module that exports both a
// component and a non-component trips `react/only-export-components` (fast
// refresh can't tell which export is the hot-swappable one).

import { useEffect, useState, type ReactNode } from "react";
import { Link, useInRouterContext } from "react-router-dom";
import { useT } from "../i18n";
import { SkeletonCard } from "../../components/ui/States";

/** The neutral skeleton every lazy route shows before its deadline — a
 *  screen "coming," not a screen "broken." Same shape the old shared
 *  App.tsx `RouteFallback` used. */
function RouteSkeleton() {
  return (
    <div className="page">
      <SkeletonCard height={120} />
      <SkeletonCard height={72} />
      <SkeletonCard height={72} />
    </div>
  );
}

/**
 * The way out, which depends on where this fallback is mounted.
 *
 * Every authenticated screen sits inside BrowserRouter, so "Go to Work" is a
 * router Link to "/" — a client-side hop to a screen that ships in the entry
 * chunk and needs no download at all. But not every lazy route is inside the
 * router: App.tsx returns the GC's public page (`/gc/<token>`) BEFORE the
 * router mounts, on purpose, so a builder with no account never waits on
 * getSession(). React Router's Link throws outside a router ("Cannot
 * destructure property 'basename'"), which turned the promised recovery
 * screen into a crash on exactly the link a stranger opens from a text
 * message (Codex's review of #638). `useInRouterContext` is the documented,
 * non-throwing way to ask; with no router the control is an ordinary anchor
 * back to the SAME address — a real navigation, which is also the one thing
 * that clears the browser's module map (lazyRoute.tsx's header) — and never a
 * hop to "/", which for someone without a login is the sign-in screen.
 */
function EscapeControl() {
  const t = useT();
  const inRouter = useInRouterContext();
  if (inRouter) {
    return (
      <Link to="/" className="button-like">
        {t("lazyRoute.goToWork")}
      </Link>
    );
  }
  const here = typeof window === "undefined" ? "" : window.location.href;
  return (
    <a href={here} className="button-like">
      {t("lazyRoute.openAgain")}
    </a>
  );
}

function HungRouteMessage({ onRetry }: { onRetry: () => void }) {
  const t = useT();
  return (
    <div className="page" style={{ padding: 24, textAlign: "center" }}>
      <p>{t("lazyRoute.hung")}</p>
      <div style={{ display: "flex", gap: 8, justifyContent: "center", marginTop: 16 }}>
        <button type="button" className="button-like button-like--primary" onClick={onRetry}>
          {t("lazyRoute.tryAgain")}
        </button>
        <EscapeControl />
      </div>
    </div>
  );
}

/**
 * The Suspense fallback: the skeleton, then — once `timeoutMs` has passed with
 * the import still pending — "This didn't load on this signal," Try again and
 * a way out (Go to Work inside the router; outside it, on the public GC link,
 * an ordinary anchor that reopens the same address — see EscapeControl). A
 * fresh instance of this component mounts every time
 * `lazyRoute()`'s retry counter changes (the whole Suspense subtree remounts
 * along with it), so the clock always restarts at zero for a fresh attempt.
 */
export function TimedFallback({
  onRetry,
  loading,
  timeoutMs,
}: {
  onRetry: () => void;
  loading: ReactNode;
  timeoutMs: number;
}) {
  const [hung, setHung] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setHung(true), timeoutMs);
    return () => clearTimeout(timer);
  }, [timeoutMs]);
  return hung ? <HungRouteMessage onRetry={onRetry} /> : <>{loading ?? <RouteSkeleton />}</>;
}
