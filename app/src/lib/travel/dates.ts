// Pure, timezone-correct helpers for the travel pack. Flight/lodging times are
// stored as UTC instants (ISO strings) plus an IANA zone per airport; these
// helpers render each instant in the RIGHT local zone (with its abbreviation,
// e.g. "6:15 AM MDT") and derive the "arrive at airport by" / "leave by" times.
//
// Everything is a pure function of its inputs (no Date.now, no DOM), so the
// arithmetic and the DST-correct rendering are directly unit-testable.

const MIN_MS = 60 * 1000;

/** Default airport buffer: 120 min domestic, 180 min international. */
export function defaultMinutesBeforeDeparture(isInternational: boolean): number {
  return isInternational ? 180 : 120;
}

/** Shift a UTC instant by a number of minutes. Null-safe. */
function shiftISO(iso: string | null | undefined, minutes: number): string | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return null;
  return new Date(ms - minutes * MIN_MS).toISOString();
}

/**
 * "Be at the airport by" instant = departure − minutesBefore. Returns the UTC
 * instant; render it with `formatTimeWithZone(…, depart_timezone)`.
 */
export function arriveByISO(
  departAtISO: string | null | undefined,
  minutesBefore: number,
): string | null {
  return shiftISO(departAtISO, Math.max(0, minutesBefore));
}

/**
 * "Leave by" instant = arrive-by − driveMinutesToAirport. Needs both a
 * departure time and a drive estimate; returns null otherwise. Computed on the
 * absolute instant, so it's rendered correctly in the departure airport's zone.
 */
export function leaveByISO(
  departAtISO: string | null | undefined,
  minutesBefore: number,
  driveMinutesToAirport: number | null | undefined,
): string | null {
  if (driveMinutesToAirport == null) return null;
  return shiftISO(departAtISO, Math.max(0, minutesBefore) + Math.max(0, driveMinutesToAirport));
}

/** Milliseconds from `nowMs` until `iso` (negative once it's passed). Null-safe. */
export function msUntil(iso: string | null | undefined, nowMs: number): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms - nowMs;
}

function safeZone(tz: string | null | undefined): string {
  return tz && tz.trim() ? tz.trim() : "UTC";
}

/** Deterministic (en-US) formatter that never throws on a bad zone. */
function fmt(
  iso: string | null | undefined,
  tz: string | null | undefined,
  opts: Intl.DateTimeFormatOptions,
): string | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return null;
  const zone = safeZone(tz);
  try {
    return new Intl.DateTimeFormat("en-US", { ...opts, timeZone: zone }).format(ms);
  } catch {
    return new Intl.DateTimeFormat("en-US", { ...opts, timeZone: "UTC" }).format(ms);
  }
}

/** "6:15 AM MDT" — local time in the airport's zone with the zone abbreviation. */
export function formatTimeWithZone(
  iso: string | null | undefined,
  tz: string | null | undefined,
): string | null {
  return fmt(iso, tz, {
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });
}

/** "6:15 AM" — local time in the zone, no zone label. */
export function formatTimeInZone(
  iso: string | null | undefined,
  tz: string | null | undefined,
): string | null {
  return fmt(iso, tz, { hour: "numeric", minute: "2-digit" });
}

/** "Mon, Jul 21" — local day in the zone. */
export function formatDayInZone(
  iso: string | null | undefined,
  tz: string | null | undefined,
): string | null {
  return fmt(iso, tz, { weekday: "short", month: "short", day: "numeric" });
}

/** "Mon, Jul 21 · 6:15 AM MDT" — day + time + zone for a full stamp. */
export function formatDateTimeWithZone(
  iso: string | null | undefined,
  tz: string | null | undefined,
): string | null {
  const day = formatDayInZone(iso, tz);
  const time = formatTimeWithZone(iso, tz);
  if (!day && !time) return null;
  return [day, time].filter(Boolean).join(" · ");
}

/** Just the zone abbreviation for an instant, e.g. "MST"/"MDT". */
export function zoneAbbrev(
  iso: string | null | undefined,
  tz: string | null | undefined,
): string | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return null;
  const zone = safeZone(tz);
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      timeZoneName: "short",
    }).formatToParts(ms);
    return parts.find((p) => p.type === "timeZoneName")?.value ?? null;
  } catch {
    return null;
  }
}

/** A zone's offset from UTC (ms) at a given instant (handles DST). */
function tzOffsetMs(tz: string, instant: number): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = dtf.formatToParts(instant);
  const map: Record<string, number> = {};
  for (const p of parts) if (p.type !== "literal") map[p.type] = Number(p.value);
  // Some engines render midnight as hour 24; normalize to 0.
  const hour = map.hour === 24 ? 0 : map.hour;
  const asUTC = Date.UTC(map.year, map.month - 1, map.day, hour, map.minute, map.second);
  return asUTC - instant;
}

/**
 * Convert a wall-clock time typed in a given IANA zone ("YYYY-MM-DDTHH:mm") to
 * the corresponding UTC instant ISO string. Two-pass so DST transitions resolve
 * correctly. Returns null on empty/bad input. Inverse of `utcToZonedWallTime`.
 */
export function zonedWallTimeToUtc(
  wall: string | null | undefined,
  tz: string | null | undefined,
): string | null {
  if (!wall) return null;
  const asIfUtc = Date.parse(`${wall}:00Z`);
  if (Number.isNaN(asIfUtc)) return null;
  const zone = safeZone(tz);
  let offset: number;
  try {
    offset = tzOffsetMs(zone, asIfUtc);
    const guess = asIfUtc - offset;
    const offset2 = tzOffsetMs(zone, guess);
    const utc = offset2 === offset ? guess : asIfUtc - offset2;
    return new Date(utc).toISOString();
  } catch {
    return new Date(asIfUtc).toISOString();
  }
}

/**
 * Render a UTC instant as a "YYYY-MM-DDTHH:mm" wall string in the given zone,
 * suitable for a <input type="datetime-local"> value. Inverse of
 * `zonedWallTimeToUtc`. Empty string when there's nothing to show.
 */
export function utcToZonedWallTime(
  utcISO: string | null | undefined,
  tz: string | null | undefined,
): string {
  if (!utcISO) return "";
  const ms = Date.parse(utcISO);
  if (Number.isNaN(ms)) return "";
  const zone = safeZone(tz);
  try {
    const dtf = new Intl.DateTimeFormat("en-CA", {
      timeZone: zone,
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
    const parts = dtf.formatToParts(ms);
    const map: Record<string, string> = {};
    for (const p of parts) if (p.type !== "literal") map[p.type] = p.value;
    const hour = map.hour === "24" ? "00" : map.hour;
    return `${map.year}-${map.month}-${map.day}T${hour}:${map.minute}`;
  } catch {
    return "";
  }
}

/**
 * Friendly countdown for a "next up" instant: "now", "in 25 min", "in 3 hr",
 * "in 2 days", or null once it's in the past. Pure (takes nowMs).
 */
export function humanizeCountdown(
  iso: string | null | undefined,
  nowMs: number,
): string | null {
  const delta = msUntil(iso, nowMs);
  if (delta == null || delta < 0) return null;
  const mins = Math.round(delta / MIN_MS);
  if (mins <= 1) return "now";
  if (mins < 60) return `in ${mins} min`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `in ${hrs} hr`;
  const days = Math.round(hrs / 24);
  return `in ${days} day${days === 1 ? "" : "s"}`;
}
