import { describe, expect, it } from "vitest";
import { missedUnitAudience, missedUnitPushBody } from "./missedUnit";

const crew = [
  { id: "inst", role: "installer" },
  { id: "fore-here", role: "foreman" },
  { id: "fore-elsewhere", role: "foreman" },
  { id: "sup", role: "supervisor" },
  { id: "own", role: "owner" },
];

describe("missedUnitAudience", () => {
  it("rings the leads on this job and every supervisor above them", () => {
    const out = missedUnitAudience(["inst", "fore-here"], crew, "inst");
    expect(out.sort()).toEqual(["fore-here", "own", "sup"]);
  });

  it("still rings the office when no lead is on the clock at all", () => {
    // The whole reason supervisors are a UNION and not a fallback: nothing
    // special happens here, the set is simply the backstop on its own.
    expect(missedUnitAudience([], crew, "inst").sort()).toEqual(["own", "sup"]);
  });

  it("never rings the person who just added it", () => {
    expect(missedUnitAudience(["sup"], crew, "sup")).not.toContain("sup");
  });

  it("ignores a clocked-in id nobody has a profile for", () => {
    expect(missedUnitAudience(["ghost"], crew, null).sort()).toEqual(["own", "sup"]);
  });
});

describe("missedUnitPushBody", () => {
  it("names who, what and where in one sentence", () => {
    expect(missedUnitPushBody("Sand Hollow", "Jed", "Missed 2")).toBe(
      "Jed added Missed 2 on Sand Hollow — a window or door that isn't on the plans.",
    );
  });

  it("says 'Someone' rather than leaving a gap", () => {
    expect(missedUnitPushBody("Sand Hollow", null, "Missed 1")).toContain("Someone added");
  });
});
