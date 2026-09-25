import { Suspense, useEffect, useState } from "react";
import type { MapPoint } from "./FleetLeafletMap";
import { lazyOptional } from "../../lib/pwa/lazyOptional";
import { PartDidNotLoad } from "../../lib/pwa/lazyOptionalFallback";

// Leaflet must render CLIENT-ONLY: it reads window/document at import time and
// would break an SSR/prerender pass or the react-query dehydration. We (1) only
// import the Leaflet module in the browser via a lazy import, and (2) gate it
// behind a `mounted` effect flag so the map chunk never loads until we're truly
// in the browser after hydration. When that download fails, the map says so in
// its own box and the page around it (a vehicle's location form) keeps working
// (lib/pwa/lazyOptional.tsx).
const FleetLeafletMap = lazyOptional(() => import("./FleetLeafletMap"), <PartDidNotLoad />);

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
