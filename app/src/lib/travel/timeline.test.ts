import { describe, expect, it } from "vitest";
import type { Flight, GroundTransport, Lodging, Trip, TripDetail } from "./types";
import { buildTimeline, selectNextUp } from "./timeline";

function flight(over: Partial<Flight> & { id: string }): Flight {
  return {
    trip_id: "t1",
    profile_id: null,
    airline: "United",
    flight_number: "UA123",
    confirmation_code: "ABC123",
    depart_airport: "DEN",
    arrive_airport: "SEA",
    depart_at: "2026-07-21T12:15:00Z",
    arrive_at: "2026-07-21T14:30:00Z",
    depart_timezone: "America/Denver",
    arrive_timezone: "America/Los_Angeles",
    minutes_before_departure: 120,
    drive_minutes_to_airport: 40,
    seat: null,
    notes: null,
    sort_order: 0,
    ...over,
  };
}

function lodging(over: Partial<Lodging> & { id: string }): Lodging {
  return {
    trip_id: "t1",
    name: "Cedar House",
    address: "123 Main St, Seattle",
    timezone: "America/Los_Angeles",
    wifi_ssid: "Cedar",
    wifi_password: "hunter2",
    door_code: "4821",
    entry_steps: null,
    backup_entry: null,
    host_name: null,
    host_phone: null,
    check_in_at: "2026-07-21T22:00:00Z",
    check_out_at: "2026-07-24T18:00:00Z",
    nights: 3,
    bedrooms: null,
    beds: null,
    baths: null,
    washer_dryer: null,
    kitchen: null,
    parking: null,
    quiet_hours: null,
    checkout_tasks: "Take out the trash",
    notes: null,
    sort_order: 0,
    ...over,
  };
}

function ground(over: Partial<GroundTransport> & { id: string }): GroundTransport {
  return {
    trip_id: "t1",
    type: "Rental car",
    provider: "Hertz",
    confirmation_code: "H99",
    pickup_location: "SEA rental center",
    pickup_at: "2026-07-21T15:00:00Z",
    pickup_timezone: "America/Los_Angeles",
    dropoff_location: null,
    dropoff_at: null,
    dropoff_timezone: null,
    notes: null,
    sort_order: 0,
    ...over,
  };
}

const trip: Trip = {
  id: "t1",
  project_id: null,
  name: "Seattle install",
  destination: "Seattle",
  start_date: "2026-07-21",
  end_date: "2026-07-24",
  timezone: "America/Los_Angeles",
  notes: null,
  status: "published",
  published_at: null,
  created_by: null,
  created_at: "2026-07-01T00:00:00Z",
  updated_at: "2026-07-01T00:00:00Z",
  crew: [{ profile_id: "u1", role: "crew" }],
};

function detail(over: Partial<TripDetail> = {}): TripDetail {
  return {
    trip,
    flights: [flight({ id: "f1" })],
    lodging: [lodging({ id: "l1" })],
    ground: [ground({ id: "g1" })],
    procedures: [],
    contacts: [],
    attachments: [],
    ...over,
  };
}

describe("buildTimeline", () => {
  it("orders items chronologically across sections", () => {
    const items = buildTimeline(detail(), { profileId: "u1", codesVisible: true });
    expect(items.map((i) => i.kind)).toEqual([
      "leave_by", // 09:35Z (12:15 − 120 − 40)
      "flight_depart", // 12:15Z
      "flight_arrive", // 14:30Z
      "ground_pickup", // 15:00Z
      "lodging_checkin", // 22:00Z
      "lodging_checkout", // 07-24 18:00Z
    ]);
  });

  it("attaches a copy action for the door code when codes are visible", () => {
    const items = buildTimeline(detail(), { profileId: "u1", codesVisible: true });
    const checkin = items.find((i) => i.kind === "lodging_checkin")!;
    expect(checkin.action).toEqual({ type: "copy", label: "Door code", value: "4821" });
    expect(checkin.sensitive).toBe(true);
  });

  it("hides the code (falls back to directions) once codes are not visible", () => {
    const items = buildTimeline(detail(), { profileId: "u1", codesVisible: false });
    const checkin = items.find((i) => i.kind === "lodging_checkin")!;
    expect(checkin.action).toEqual({ type: "directions", address: "123 Main St, Seattle" });
    expect(checkin.sensitive).toBe(false);
  });

  it("falls back to 'be at the airport by' when there's no drive estimate", () => {
    const items = buildTimeline(
      detail({ flights: [flight({ id: "f1", drive_minutes_to_airport: null })] }),
      { profileId: "u1", codesVisible: true },
    );
    expect(items[0].kind).toBe("airport_by");
    expect(items[0].at).toBe("2026-07-21T10:15:00.000Z");
  });

  it("filters flights to the viewer (own + whole-crew)", () => {
    const items = buildTimeline(
      detail({
        flights: [
          flight({ id: "mine", profile_id: "u1", depart_at: "2026-07-21T12:15:00Z" }),
          flight({ id: "theirs", profile_id: "u2", depart_at: "2026-07-21T12:15:00Z" }),
        ],
      }),
      { profileId: "u1", codesVisible: true },
    );
    expect(items.every((i) => !i.id.includes("theirs"))).toBe(true);
    expect(items.some((i) => i.id.includes("mine"))).toBe(true);
  });
});

describe("selectNextUp", () => {
  it("picks the soonest item at or after now", () => {
    const items = buildTimeline(detail(), { profileId: "u1", codesVisible: true });
    const next = selectNextUp(items, Date.parse("2026-07-21T13:00:00Z"));
    expect(next?.kind).toBe("flight_arrive");
  });

  it("returns null when everything is in the past", () => {
    const items = buildTimeline(detail(), { profileId: "u1", codesVisible: true });
    const next = selectNextUp(items, Date.parse("2026-08-01T00:00:00Z"));
    expect(next).toBeNull();
  });
});
