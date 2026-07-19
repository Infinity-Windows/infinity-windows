// Deep links for turn-by-turn directions to a job address. Platform-neutral:
// the MapsChooserSheet lets the user pick Apple, Google, or Waze.

export interface DirectionsUrls {
  google: string;
  apple: string;
  waze: string;
}

export function buildDirectionsUrls(address: string): DirectionsUrls {
  const q = encodeURIComponent(address.trim());
  return {
    google: `https://www.google.com/maps/dir/?api=1&destination=${q}`,
    apple: `https://maps.apple.com/?daddr=${q}&dirflg=d`,
    waze: `https://waze.com/ul?q=${q}&navigate=yes`,
  };
}

/** True when a location looks like a real address (not empty or the "—" placeholder). */
export function hasStreetAddress(location: string | null | undefined): boolean {
  if (!location) return false;
  const t = location.trim();
  return t.length > 1 && t !== "—" && t !== "-";
}
