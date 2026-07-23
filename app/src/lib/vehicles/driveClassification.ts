// Pure business-vs-personal classifier for detected drives. A drive only counts
// as BUSINESS mileage (the year-end write-off number) when the person driving
// was CLOCKED IN for some of that drive. Everything here is framework-free so
// the overlap math and the safety default stay unit-testable.
//
// SAFETY DEFAULT: when the driver is unknown or there's no clock-in data that
// overlaps the drive, the drive is PERSONAL/uncounted. We never count an
// uncertain drive as business — that keeps the write-off defensible.

/** A clocked-in interval in epoch milliseconds (end-exclusive). */
export interface ClockInterval {
  /** Owning driver profile id (so a matched drive can record who drove). */
  profile_id: string;
  start_ms: number;
  /** Clock-out in ms; use a far-future value for a still-open shift. */
  end_ms: number;
}

/** Minimal shift shape we need — avoids importing the Supabase-bound module. */
export interface ClockShiftLike {
  profile_id: string;
  clock_in_at: string;
  clock_out_at: string | null;
}

/** The drive window we classify (only the time bounds matter here). */
export interface DriveWindow {
  started_at: string;
  ended_at: string;
}

export interface DriveClassification {
  business: boolean;
  /** The driver profile whose clock-in matched, else null. */
  driver_id: string | null;
}

/**
 * Turn raw shifts into clock intervals. An open shift (no clock_out) is treated
 * as running until `openEndMs` (e.g. "now") so a drive during an in-progress
 * shift still classifies as business. Unparseable rows are dropped.
 */
export function shiftsToIntervals(
  shifts: ClockShiftLike[],
  openEndMs: number,
): ClockInterval[] {
  const out: ClockInterval[] = [];
  for (const s of shifts) {
    const start = Date.parse(s.clock_in_at);
    if (!Number.isFinite(start)) continue;
    const end = s.clock_out_at ? Date.parse(s.clock_out_at) : openEndMs;
    if (!Number.isFinite(end) || end <= start) continue;
    out.push({ profile_id: s.profile_id, start_ms: start, end_ms: end });
  }
  return out;
}

/** True when [aStart,aEnd) and [bStart,bEnd) share any time (partial counts). */
export function intervalsOverlap(
  aStart: number,
  aEnd: number,
  bStart: number,
  bEnd: number,
): boolean {
  return aStart < bEnd && bStart < aEnd;
}

/**
 * Classify one drive against the candidate drivers' clock intervals.
 *
 * - `driverIds` are the vehicle's plausible drivers (primary + insured profiles).
 * - A drive is BUSINESS if its [started_at, ended_at] window overlaps an active
 *   shift for ANY of those drivers; the first matching driver is recorded.
 * - No overlap, no known drivers, or an unparseable window → PERSONAL, and the
 *   driver falls back to `fallbackDriverId` (the main driver) for the record
 *   only — it stays uncounted.
 */
export function classifyDrive(
  drive: DriveWindow,
  driverIds: string[],
  intervals: ClockInterval[],
  fallbackDriverId: string | null = null,
): DriveClassification {
  const start = Date.parse(drive.started_at);
  const end = Date.parse(drive.ended_at);
  if (!Number.isFinite(start) || !Number.isFinite(end) || driverIds.length === 0) {
    return { business: false, driver_id: fallbackDriverId };
  }
  const candidates = new Set(driverIds);
  for (const id of driverIds) {
    for (const iv of intervals) {
      if (!candidates.has(iv.profile_id)) continue;
      if (iv.profile_id === id && intervalsOverlap(start, end, iv.start_ms, iv.end_ms)) {
        return { business: true, driver_id: id };
      }
    }
  }
  return { business: false, driver_id: fallbackDriverId };
}

interface BusinessTotalsInput {
  business: boolean;
  distance_miles: number;
  duration_seconds: number;
}

export interface DriveTotals {
  miles: number;
  hours: number;
}

/** Write-off totals: BUSINESS (clocked-in) drives only. */
export function businessTotals(sessions: BusinessTotalsInput[]): DriveTotals {
  return sumTotals(sessions.filter((s) => s.business));
}

/** Personal (uncounted) subtotal, shown for transparency only. */
export function personalTotals(sessions: BusinessTotalsInput[]): DriveTotals {
  return sumTotals(sessions.filter((s) => !s.business));
}

function sumTotals(sessions: BusinessTotalsInput[]): DriveTotals {
  const miles = sessions.reduce((sum, s) => sum + (s.distance_miles || 0), 0);
  const seconds = sessions.reduce((sum, s) => sum + (s.duration_seconds || 0), 0);
  return { miles: Number(miles.toFixed(2)), hours: Number((seconds / 3600).toFixed(2)) };
}
