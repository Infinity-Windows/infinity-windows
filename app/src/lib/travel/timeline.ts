import type { Flight, GroundTransport, Lodging, TripDetail } from "./types";
import { arriveByISO, leaveByISO } from "./dates";
import { flightsForViewer } from "./visibility";
import { CATALOG } from "../i18n/catalog";
import { translate, type Lang } from "../i18n/translate";
import type { TFn } from "../i18n/context";

const englishT: TFn = (key, vars) => translate(CATALOG, "en" as Lang, key, vars);

export type TimelineKind =
  | "leave_by"
  | "airport_by"
  | "flight_depart"
  | "flight_arrive"
  | "ground_pickup"
  | "ground_dropoff"
  | "lodging_checkin"
  | "lodging_checkout";

/** An action a timeline item / next-up banner can offer. */
export type TimelineAction =
  | { type: "directions"; address: string }
  | { type: "copy"; label: string; value: string }
  | { type: "call"; phone: string };

export interface TimelineItem {
  id: string;
  kind: TimelineKind;
  /** UTC instant this item happens at. */
  at: string;
  /** IANA zone for rendering `at` in the right local time. */
  timezone: string | null;
  title: string;
  subtitle: string | null;
  action: TimelineAction | null;
  /** True if this item exposes a sensitive code (hidden once a trip is past). */
  sensitive: boolean;
}

function flightLabel(f: Flight, t: TFn): string {
  const parts = [f.airline, f.flight_number].filter(Boolean).join(" ");
  const route = [f.depart_airport, f.arrive_airport].filter(Boolean).join(" → ");
  return [parts, route].filter(Boolean).join(" · ") || t("travelTimeline.flightFallback");
}

function flightItems(f: Flight, t: TFn): TimelineItem[] {
  const out: TimelineItem[] = [];
  const label = flightLabel(f, t);

  // "Leave by" wins when we can compute it (needs a drive estimate); otherwise
  // fall back to the "be at the airport by" instant.
  const leaveBy = leaveByISO(f.depart_at, f.minutes_before_departure, f.drive_minutes_to_airport);
  const airportBy = arriveByISO(f.depart_at, f.minutes_before_departure);
  const dirAction: TimelineAction | null = f.depart_airport
    ? { type: "directions", address: f.depart_airport }
    : null;

  if (leaveBy) {
    out.push({
      id: `flight-${f.id}-leaveby`,
      kind: "leave_by",
      at: leaveBy,
      timezone: f.depart_timezone,
      title: t("travelTimeline.leaveForAirport"),
      subtitle: t("travelTimeline.forLabel", { label }),
      action: dirAction,
      sensitive: false,
    });
  } else if (airportBy) {
    out.push({
      id: `flight-${f.id}-airportby`,
      kind: "airport_by",
      at: airportBy,
      timezone: f.depart_timezone,
      title: t("travelTimeline.beAtAirport"),
      subtitle: t("travelTimeline.forLabel", { label }),
      action: dirAction,
      sensitive: false,
    });
  }

  if (f.depart_at) {
    out.push({
      id: `flight-${f.id}-depart`,
      kind: "flight_depart",
      at: f.depart_at,
      timezone: f.depart_timezone,
      title: t("travelTimeline.departs", { place: f.depart_airport ?? "" }).trim(),
      subtitle: label,
      action: null,
      sensitive: false,
    });
  }
  if (f.arrive_at) {
    out.push({
      id: `flight-${f.id}-arrive`,
      kind: "flight_arrive",
      at: f.arrive_at,
      timezone: f.arrive_timezone,
      title: t("travelTimeline.arrives", { place: f.arrive_airport ?? "" }).trim(),
      subtitle: label,
      action: null,
      sensitive: false,
    });
  }
  return out;
}

