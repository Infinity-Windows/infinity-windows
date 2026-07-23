// Pure, framework-free drive detector. Given an ordered stream of GPS fixes for
// ONE vehicle ({lat, lng, at}), it stitches them into drive SESSIONS so we can
// bill mileage at year end. A drive OPENS when movement crosses a threshold
// (derived speed > ~5 mph OR a jump > ~50 m between fixes), accumulates distance
// via haversine, and CLOSES after the vehicle sits still for N minutes or a big
// time gap breaks the trail. No DOM/Supabase here so the thresholds, session
// open/close, gap handling and distance/duration math stay unit-testable — and
// it "just works" the moment a real tracker starts feeding fixes.

/** A single location fix in the ordered stream for a vehicle. */
export interface DriveFix {
  lat: number;
  lng: number;
  /** ISO timestamp of the fix. */
  at: string;
}

/** One detected drive: a continuous stretch of movement. */
export interface DriveSession {
  started_at: string;
  ended_at: string;
  duration_seconds: number;
  distance_miles: number;
  start_lat: number;
  start_lng: number;
  end_lat: number;
  end_lng: number;
}

export interface DriveDetectionOptions {
  /** Minimum speed (mph) between two fixes to count as moving. */
  movingSpeedMph?: number;
  /** Minimum displacement (meters) between two fixes to count as moving. */
  movingMeters?: number;
  /** Minutes stationary before an open drive is closed. */
  stationaryCloseMinutes?: number;
  /** A gap larger than this (minutes) always breaks the trail. */
  maxGapMinutes?: number;
}

const DEFAULTS: Required<DriveDetectionOptions> = {
  movingSpeedMph: 5,
  movingMeters: 50,
  stationaryCloseMinutes: 5,
  maxGapMinutes: 30,
};

const EARTH_RADIUS_METERS = 6_371_000;
const METERS_PER_MILE = 1609.344;

function toRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

/** Great-circle distance in meters between two lat/lng points (haversine). */
export function haversineMeters(
  aLat: number,
  aLng: number,
  bLat: number,
  bLng: number,
): number {
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const lat1 = toRad(aLat);
  const lat2 = toRad(bLat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function metersToMiles(meters: number): number {
  return meters / METERS_PER_MILE;
}

interface OpenDrive {
  startFix: DriveFix;
  startMs: number;
  lastFix: DriveFix;
  lastMs: number;
  meters: number;
}

function finalize(drive: OpenDrive): DriveSession {
  const durationSeconds = Math.max(0, Math.round((drive.lastMs - drive.startMs) / 1000));
  return {
    started_at: drive.startFix.at,
    ended_at: drive.lastFix.at,
    duration_seconds: durationSeconds,
    distance_miles: Number(metersToMiles(drive.meters).toFixed(4)),
    start_lat: drive.startFix.lat,
    start_lng: drive.startFix.lng,
    end_lat: drive.lastFix.lat,
    end_lng: drive.lastFix.lng,
  };
}

/**
 * Turn an ordered stream of fixes into drive sessions. Fixes are sorted by time
 * defensively. A pair of fixes counts as "moving" when the displacement clears
 * `movingMeters` OR the derived speed clears `movingSpeedMph`. Once moving, the
 * drive accumulates distance until the vehicle stays put for
 * `stationaryCloseMinutes` (or a `maxGapMinutes` gap appears), then it closes.
 */
export function detectDriveSessions(
  fixes: DriveFix[],
  options: DriveDetectionOptions = {},
): DriveSession[] {
  const opts = { ...DEFAULTS, ...options };
  const sorted = [...fixes]
    .map((f) => ({ fix: f, ms: Date.parse(f.at) }))
    .filter((f) => Number.isFinite(f.ms))
    .sort((a, b) => a.ms - b.ms);
  if (sorted.length < 2) return [];

  const closeMs = opts.stationaryCloseMinutes * 60_000;
  const gapMs = opts.maxGapMinutes * 60_000;
  const sessions: DriveSession[] = [];
  let open: OpenDrive | null = null;
  let stationarySince: number | null = null;

  for (let i = 1; i < sorted.length; i += 1) {
    const prev = sorted[i - 1];
    const cur = sorted[i];
    const dtMs = cur.ms - prev.ms;
    const meters = haversineMeters(prev.fix.lat, prev.fix.lng, cur.fix.lat, cur.fix.lng);
    const hours = dtMs / 3_600_000;
    const speedMph = hours > 0 ? metersToMiles(meters) / hours : 0;
    const moving = meters >= opts.movingMeters || speedMph >= opts.movingSpeedMph;

    if (dtMs >= gapMs) {
      if (open) {
        sessions.push(finalize(open));
        open = null;
      }
      stationarySince = null;
      // A large gap can't be trusted as travel; restart detection from `cur`.
      continue;
    }

    if (moving) {
      if (!open) {
        open = {
          startFix: prev.fix,
          startMs: prev.ms,
          lastFix: cur.fix,
          lastMs: cur.ms,
          meters,
        };
      } else {
        open.meters += meters;
        open.lastFix = cur.fix;
        open.lastMs = cur.ms;
      }
      stationarySince = null;
    } else if (open) {
      if (stationarySince == null) stationarySince = prev.ms;
      if (cur.ms - stationarySince >= closeMs) {
        sessions.push(finalize(open));
        open = null;
        stationarySince = null;
      }
    }
  }

  if (open) sessions.push(finalize(open));
  return sessions;
}

interface DriveTotalsInput {
  distance_miles: number;
  duration_seconds: number;
}

/** Total miles across a list of sessions. */
export function totalMiles(sessions: DriveTotalsInput[]): number {
  return Number(sessions.reduce((sum, s) => sum + (s.distance_miles || 0), 0).toFixed(2));
}

/** Total driving hours across a list of sessions. */
export function totalHours(sessions: DriveTotalsInput[]): number {
  return Number(
    (sessions.reduce((sum, s) => sum + (s.duration_seconds || 0), 0) / 3600).toFixed(2),
  );
}

/** Calendar year (viewer-local) a session's start falls in, or null. */
export function sessionYear(startedAt: string): number | null {
  const t = Date.parse(startedAt);
  return Number.isFinite(t) ? new Date(t).getFullYear() : null;
}

/** Keep only sessions whose start is in the given calendar year. */
export function filterSessionsByYear<T extends { started_at: string }>(
  sessions: T[],
  year: number,
): T[] {
  return sessions.filter((s) => sessionYear(s.started_at) === year);
}

/** Distinct years present in the sessions, newest first. */
export function availableYears(sessions: { started_at: string }[]): number[] {
  const years = new Set<number>();
  for (const s of sessions) {
    const y = sessionYear(s.started_at);
    if (y != null) years.add(y);
  }
  return [...years].sort((a, b) => b - a);
}
