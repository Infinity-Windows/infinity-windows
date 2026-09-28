import { describe, expect, it } from "vitest";
import type { ScheduleAssignment } from "../schedule/types";
import {
  assignmentChanged,
  crewmateNamesOn,
  formatUpdatedAt,
  myPublishedInWindow,
  pickTodayEntries,
} from "./today";

const NOW = new Date("2026-10-06T16:00:00Z").getTime();

function a(over: Partial<ScheduleAssignment>): ScheduleAssignment {
  return {
    id: "a",
    project_id: "p",
    kind: "install",
    delivery_id: null,
    start_date: "2026-10-06",
    end_date: "2026-10-06",
    start_time: "07:00",
    end_time: null,
    status: "published",
    color: null,
    note: null,
    created_by: null,
    published_at: "2026-10-01T12:00:00Z",
    created_at: "2026-10-01T12:00:00Z",
    updated_at: "2026-10-01T12:00:00Z",
    members: [{ profile_id: "me", role: "installer", display_name: "Me" }],
    project: null,
    ...over,
  };
}

describe("assignmentChanged (the Changed tag)", () => {
  it("is off for an assignment published and never edited", () => {
    expect(assignmentChanged(a({}), NOW)).toBe(false);
  });

  it("is on for an edit clearly after publishing, within two days", () => {
    expect(assignmentChanged(a({ updated_at: "2026-10-05T20:00:00Z" }), NOW)).toBe(true);
  });

  it("ignores the publish write itself (a few seconds after published_at)", () => {
    expect(assignmentChanged(a({ updated_at: "2026-10-01T12:00:30Z" }), NOW)).toBe(false);
  });

  it("comes off after two days — old news is not a heads-up", () => {
    expect(assignmentChanged(a({ updated_at: "2026-10-02T12:00:00Z" }), NOW)).toBe(false);
  });

  it("never tags a draft or an unpublished row", () => {
    expect(assignmentChanged(a({ status: "draft", updated_at: "2026-10-05T20:00:00Z" }), NOW)).toBe(false);
    expect(assignmentChanged(a({ published_at: null, updated_at: "2026-10-05T20:00:00Z" }), NOW)).toBe(false);
  });
});

describe("pickTodayEntries", () => {
  it("returns today's entries, earliest start first", () => {
    const rows = [a({ id: "late", start_time: "13:00" }), a({ id: "early", start_time: "06:30" }), a({ id: "draft", status: "draft" })];
    const pick = pickTodayEntries(rows, "me", "2026-10-06", "2026-10-13");
    expect(pick.day).toBe("2026-10-06");
    expect(pick.entries.map((e) => e.id)).toEqual(["early", "late"]);
  });

  it("falls to the next day with work when today is empty", () => {
    const rows = [a({ id: "wed", start_date: "2026-10-08", end_date: "2026-10-08" })];
    const pick = pickTodayEntries(rows, "me", "2026-10-06", "2026-10-13");
    expect(pick.day).toBe("2026-10-08");
    expect(pick.entries.map((e) => e.id)).toEqual(["wed"]);
  });

  it("only counts rows this person is on", () => {
    const rows = [a({ id: "theirs", members: [{ profile_id: "someone", role: "installer" }] })];
    expect(pickTodayEntries(rows, "me", "2026-10-06", "2026-10-13")).toEqual({ day: null, entries: [] });
    expect(myPublishedInWindow(rows, "me", "2026-10-06", "2026-10-13")).toEqual([]);
  });

  it("a multi-day block that started earlier still reads as today", () => {
    const rows = [a({ id: "span", start_date: "2026-10-05", end_date: "2026-10-07" })];
    expect(pickTodayEntries(rows, "me", "2026-10-06", "2026-10-13").day).toBe("2026-10-06");
  });
});

describe("formatUpdatedAt / crewmateNamesOn", () => {
  it("prints a time for today and a weekday for another day", () => {
    const today = new Date(NOW - 3600_000).toISOString();
    expect(formatUpdatedAt(today, NOW)).toMatch(/\d/);
    expect(formatUpdatedAt(today, NOW)).not.toMatch(/Mon|Tue|Wed|Thu|Fri|Sat|Sun/);
    expect(formatUpdatedAt("2026-10-01T12:00:00Z", NOW)).toMatch(/Mon|Tue|Wed|Thu|Fri|Sat|Sun/);
    expect(formatUpdatedAt("garbage", NOW)).toBe("");
  });

  it("names crewmates without the viewer", () => {
    const row = a({
      members: [
        { profile_id: "me", role: "installer", display_name: "Me" },
        { profile_id: "x", role: "foreman", display_name: "Sam" },
        { profile_id: "y", role: "installer", display_name: null },
      ],
    });
    expect(crewmateNamesOn(row, "me")).toEqual(["Sam"]);
  });
});
