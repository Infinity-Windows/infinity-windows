import { describe, expect, it } from "vitest";
import {
  isVehicleDoubleBooked,
  overlappingVehicleBookings,
  type VehicleBooking,
} from "./scheduleConflicts";

function book(partial: Partial<VehicleBooking>): VehicleBooking {
  return {
    vehicle_id: partial.vehicle_id ?? "truck-1",
    assignment_id: partial.assignment_id ?? null,
    start_date: partial.start_date ?? null,
    end_date: partial.end_date ?? null,
  };
}

describe("overlappingVehicleBookings", () => {
  it("flags the same truck on overlapping dates", () => {
    const target = book({ assignment_id: "a", start_date: "2026-08-03", end_date: "2026-08-05" });
    const others = [book({ assignment_id: "b", start_date: "2026-08-04", end_date: "2026-08-06" })];
    expect(overlappingVehicleBookings(target, others)).toHaveLength(1);
    expect(isVehicleDoubleBooked(target, others)).toBe(true);
  });

  it("ignores a different vehicle", () => {
    const target = book({ assignment_id: "a", start_date: "2026-08-03", end_date: "2026-08-05" });
    const others = [
      book({ vehicle_id: "truck-2", assignment_id: "b", start_date: "2026-08-04", end_date: "2026-08-06" }),
    ];
    expect(overlappingVehicleBookings(target, others)).toHaveLength(0);
  });

  it("ignores the target's own assignment", () => {
    const target = book({ assignment_id: "a", start_date: "2026-08-03", end_date: "2026-08-05" });
    const others = [book({ assignment_id: "a", start_date: "2026-08-03", end_date: "2026-08-05" })];
    expect(isVehicleDoubleBooked(target, others)).toBe(false);
  });

  it("does not flag non-overlapping dates", () => {
    const target = book({ assignment_id: "a", start_date: "2026-08-03", end_date: "2026-08-05" });
    const others = [book({ assignment_id: "b", start_date: "2026-08-06", end_date: "2026-08-08" })];
    expect(isVehicleDoubleBooked(target, others)).toBe(false);
  });

  it("skips links without dates (can't detect pre-backfill)", () => {
    const target = book({ assignment_id: "a", start_date: "2026-08-03", end_date: "2026-08-05" });
    const others = [book({ assignment_id: "b" })];
    expect(isVehicleDoubleBooked(target, others)).toBe(false);
    const undated = book({ assignment_id: "a" });
    expect(isVehicleDoubleBooked(undated, others)).toBe(false);
  });
});
