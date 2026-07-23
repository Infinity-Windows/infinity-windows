import type { Vehicle, VehicleSegment } from "./types";
import { vehicleTitle } from "./display";

// Pure filters/sorts shared by the list page and the localStorage fallback
// store. Separated out so the segment/search logic is unit-testable without a
// browser or Supabase.

/** Whether a vehicle belongs to a list segment ("all" matches everything). */
export function matchesSegment(vehicle: Pick<Vehicle, "kind">, segment: VehicleSegment): boolean {
  return segment === "all" || vehicle.kind === segment;
}

export function filterBySegment<T extends Pick<Vehicle, "kind">>(
  vehicles: T[],
  segment: VehicleSegment,
): T[] {
  return vehicles.filter((v) => matchesSegment(v, segment));
}

/** Free-text search across make/model/plate/vin/color/year. */
export function matchesSearch(vehicle: Vehicle, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const hay = [
    vehicle.year != null ? String(vehicle.year) : "",
    vehicle.make ?? "",
    vehicle.model ?? "",
    vehicle.plate ?? "",
    vehicle.vin ?? "",
    vehicle.color ?? "",
  ]
    .join(" ")
    .toLowerCase();
  return hay.includes(q);
}

/** Stable list order: active first, then by kind, then by display title. */
const KIND_ORDER: Record<Vehicle["kind"], number> = {
  pickup: 0,
  car: 1,
  heavy_machinery: 2,
  trailer: 3,
};

export function sortVehicles<T extends Vehicle>(vehicles: T[]): T[] {
  return [...vehicles].sort((a, b) => {
    const aSold = a.status === "sold" ? 1 : 0;
    const bSold = b.status === "sold" ? 1 : 0;
    if (aSold !== bSold) return aSold - bSold;
    if (KIND_ORDER[a.kind] !== KIND_ORDER[b.kind]) {
      return KIND_ORDER[a.kind] - KIND_ORDER[b.kind];
    }
    return vehicleTitle(a).localeCompare(vehicleTitle(b));
  });
}

/** Count of vehicles per segment for the filter chips (all + each kind). */
export function segmentCounts(vehicles: Pick<Vehicle, "kind">[]): Record<VehicleSegment, number> {
  const counts: Record<VehicleSegment, number> = {
    all: vehicles.length,
    pickup: 0,
    car: 0,
    heavy_machinery: 0,
    trailer: 0,
  };
  for (const v of vehicles) counts[v.kind] += 1;
  return counts;
}
