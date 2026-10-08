// Deep links for turn-by-turn directions to a job address. Platform-neutral:
// the MapsChooserSheet lets the user pick Apple, Google, or Waze.

export interface DirectionsUrls {
  google: string;
  apple: string;
  waze: string;
}

export function hasCoordinates(latitude: number | null | undefined, longitude: number | null | undefined): boolean {
  return typeof latitude === "number" && typeof longitude === "number" && Number.isFinite(latitude) && Number.isFinite(longitude) && Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180;
}

export function directionsDestination(address: string | null | undefined, latitude?: number | null, longitude?: number | null): string | null {
  if (hasCoordinates(latitude, longitude)) return `${latitude},${longitude}`;
  return hasStreetAddress(address) ? address!.trim() : null;
}

export function buildDirectionsUrls(address: string, latitude?: number | null, longitude?: number | null): DirectionsUrls {
  const q = encodeURIComponent(directionsDestination(address, latitude, longitude) ?? "");
  return {
    google: `https://www.google.com/maps/dir/?api=1&destination=${q}`,
    apple: `https://maps.apple.com/?daddr=${q}&dirflg=d`,
    waze: `https://waze.com/ul?${hasCoordinates(latitude, longitude) ? "ll" : "q"}=${q}&navigate=yes`,
  };
}

/** True when a location looks like a real address (not empty or the "—" placeholder). */
export function hasStreetAddress(location: string | null | undefined): boolean {
  if (!location) return false;
  const t = location.trim();
  return t.length > 1 && t !== "—" && t !== "-";
}
