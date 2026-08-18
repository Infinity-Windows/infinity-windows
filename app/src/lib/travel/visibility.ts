import type { Trip } from "./types";
import { tripSortKey } from "./status";

export interface Viewer {
  profileId: string | null | undefined;
  /** True role supervisor/owner — sees ALL trips and may edit. */
  isSupervisor: boolean;
}

/** Is this trip visible to the viewer? Supervisors see all; crew see their own. */
export function canViewTrip(trip: Pick<Trip, "crew">, viewer: Viewer): boolean {
  if (viewer.isSupervisor) return true;
  if (!viewer.profileId) return false;
  return trip.crew.some((m) => m.profile_id === viewer.profileId);
}

/**
 * May the viewer OPEN this one trip? Membership AND publication.
 *
 * `canViewTrip` above answers membership only, which is not the whole rule —
 * a draft is supervisor-only until it is published. Screens that check a
 * single trip (the trip page, a schedule badge) must use this one, or they
 * leak a half-built trip's door codes and wifi passwords to assigned crew
 * weeks before it is announced (installer audit, 2026-08-17).
 */
export function canOpenTrip(
  trip: Pick<Trip, "crew" | "status">,
  viewer: Viewer,
): boolean {
  if (viewer.isSupervisor) return true;
  if (trip.status !== "published") return false;
  return canViewTrip(trip, viewer);
}

/**
 * Trips a viewer may see. Crew get only trips they're assigned to (and, in the
 * remote path, RLS already enforces this — this mirrors it for the local
 * fallback and for defence-in-depth in the UI). Also drops crew-only drafts:
 * unpublished trips are supervisor-only until published.
 */
export function visibleTrips(trips: Trip[], viewer: Viewer): Trip[] {
  return trips.filter((t) => canOpenTrip(t, viewer));
}

/** Order trips for the list: in-progress, then soonest upcoming, then recent past. */
export function sortTripsForList(trips: Trip[], todayISO: string): Trip[] {
  return [...trips].sort((a, b) =>
    tripSortKey(a.start_date, a.end_date, todayISO).localeCompare(
      tripSortKey(b.start_date, b.end_date, todayISO),
    ),
  );
}

/** Only the flights that apply to a viewer: their own + whole-crew (null). */
export function flightsForViewer<T extends { profile_id: string | null }>(
  flights: T[],
  profileId: string | null | undefined,
): T[] {
  return flights.filter((f) => f.profile_id == null || f.profile_id === profileId);
}
