// Pure location-freshness helpers. A tracker/manual ping is "live" when very
// recent, "recent" for a while after, then "stale/offline". Kept free of DOM so
// the map dot styling and "last seen" copy are unit-testable.

export type LocationStatus = "live" | "recent" | "stale" | "none";

const LIVE_MS = 2 * 60 * 1000; // < 2 min
const RECENT_MS = 30 * 60 * 1000; // < 30 min

/** Freshness bucket for a recorded_at timestamp relative to `nowMs`. */
export function locationStatus(
  recordedAt: string | null | undefined,
  nowMs: number,
): LocationStatus {
  if (!recordedAt) return "none";
  const t = Date.parse(recordedAt);
  if (Number.isNaN(t)) return "none";
  const age = nowMs - t;
  if (age < 0) return "live"; // clock skew — treat a future stamp as fresh
  if (age < LIVE_MS) return "live";
  if (age < RECENT_MS) return "recent";
  return "stale";
}

export const LOCATION_STATUS_LABELS: Record<LocationStatus, string> = {
  live: "Live",
  recent: "Recent",
  stale: "Offline",
  none: "No location",
};

/** Friendly "last seen" copy: "Just now", "5 min ago", "2 hr ago", "3 days ago". */
export function lastSeenLabel(
  recordedAt: string | null | undefined,
  nowMs: number,
): string {
  if (!recordedAt) return "No location yet";
  const t = Date.parse(recordedAt);
  if (Number.isNaN(t)) return "No location yet";
  const age = Math.max(0, nowMs - t);
  const min = Math.floor(age / 60000);
  if (min < 1) return "Just now";
  if (min < 60) return `${min} min ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} hr ago`;
  const days = Math.floor(hr / 24);
  return days === 1 ? "1 day ago" : `${days} days ago`;
}

/** Rough validity check for a manually entered latitude/longitude pair. */
export function isValidLatLng(lat: number, lng: number): boolean {
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    lat >= -90 &&
    lat <= 90 &&
    lng >= -180 &&
    lng <= 180 &&
    !(lat === 0 && lng === 0)
  );
}
