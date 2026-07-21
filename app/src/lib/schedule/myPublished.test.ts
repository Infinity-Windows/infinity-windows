import { describe, expect, it } from "vitest";
import { filterMyPublished } from "./myPublished";
import type { ScheduleAssignment } from "./types";

function make(over: Partial<ScheduleAssignment>): ScheduleAssignment {
  return {
    id: "a",
    project_id: "p",
    start_date: "2026-01-10",
    end_date: "2026-01-12",
    start_time: null,
    status: "published",
    color: null,
    note: null,
    created_by: null,
    published_at: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    members: [{ profile_id: "me", role: "installer", display_name: "Me" }],
    project: null,
    ...over,
  };
}

const FROM = "2026-01-01";
const TO = "2026-01-31";

describe("filterMyPublished", () => {
  it("keeps published assignments the member is on within the window", () => {
    const rows = [make({ id: "keep" })];
    expect(filterMyPublished(rows, "me", FROM, TO).map((r) => r.id)).toEqual([
      "keep",
    ]);
  });

  it("drops drafts even when the member is on them", () => {
    const rows = [make({ id: "draft", status: "draft" })];
    expect(filterMyPublished(rows, "me", FROM, TO)).toEqual([]);
  });

  it("drops assignments the member is not on", () => {
    const rows = [
      make({
        id: "other",
        members: [{ profile_id: "someone-else", role: "installer" }],
      }),
    ];
    expect(filterMyPublished(rows, "me", FROM, TO)).toEqual([]);
  });

  it("drops assignments outside the window", () => {
    const rows = [
      make({ id: "before", start_date: "2025-12-01", end_date: "2025-12-05" }),
      make({ id: "after", start_date: "2026-03-01", end_date: "2026-03-05" }),
    ];
    expect(filterMyPublished(rows, "me", FROM, TO)).toEqual([]);
  });

  it("keeps the full crew list rather than collapsing to the current user", () => {
    const rows = [
      make({
        id: "crew",
        members: [
          { profile_id: "me", role: "foreman", display_name: "Me" },
          { profile_id: "mate", role: "installer", display_name: "Mate" },
        ],
      }),
    ];
    const result = filterMyPublished(rows, "me", FROM, TO);
    expect(result).toHaveLength(1);
    expect(result[0].members.map((m) => m.profile_id)).toEqual(["me", "mate"]);
  });

  it("sorts results by start date", () => {
    const rows = [
      make({ id: "later", start_date: "2026-01-20", end_date: "2026-01-21" }),
      make({ id: "earlier", start_date: "2026-01-05", end_date: "2026-01-06" }),
    ];
    expect(filterMyPublished(rows, "me", FROM, TO).map((r) => r.id)).toEqual([
      "earlier",
      "later",
    ]);
  });
});
