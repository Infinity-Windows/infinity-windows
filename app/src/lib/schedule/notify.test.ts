import { describe, expect, it } from "vitest";
import {
  affectedByEdit,
  buildPublishDigests,
  diffMembers,
  digestMessage,
} from "./notify";

describe("diffMembers", () => {
  it("splits into added / removed / retained", () => {
    const d = diffMembers(["a", "b", "c"], ["b", "c", "d"]);
    expect(d.added).toEqual(["d"]);
    expect(d.removed).toEqual(["a"]);
    expect(d.retained.sort()).toEqual(["b", "c"]);
  });

  it("handles duplicates and empties", () => {
    const d = diffMembers(["a", "a"], []);
    expect(d.removed).toEqual(["a"]);
    expect(d.added).toEqual([]);
  });
});

describe("affectedByEdit", () => {
  it("notifies added and removed people on a member-only change", () => {
    const affected = affectedByEdit({
      membersBefore: ["a", "b"],
      membersAfter: ["b", "c"],
      scheduleChanged: false,
    });
    expect(affected.sort()).toEqual(["a", "c"]);
  });

  it("also notifies retained people when the timing moved", () => {
    const affected = affectedByEdit({
      membersBefore: ["a", "b"],
      membersAfter: ["a", "b"],
      scheduleChanged: true,
    });
    expect(affected.sort()).toEqual(["a", "b"]);
  });

  it("notifies nobody when nothing changed", () => {
    expect(
      affectedByEdit({
        membersBefore: ["a", "b"],
        membersAfter: ["a", "b"],
        scheduleChanged: false,
      }),
    ).toEqual([]);
  });
});

describe("buildPublishDigests", () => {
  it("produces one digest per person with their job set", () => {
    const digests = buildPublishDigests([
      { id: "j1", status: "draft", members: [{ profile_id: "a" }, { profile_id: "b" }] },
      { id: "j2", status: "draft", members: [{ profile_id: "a" }] },
    ]);
    const byPerson = new Map(digests.map((d) => [d.profileId, d.assignmentIds]));
    expect(byPerson.get("a")!.sort()).toEqual(["j1", "j2"]);
    expect(byPerson.get("b")).toEqual(["j1"]);
  });
});

describe("digestMessage", () => {
  it("uses singular vs plural copy", () => {
    expect(digestMessage(1).body).toMatch(/a new job/);
    expect(digestMessage(3).body).toMatch(/3 jobs/);
  });
});