function groundItems(g: GroundTransport, t: TFn): TimelineItem[] {
  const out: TimelineItem[] = [];
  const label = [g.type, g.provider].filter(Boolean).join(" · ") || t("travelTimeline.groundFallback");
  if (g.pickup_at) {
    out.push({
      id: `ground-${g.id}-pickup`,
      kind: "ground_pickup",
      at: g.pickup_at,
      timezone: g.pickup_timezone,
      title: g.pickup_location
        ? t("travelTimeline.pickupAt", { place: g.pickup_location })
        : t("travelTimeline.pickup"),
      subtitle: label,
      action: g.pickup_location ? { type: "directions", address: g.pickup_location } : null,
      sensitive: false,
    });
  }
  if (g.dropoff_at) {
    out.push({
      id: `ground-${g.id}-dropoff`,
      kind: "ground_dropoff",
      at: g.dropoff_at,
      timezone: g.dropoff_timezone,
      title: g.dropoff_location
        ? t("travelTimeline.dropoffAt", { place: g.dropoff_location })
        : t("travelTimeline.dropoff"),
      subtitle: label,
      action: g.dropoff_location ? { type: "directions", address: g.dropoff_location } : null,
      sensitive: false,
    });
  }
  return out;
}

function lodgingItems(l: Lodging, codesVisible: boolean, t: TFn): TimelineItem[] {
  const out: TimelineItem[] = [];
  const name = l.name ?? t("travelTimeline.lodgingFallback");
  if (l.check_in_at) {
    const hasCode = codesVisible && Boolean(l.door_code);
    out.push({
      id: `lodging-${l.id}-checkin`,
      kind: "lodging_checkin",
      at: l.check_in_at,
      timezone: l.timezone,
      title: t("travelTimeline.checkIn", { name }),
      subtitle: hasCode ? t("travelTimeline.doorCodeReady") : l.address,
      action: hasCode
        ? { type: "copy", label: t("travelTimeline.doorCode"), value: l.door_code as string }
        : l.address
          ? { type: "directions", address: l.address }
          : null,
      sensitive: hasCode,
    });
  }
  if (l.check_out_at) {
    out.push({
      id: `lodging-${l.id}-checkout`,
      kind: "lodging_checkout",
      at: l.check_out_at,
      timezone: l.timezone,
      title: t("travelTimeline.checkOut", { name }),
      subtitle: l.checkout_tasks ?? null,
      action: null,
      sensitive: false,
    });
  }
  return out;
}

export interface TimelineOptions {
  profileId?: string | null;
  /** Whether sensitive codes may be attached as actions (see areCodesVisible). */
  codesVisible: boolean;
}

/**
 * Build the trip's chronological timeline (depart → arrive → ground → check-in
 * → checkout → return), filtered to the viewer's flights (their own + whole
 * crew). Items with no time are dropped; the rest are sorted by instant.
 */
export function buildTimeline(
  detail: TripDetail,
  opts: TimelineOptions,
  t: TFn = englishT,
): TimelineItem[] {
  const items: TimelineItem[] = [];
  const flights = flightsForViewer(detail.flights, opts.profileId);
  for (const f of flights) items.push(...flightItems(f, t));
  for (const g of detail.ground) items.push(...groundItems(g, t));
  for (const l of detail.lodging) items.push(...lodgingItems(l, opts.codesVisible, t));
  return items.sort((a, b) => a.at.localeCompare(b.at));
}

/**
 * The "next up" item for the above-the-fold banner: the soonest item at or
 * after `nowMs`. When everything is in the past (or there's nothing), returns
 * null so the caller can hide the banner.
 */
export function selectNextUp(
  items: TimelineItem[],
  nowMs: number,
): TimelineItem | null {
  let best: TimelineItem | null = null;
  let bestMs = Infinity;
  for (const it of items) {
    const ms = Date.parse(it.at);
    if (Number.isNaN(ms)) continue;
    if (ms >= nowMs && ms < bestMs) {
      best = it;
      bestMs = ms;
    }
  }
  return best;
}
