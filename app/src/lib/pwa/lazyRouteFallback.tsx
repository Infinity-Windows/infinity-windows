// The UI half of K0.7's lazy-route deadline (see lazyRoute.tsx for the retry
// mechanics). Split into its own file, exporting only the one component
// `lazyRoute.tsx` needs, because that file's real export is `lazyRoute()` — a
// factory function, not a component — and a module that exports both a
// component and a non-component trips `react/only-export-components` (fast
// refresh can't tell which export is the hot-swappable one).

import { useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
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

function HungRouteMessage({ onRetry }: { onRetry: () => void }) {
  const t = useT();
  return (
    <div className="page" style={{ padding: 24, textAlign: "center" }}>
      <p>{t("lazyRoute.hung")}</p>
      <div style={{ display: "flex", gap: 8, justifyContent: "center", marginTop: 16 }}>
        <button type="button" className="button-like button-like--primary" onClick={onRetry}>
          {t("lazyRoute.tryAgain")}
        </button>
        <Link to="/" className="button-like">
          {t("lazyRoute.goToWork")}
        </Link>
      </div>
    </div>
  );
}

/**
 * The Suspense fallback: the skeleton, then — once `timeoutMs` has passed with
 * the import still pending — "This didn't load on this signal," Try again and
 * Go to Work. A fresh instance of this component mounts every time
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
