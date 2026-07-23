// A short, curated list of IANA timezones for the flight/lodging editors. Free
// text is still allowed (any valid IANA zone works with the date helpers); this
// just makes the common cases one tap.
export const COMMON_TIMEZONES: { id: string; label: string }[] = [
  { id: "America/New_York", label: "Eastern (New York)" },
  { id: "America/Chicago", label: "Central (Chicago)" },
  { id: "America/Denver", label: "Mountain (Denver)" },
  { id: "America/Phoenix", label: "Arizona (Phoenix, no DST)" },
  { id: "America/Los_Angeles", label: "Pacific (Los Angeles)" },
  { id: "America/Anchorage", label: "Alaska (Anchorage)" },
  { id: "Pacific/Honolulu", label: "Hawaii (Honolulu)" },
  { id: "America/Toronto", label: "Toronto" },
  { id: "America/Vancouver", label: "Vancouver" },
  { id: "America/Mexico_City", label: "Mexico City" },
  { id: "Europe/London", label: "London" },
  { id: "UTC", label: "UTC" },
];

/** The device's current IANA timezone (best-effort), for sensible defaults. */
export function guessTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "America/Denver";
  } catch {
    return "America/Denver";
  }
}
