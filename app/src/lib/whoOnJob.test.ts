import { describe, expect, it } from "vitest";
import { mergeJobPeople } from "./whoOnJob";

describe("mergeJobPeople", () => {
  it("dedupes one person across all three sources and unions their sources", () => {
    const people = mergeJobPeople({
      scheduleMembers: [{ profile_id: "p1", display_name: "Ana", role: "foreman" }],
      openingAssignees: [{ id: "p1", display_name: "Ana", role: "foreman" }],
      rosterMembers: [
        { id: "p1", display_name: "Ana", role: "foreman", assigned: true },
      ],
    });
    expect(people).toHaveLength(1);
    expect(people[0]).toEqual({
      id: "p1",
      name: "Ana",
      role: "foreman",
      sources: ["schedule", "dispatch", "chat"],
    });
  });

  it("keeps distinct people and sorts by name", () => {
    const people = mergeJobPeople({
      scheduleMembers: [{ profile_id: "p2", display_name: "Zed", role: "installer" }],
      openingAssignees: [{ id: "p1", display_name: "Ana", role: "installer" }],
      rosterMembers: [],
    });
    expect(people.map((p) => p.name)).toEqual(["Ana", "Zed"]);
    expect(people.map((p) => p.sources)).toEqual([["dispatch"], ["schedule"]]);
  });

  it("excludes view-any supervisors (roster members not assigned to the job)", () => {
    const people = mergeJobPeople({
      scheduleMembers: [],
      openingAssignees: [],
      rosterMembers: [
        { id: "boss", display_name: "Owner", role: "owner", assigned: false },
        { id: "crew", display_name: "Crew A", role: "installer", assigned: true },
      ],
    });
    expect(people.map((p) => p.id)).toEqual(["crew"]);
  });

  it("fills a blank name/role from a later source", () => {
    const people = mergeJobPeople({
      scheduleMembers: [{ profile_id: "p1", display_name: null, role: null }],
      openingAssignees: [{ id: "p1", display_name: "Ana", role: "installer" }],
      rosterMembers: [],
    });
    expect(people[0].name).toBe("Ana");
    expect(people[0].role).toBe("installer");
  });

  it("falls back to a friendly name when none is known", () => {
    const people = mergeJobPeople({
      scheduleMembers: [{ profile_id: "p1", display_name: null }],
      openingAssignees: [],
      rosterMembers: [],
    });
    expect(people[0].name).toBe("Crew");
  });
});
