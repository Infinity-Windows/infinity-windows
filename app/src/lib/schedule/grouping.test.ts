import { describe, expect, it } from "vitest";
import {
  assignmentsForMember,
  buildAgenda,
  crewmateNames,
  unassignedProjects,
} from "./grouping";
import type { ScheduleAssignment } from "./types";

function mk(partial: Partial<ScheduleAssignment> & { id: string }): ScheduleAssignment {
  return {
    id: partial.id,
    project_id: partial.project_id ?? "proj-1",
    kind: partial.kind ?? "install",
    delivery_id: partial.delivery_id ?? null,
    start_date: partial.start_date ?? "2026-07-21",
    end_date: partial.end_date ?? "2026-07-21",
    start_time: partial.start_time ?? null,
    status: partial.status ?? "published",
    color: partial.color ?? null,
    note: partial.note ?? null,
    created_by: null,
    published_at: null,
    created_at: "2026-07-01T00:00:00Z",
    updated_at: "2026-07-01T00:00:00Z",
    members: partial.members ?? [],
    project: partial.project ?? { id: "proj-1", job_code: "J1", name: "Smith", address: null },
  };
}

describe("buildAgenda", () => {
  it("expands a multi-day assignment into one entry per day within the window", () => {
    const agenda = buildAgenda(
      [mk({ id: "a", start_date: "2026-07-20", end_date: "2026-07-22" })],
      "2026-07-21",
      "2026-07-25",
    );
    // Clipped to the window start (21st), so 21/22 only.
    expect(agenda.map((d) => d.day)).toEqual(["2026-07-21", "2026-07-22"]);
    expect(agenda[0].entries[0].isFirstDay).toBe(false); // 21st is a continuation
  });

  it("sorts entries within a day by start time then job", () => {
    const agenda = buildAgenda(
      [
        mk({ id: "late", start_time: "13:00", project: { id: "p", job_code: "ZZ", name: "Z", address: null } }),
        mk({ id: "early", start_time: "07:30", project: { id: "p", job_code: "AA", name: "A", address: null } }),
        mk({ id: "untimed", start_time: null, project: { id: "p", job_code: "BB", name: "B", address: null } }),
      ],
      "2026-07-21",
      "2026-07-21",
    );
    expect(agenda[0].entries.map((e) => e.assignment.id)).toEqual(["early", "late", "untimed"]);
  });

  it("returns days in ascending order", () => {
    const agenda = buildAgenda(
      [
        mk({ id: "b", start_date: "2026-07-24", end_date: "2026-07-24" }),
        mk({ id: "a", start_date: "2026-07-22", end_date: "2026-07-22" }),
      ],
      "2026-07-21",
      "2026-07-31",
    );
    expect(agenda.map((d) => d.day)).toEqual(["2026-07-22", "2026-07-24"]);
  });
});

describe("assignmentsForMember + crewmateNames", () => {
  const shared = mk({
    id: "a",
    members: [
      { profile_id: "me", role: "foreman", display_name: "Me" },
      { profile_id: "u1", role: "installer", display_name: "Bob" },
      { profile_id: "u2", role: "installer", display_name: "Ann" },
    ],
  });

  it("filters to assignments a person is on", () => {
    const other = mk({ id: "b", members: [{ profile_id: "u1", role: "installer" }] });
    expect(assignmentsForMember([shared, other], "me").map((a) => a.id)).toEqual(["a"]);
  });

  it("lists crewmates excluding the viewer, sorted", () => {
    expect(crewmateNames(shared, "me")).toEqual(["Ann", "Bob"]);
  });
});

describe("unassignedProjects", () => {
  it("returns projects with no upcoming assignment", () => {
    const projects = [
      { id: "p1", job_code: "J1", name: "One" },
      { id: "p2", job_code: "J2", name: "Two" },
      { id: "p3", job_code: "J3", name: "Three" },
    ];
    const assignments = [
      mk({ id: "a", project_id: "p1", end_date: "2026-07-25" }), // upcoming
      mk({ id: "b", project_id: "p2", end_date: "2026-07-10" }), // past
    ];
    const result = unassignedProjects(projects, assignments, "2026-07-21").map((p) => p.id);
    expect(result).toEqual(["p2", "p3"]);
  });
});
