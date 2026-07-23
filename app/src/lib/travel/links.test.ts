import { describe, expect, it } from "vitest";
import type { TripDetail } from "./types";
import { directionsTargets, telHref } from "./links";

const base: TripDetail = {
  trip: {
    id: "t1",
    project_id: "p1",
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
    crew: [],
    project: { id: "p1", job_code: "J1", name: "Job", address: "456 Job Rd" },
  },
  flights: [],
  lodging: [],
  ground: [],
  procedures: [],
  contacts: [],
  attachments: [],
};

describe("directionsTargets", () => {
  it("collects lodging, jobsite, and airports as directions targets", () => {
    const targets = directionsTargets({
      ...base,
      lodging: [{ ...emptyLodging, id: "l1", name: "Cedar House", address: "123 Main St" }],
      flights: [{ ...emptyFlight, id: "f1", depart_airport: "Denver Intl Airport" }],
    });
    expect(targets.map((t) => t.address)).toEqual([
      "123 Main St",
      "456 Job Rd",
      "Denver Intl Airport",
    ]);
  });

  it("dedupes repeated addresses and drops empty/placeholder ones", () => {
    const targets = directionsTargets({
      ...base,
      lodging: [{ ...emptyLodging, id: "l1", name: "A", address: "Same Place" }],
      flights: [
        { ...emptyFlight, id: "f1", depart_airport: "Same Place" },
        { ...emptyFlight, id: "f2", depart_airport: "—" },
      ],
    });
    expect(targets.map((t) => t.address)).toEqual(["Same Place", "456 Job Rd"]);
  });
});

describe("telHref", () => {
  it("builds a tel: href from a formatted number", () => {
    expect(telHref("(555) 123-4567")).toBe("tel:5551234567");
    expect(telHref("+1 555-123-4567")).toBe("tel:+15551234567");
  });
  it("returns null for junk or missing numbers", () => {
    expect(telHref("123")).toBeNull();
    expect(telHref(null)).toBeNull();
    expect(telHref("")).toBeNull();
  });
});

const emptyFlight = {
  trip_id: "t1",
  profile_id: null,
  airline: null,
  flight_number: null,
  confirmation_code: null,
  depart_airport: null,
  arrive_airport: null,
  depart_at: null,
  arrive_at: null,
  depart_timezone: null,
  arrive_timezone: null,
  minutes_before_departure: 120,
  drive_minutes_to_airport: null,
  seat: null,
  notes: null,
  sort_order: 0,
};

const emptyLodging = {
  trip_id: "t1",
  name: null,
  address: null,
  timezone: null,
  wifi_ssid: null,
  wifi_password: null,
  door_code: null,
  entry_steps: null,
  backup_entry: null,
  host_name: null,
  host_phone: null,
  check_in_at: null,
  check_out_at: null,
  nights: null,
  bedrooms: null,
  beds: null,
  baths: null,
  washer_dryer: null,
  kitchen: null,
  parking: null,
  quiet_hours: null,
  checkout_tasks: null,
  notes: null,
  sort_order: 0,
};
