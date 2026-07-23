import { describe, expect, it } from "vitest";
import {
  affectedByTripEdit,
  diffCrew,
  tripChangeMessage,
  tripPublishMessage,
  tripRemovalMessage,
} from "./notify";

describe("diffCrew", () => {
  it("splits into added / removed / retained", () => {
    const d = diffCrew(["a", "b", "c"], ["b", "c", "d"]);
    expect(d.added).toEqual(["d"]);
    expect(d.removed).toEqual(["a"]);
    expect(d.retained.sort()).toEqual(["b", "c"]);
  });
});

describe("affectedByTripEdit", () => {
  it("notifies added and removed on a crew-only change", () => {
    expect(
      affectedByTripEdit({
        crewBefore: ["a", "b"],
        crewAfter: ["b", "c"],
        detailsChanged: false,
      }).sort(),
    ).toEqual(["a", "c"]);
  });

  it("also notifies retained crew when shared details changed", () => {
    expect(
      affectedByTripEdit({
        crewBefore: ["a", "b"],
        crewAfter: ["a", "b"],
        detailsChanged: true,
      }).sort(),
    ).toEqual(["a", "b"]);
  });

  it("notifies nobody when nothing changed", () => {
    expect(
      affectedByTripEdit({
        crewBefore: ["a", "b"],
        crewAfter: ["a", "b"],
        detailsChanged: false,
      }),
    ).toEqual([]);
  });
});

describe("push copy", () => {
  it("never leaks codes in bodies", () => {
    const bodies = [
      tripPublishMessage("Seattle install").body,
      tripChangeMessage("Seattle install").body,
      tripRemovalMessage().body,
    ];
    for (const body of bodies) {
      expect(body).not.toMatch(/\d{4,}/); // no 4+ digit codes
      expect(body.toLowerCase()).not.toContain("wifi");
      expect(body.toLowerCase()).not.toContain("door code");
    }
  });

  it("includes the trip name in publish/change copy", () => {
    expect(tripPublishMessage("Boise job").body).toContain("Boise job");
    expect(tripChangeMessage("Boise job").body).toContain("Boise job");
  });
});
