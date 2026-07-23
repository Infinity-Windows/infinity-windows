import { describe, expect, it } from "vitest";
import {
  filterBySegment,
  matchesSearch,
  matchesSegment,
  segmentCounts,
  sortVehicles,
} from "./localFilters";
import { vehicleSubtitle, vehicleTitle, usageLabel } from "./display";
import type { Vehicle } from "./types";

function veh(partial: Partial<Vehicle>): Vehicle {
  return {
    id: partial.id ?? "v",
    kind: partial.kind ?? "pickup",
    trailer_subtype: partial.trailer_subtype ?? null,
    year: partial.year ?? null,
    make: partial.make ?? null,
    model: partial.model ?? null,
    color: partial.color ?? null,
    vin: partial.vin ?? null,
    plate: partial.plate ?? null,
    odometer: partial.odometer ?? null,
    engine_hours: partial.engine_hours ?? null,
    last_service_date: partial.last_service_date ?? null,
    next_service_date: partial.next_service_date ?? null,
    status: partial.status ?? "active",
    primary_driver_id: partial.primary_driver_id ?? null,
    notes: partial.notes ?? null,
    created_by: partial.created_by ?? null,
    created_at: partial.created_at ?? "2026-01-01T00:00:00Z",
    updated_at: partial.updated_at ?? "2026-01-01T00:00:00Z",
  };
}

describe("matchesSegment / filterBySegment", () => {
  const list = [veh({ id: "a", kind: "pickup" }), veh({ id: "b", kind: "trailer" }), veh({ id: "c", kind: "car" })];
  it("matches all for the 'all' segment", () => {
    expect(matchesSegment({ kind: "trailer" }, "all")).toBe(true);
    expect(filterBySegment(list, "all")).toHaveLength(3);
  });
  it("filters to one kind", () => {
    expect(filterBySegment(list, "trailer").map((v) => v.id)).toEqual(["b"]);
    expect(matchesSegment({ kind: "car" }, "pickup")).toBe(false);
  });
});

describe("matchesSearch", () => {
  const v = veh({ year: 2021, make: "Ford", model: "F-150", plate: "ABC-1234", color: "White" });
  it("matches across fields, case-insensitively", () => {
    expect(matchesSearch(v, "ford")).toBe(true);
    expect(matchesSearch(v, "f-150")).toBe(true);
    expect(matchesSearch(v, "2021")).toBe(true);
    expect(matchesSearch(v, "abc")).toBe(true);
    expect(matchesSearch(v, "")).toBe(true);
    expect(matchesSearch(v, "tesla")).toBe(false);
  });
});

describe("sortVehicles", () => {
  it("orders active before sold, then by kind, then title", () => {
    const list = [
      veh({ id: "trailer", kind: "trailer", make: "Big Tex" }),
      veh({ id: "sold", kind: "pickup", make: "Old", status: "sold" }),
      veh({ id: "truckB", kind: "pickup", year: 2022, make: "Ford", model: "F-250" }),
      veh({ id: "truckA", kind: "pickup", year: 2020, make: "Chevy", model: "Silverado" }),
    ];
    expect(sortVehicles(list).map((v) => v.id)).toEqual(["truckA", "truckB", "trailer", "sold"]);
  });
});

describe("segmentCounts", () => {
  it("counts per kind plus a total", () => {
    const counts = segmentCounts([
      { kind: "pickup" },
      { kind: "pickup" },
      { kind: "car" },
      { kind: "trailer" },
    ]);
    expect(counts).toEqual({ all: 4, pickup: 2, car: 1, heavy_machinery: 0, trailer: 1 });
  });
});

describe("display formatting", () => {
  it("titles a vehicle and falls back to the kind label", () => {
    expect(vehicleTitle({ kind: "pickup", year: 2021, make: "Ford", model: "F-150" })).toBe(
      "2021 Ford F-150",
    );
    expect(vehicleTitle({ kind: "heavy_machinery", year: null, make: null, model: null })).toBe(
      "Machinery",
    );
  });
  it("builds a subtitle with kind, color and plate", () => {
    expect(
      vehicleSubtitle({ kind: "trailer", trailer_subtype: "flatbed", color: "Black", plate: "TR-9" }),
    ).toBe("Flatbed trailer · Black · TR-9");
  });
  it("shows miles for road vehicles, hours for machinery, nothing for trailers", () => {
    expect(usageLabel({ kind: "pickup", odometer: 84000, engine_hours: null })).toBe("84,000 mi");
    expect(usageLabel({ kind: "heavy_machinery", odometer: null, engine_hours: 1200 })).toBe(
      "1,200 hrs",
    );
    expect(usageLabel({ kind: "trailer", odometer: 999, engine_hours: null })).toBeNull();
  });
});
