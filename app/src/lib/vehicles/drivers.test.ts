import { describe, expect, it } from "vitest";
import {
  driverDisplayName,
  driverSummary,
  insuredDrivers,
  normalizeDrivers,
  primaryDriver,
} from "./drivers";
import type { VehicleDriver } from "./types";

const profile = (relation: VehicleDriver["relation"], display: string, id = "p1"): VehicleDriver => ({
  profile_id: id,
  name: null,
  relation,
  display_name: display,
});
const typed = (relation: VehicleDriver["relation"], name: string): VehicleDriver => ({
  profile_id: null,
  name,
  relation,
});

describe("driverDisplayName", () => {
  it("prefers a profile's joined name", () => {
    expect(driverDisplayName(profile("primary", "Sam Diaz"))).toBe("Sam Diaz");
  });
  it("uses the typed name for free-text drivers", () => {
    expect(driverDisplayName(typed("insured", "Jordan"))).toBe("Jordan");
  });
  it("falls back safely when a name is missing", () => {
    expect(driverDisplayName({ profile_id: "p", name: null, relation: "primary" })).toBe(
      "Crew member",
    );
    expect(driverDisplayName({ profile_id: null, name: "  ", relation: "insured" })).toBe(
      "Driver",
    );
  });
});

describe("primary / insured split", () => {
  const drivers = [profile("primary", "Sam"), typed("insured", "Jo"), profile("insured", "Kai", "p2")];
  it("finds the primary and lists the insured", () => {
    expect(driverDisplayName(primaryDriver(drivers)!)).toBe("Sam");
    expect(insuredDrivers(drivers).map(driverDisplayName)).toEqual(["Jo", "Kai"]);
  });
  it("returns null primary when none set", () => {
    expect(primaryDriver([typed("insured", "Jo")])).toBeNull();
  });
});

describe("driverSummary", () => {
  it("summarizes primary plus extras", () => {
    expect(driverSummary([profile("primary", "Sam"), typed("insured", "Jo")])).toBe("Sam +1");
    expect(driverSummary([profile("primary", "Sam")])).toBe("Sam");
    expect(driverSummary([typed("insured", "Jo"), typed("insured", "Kai")])).toBe("Jo +1");
    expect(driverSummary([])).toBe("No driver");
  });
});

describe("normalizeDrivers", () => {
  it("drops empty rows and keeps exactly one primary", () => {
    const rows: VehicleDriver[] = [
      profile("primary", "Sam"),
      typed("primary", "Jo"), // second primary → demoted to insured
      { profile_id: null, name: "   ", relation: "insured" }, // blank → dropped
      typed("insured", "Kai"),
    ];
    const out = normalizeDrivers(rows);
    expect(out).toHaveLength(3);
    expect(out.filter((d) => d.relation === "primary")).toHaveLength(1);
    expect(out.map(driverDisplayName)).toEqual(["Sam", "Jo", "Kai"]);
  });

  it("keeps exactly one of profile_id / name", () => {
    const out = normalizeDrivers([{ profile_id: "p1", name: "ignored", relation: "primary", display_name: "Sam" }]);
    expect(out[0].profile_id).toBe("p1");
    expect(out[0].name).toBeNull();
  });
});
