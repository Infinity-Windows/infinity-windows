import { describe, expect, it } from "vitest";
import { shortageLines, takeoffStatusLine, type Takeoff } from "./takeoffs";
import type { Supply } from "./ops";

const t = (over: Partial<Takeoff>): Takeoff =>
  ({
    id: "t1",
    project_id: "job-1",
    for_profile_id: "p1",
    created_by: "p2",
    status: "requested",
    note: null,
    eta: null,
    eta_note: null,
    created_at: "",
    acknowledged_at: null,
    ready_at: null,
    picked_up_at: null,
    picked_up_by: null,
    ...over,
  }) as Takeoff;

describe("where a takeoff stands, in words", () => {
  it("a request waits on the warehouse", () => {
    expect(takeoffStatusLine(t({}))).toBe("Requested — waiting on the warehouse");
  });
  it("an answered one carries the rough when", () => {
    expect(takeoffStatusLine(t({ status: "acknowledged", eta: "today" }))).toBe(
      "In the works — later today",
    );
    expect(
      takeoffStatusLine(
        t({ status: "acknowledged", eta: "30min", eta_note: "waiting on the caulk order" }),
      ),
    ).toBe("In the works — about 30 minutes (waiting on the caulk order)");
  });
  it("picked up says where the supplies went", () => {
    expect(takeoffStatusLine(t({ status: "picked_up" }))).toContain("on the job's tab");
  });
});

describe("shortages warn, never block (standing decision)", () => {
  const caulk = { id: "s1", name: "Caulk", unit: "tube", on_hand: 8 } as Supply;
  const screws = { id: "s2", name: "Screws", unit: "box", on_hand: null } as Supply;

  it("a short line names the numbers", () => {
    expect(shortageLines([{ supply_id: "s1", qty: 12 }], [caulk, screws])).toEqual([
      "Caulk — wants 12, about 8 on hand",
    ]);
  });
  it("an uncounted supply says so instead of pretending", () => {
    expect(shortageLines([{ supply_id: "s2", qty: 2 }], [caulk, screws])).toEqual([
      "Screws — never counted, so nobody knows if 2 is there",
    ]);
  });
  it("enough is silence", () => {
    expect(shortageLines([{ supply_id: "s1", qty: 5 }], [caulk])).toEqual([]);
  });
});
