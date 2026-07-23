// Pure link/target builders for the travel pack: which addresses get a
// one-tap "Directions" chip, and how to build a tap-to-call href. Directions
// URLs themselves come from the shared mapsLinks (already unit-tested).

import { hasStreetAddress } from "../mapsLinks";
import type { TripDetail } from "./types";

export interface DirectionsTarget {
  key: string;
  label: string;
  address: string;
}

/**
 * The set of one-tap directions targets for a trip: lodging, the jobsite (the
 * linked project address), and each flight's departure airport. Only real
 * addresses are included; duplicates are collapsed.
 */
export function directionsTargets(detail: TripDetail): DirectionsTarget[] {
  const out: DirectionsTarget[] = [];
  const seen = new Set<string>();
  const add = (key: string, label: string, address: string | null | undefined) => {
    if (!hasStreetAddress(address)) return;
    const addr = (address as string).trim();
    const dedupe = addr.toLowerCase();
    if (seen.has(dedupe)) return;
    seen.add(dedupe);
    out.push({ key, label, address: addr });
  };

  for (const l of detail.lodging) add(`lodging-${l.id}`, l.name ?? "Lodging", l.address);
  add("jobsite", "Jobsite", detail.trip.project?.address ?? null);
  for (const f of detail.flights) {
    add(`airport-${f.id}`, f.depart_airport ?? "Airport", f.depart_airport);
  }
  return out;
}

/** Sanitize a phone number into a tel: href, or null when there's nothing dialable. */
export function telHref(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const cleaned = phone.replace(/[^\d+]/g, "");
  const digits = cleaned.replace(/\D/g, "");
  if (digits.length < 7) return null;
  return `tel:${cleaned}`;
}
