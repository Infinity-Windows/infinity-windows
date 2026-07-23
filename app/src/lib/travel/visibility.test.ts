import { describe, expect, it } from "vitest";
import type { Trip } from "./types";
import {
  canViewTrip,
  flightsForViewer,
  sortTripsForList,
  visibleTrips,
} from "./visibility";

function trip(over: Partial<Trip> & { id: string; crew: Trip["crew"] }): Trip {
  return {
    project_id: null,
    name: "Trip",
    destination: null,
    start_date: "2026-08-01",
    end_date: "2026-08-05",
    timezone: null,
    notes: null,
    status: "published",
    published_at: null,
    created_by: null,
    created_at: "2026-07-01T00:00:00Z",
    updated_at: "2026-07-01T00:00:00Z",
    ...over,
  };
}

describe("canViewTrip", () => {
  const t = trip({ id: "t1", crew: [{ profile_id: "u1", role: "crew" }] });
  it("lets supervisors see any trip", () => {
    expect(canViewTrip(t, { profileId: "zzz", isSupervisor: true })).toBe(true);
  });
  it("lets an assigned crew member see their trip", () => {
    expect(canViewTrip(t, { profileId: "u1", isSupervisor: false })).toBe(true);
  });
  it("hides a trip from a non-member", () => {
    expect(canViewTrip(t, { profileId: "u2", isSupervisor: false })).toBe(false);
  });
});

describe("visibleTrips", () => {
  const trips = [
    trip({ id: "a", status: "published", crew: [{ profile_id: "u1", role: "crew" }] }),
    trip({ id: "b", status: "published", crew: [{ profile_id: "u2", role: "crew" }] }),
    trip({ id: "c", status: "draft", crew: [{ profile_id: "u1", role: "crew" }] }),
  ];

  it("gives a supervisor every trip including drafts", () => {
    expect(visibleTrips(trips, { profileId: "sup", isSupervisor: true }).map((t) => t.id)).toEqual(
      ["a", "b", "c"],
    );
  });

  it("gives crew only their PUBLISHED trips", () => {
    expect(visibleTrips(trips, { profileId: "u1", isSupervisor: false }).map((t) => t.id)).toEqual([
      "a",
    ]);
  });

  it("gives an unassigned crew member nothing", () => {
    expect(visibleTrips(trips, { profileId: "u9", isSupervisor: false })).toEqual([]);
  });
});

describe("flightsForViewer", () => {
  const flights = [
    { profile_id: null },
    { profile_id: "u1" },
    { profile_id: "u2" },
  ];
  it("keeps whole-crew flights and the viewer's own", () => {
    expect(flightsForViewer(flights, "u1")).toEqual([{ profile_id: null }, { profile_id: "u1" }]);
  });
  it("supervisor with no profile still sees whole-crew flights", () => {
    expect(flightsForViewer(flights, null)).toEqual([{ profile_id: null }]);
  });
});

describe("sortTripsForList", () => {
  it("orders in-progress, then upcoming, then past", () => {
    const today = "2026-07-21";
    const list = [
      trip({ id: "past", start_date: "2026-06-01", end_date: "2026-06-05", crew: [] }),
      trip({ id: "now", start_date: "2026-07-20", end_date: "2026-07-25", crew: [] }),
      trip({ id: "soon", start_date: "2026-08-01", end_date: "2026-08-05", crew: [] }),
    ];
    expect(sortTripsForList(list, today).map((t) => t.id)).toEqual(["now", "soon", "past"]);
  });
});
