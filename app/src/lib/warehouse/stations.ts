// The five warehouse stations (wave F — grill Q5/Q6, owner-confirmed
// 2026-08-28). "Label the different abilities that the warehouse has so
// that users are funneled through the app clicking the buttons we want to
// click" — the owner's words. Material actually moves through these five
// in order: it comes in, comes off the truck, gets put away, goes back out
// the door, and — sometimes — the paperwork needs fixing.
//
// ONE module, so the hub's station strip and every destination page's
// StationChip import the same numbers and names and can never drift apart
// from each other. Cosmetic reordering happens here, once, or not at all.

/** 1-indexed position in the flow — stable, never reused or reordered. */
export type StationNumber = 1 | 2 | 3 | 4 | 5;

export interface Station {
  number: StationNumber;
  /** Verb-first. Matches the card heading and the chip text exactly. */
  name: string;
  /** One plain line: when you're at this station (12th-grade level). */
  when: string;
  /**
   * Routes this station owns. `/warehouse#in-storage` is an anchor into a
   * section already on the hub, not a route of its own — Put away has no
   * destination the app doesn't already have.
   */
  routes: string[];
}

export const STATIONS: readonly Station[] = [
  {
    number: 1,
    name: "Coming in",
    when: "A truck is scheduled or just pulled up.",
    routes: ["/storage/log-delivery", "/storage/deliveries"],
  },
  {
    number: 2,
    name: "Off the truck",
    when: "You're unloading — scan and tag as it comes off.",
    routes: ["/storage/tag", "/storage/arrive"],
  },
  {
    number: 3,
    name: "Put away",
    when: "It's inside — give it a home.",
    routes: ["/warehouse#in-storage"],
  },
  {
    number: 4,
    name: "Out the door",
    when: "Material is leaving for a job.",
    routes: ["/storage/out"],
  },
  {
    number: 5,
    name: "Fix a mistake",
    when: "The paperwork doesn't match the truth.",
    routes: ["/warehouse/materials"],
  },
] as const;

// Named handles so a call site reads "STATION_OFF_TRUCK", not "STATIONS[1]" —
// derived from the one array above, never a second copy of the data.
export const STATION_COMING_IN = STATIONS[0];
export const STATION_OFF_TRUCK = STATIONS[1];
export const STATION_PUT_AWAY = STATIONS[2];
export const STATION_OUT_DOOR = STATIONS[3];
export const STATION_FIX_MISTAKE = STATIONS[4];

/** "①"–"⑤" — the chip's numeral, e.g. "② Off the truck". */
const CIRCLED_NUMBERS = ["①", "②", "③", "④", "⑤"] as const;

export function stationNumeral(n: StationNumber): string {
  return CIRCLED_NUMBERS[n - 1];
}

/** Every station chip taps back here — the hub, where the whole flow shows. */
export const STATION_HUB_ROUTE = "/warehouse";
