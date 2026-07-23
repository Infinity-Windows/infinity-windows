// Pure double-booking detection for vehicle/trailer links. A truck tied to two
// overlapping scheduled crew blocks is a conflict. Date-aware: links without a
// date range can't be range-checked, so they're skipped (the board just can't
// warn until the migration backfills dates). Reports only — never blocks.

import { rangesOverlap } from "../schedule/dates";

/** Minimal shape the vehicle-conflict math needs. */
export interface VehicleBooking {
  vehicle_id: string;
  /** The scheduled crew block this booking belongs to (null = job-level). */
  assignment_id: string | null;
  start_date: string | null;
  end_date: string | null;
}

function hasDates(b: VehicleBooking): b is VehicleBooking & { start_date: string; end_date: string } {
  return Boolean(b.start_date) && Boolean(b.end_date);
}

/**
 * Other bookings of the SAME vehicle whose dates overlap `target`, excluding
 * the target's own assignment. Drives the "this truck is already out" heads-up.
 */
export function overlappingVehicleBookings(
  target: VehicleBooking,
  others: VehicleBooking[],
): VehicleBooking[] {
  if (!hasDates(target)) return [];
  return others.filter((o) => {
    if (o.vehicle_id !== target.vehicle_id) return false;
    if (o.assignment_id && o.assignment_id === target.assignment_id) return false;
    if (!hasDates(o)) return false;
    return rangesOverlap(target.start_date, target.end_date, o.start_date, o.end_date);
  });
}

/** True when the vehicle is committed elsewhere over the target's dates. */
export function isVehicleDoubleBooked(
  target: VehicleBooking,
  others: VehicleBooking[],
): boolean {
  return overlappingVehicleBookings(target, others).length > 0;
}
