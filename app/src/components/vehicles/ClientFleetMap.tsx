import { Suspense, lazy, useEffect, useState } from "react";
import type { MapPoint } from "./FleetLeafletMap";

// Leaflet must render CLIENT-ONLY: it reads window/document at import time and
// would break an SSR/prerender pass or the react-query dehydration. We (1) only
// import the Leaflet module in the browser via React.lazy, and (2) gate it
// behind a `mounted` effect flag so the map chunk never loads until we're truly
// in the browser after hydration.
const FleetLeafletMap = lazy(() => import("./FleetLeafletMap"));

export function ClientFleetMap({ points, height = 420 }: { points: MapPoint[]; height?: number }) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  if (!mounted || typeof window === "undefined") {
    return <div className="veh-map-placeholder" style={{ height }} aria-hidden />;
  }

  return (
    <Suspense fallback={<div className="veh-map-placeholder" style={{ height }} aria-hidden />}>
      <FleetLeafletMap points={points} height={height} />
    </Suspense>
  );
}

export type { MapPoint };
