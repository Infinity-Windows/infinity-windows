import { describe, expect, it } from "vitest";
import {
  nextPublishedAfter,
  tomorrowLineParts,
  weekChips,
} from "./tomorrow";
import type { ScheduleAssignment } from "./types";

function make(over: Partial<ScheduleAssignment>): ScheduleAssignment {
  return {
    id: "a",
    project_id: "p",
    kind: "install" as const,
    delivery_id: null,
    start_date: "2026-09-09",
    end_date: "2026-09-09",
    start_time: "06:00",
    status: "published",
    color: null,
    note: null,
    created_by: null,
    published_at: null,
    created_at: "2026-09-01T00:00:00Z",
    updated_at: "2026-09-01T00:00:00Z",
    members: [{ profile_id: "me", role: "installer", display_name: "Me" }],
    project: { id: "p", job_code: "PECAN14", name: "Pecan 14", address: null },
    ...over,
  };
}

// Tuesday, so the current week's Monday is 2026-09-07.
const TODAY = "2026-09-08";

describe("nextPublishedAfter", () => {
  it("picks the first published assignment starting after today", () => {
    const rows = [
      make({ id: "later", start_date: "2026-09-11" }),
      make({ id: "soonest", start_date: "2026-09-09" }),
    ];
    expect(nextPublishedAfter(rows, TODAY)?.id).toBe("soonest");
  });

  it("skips drafts even when they start soonest", () => {
    const rows = [
      make({ id: "draft", start_date: "2026-09-09", status: "draft" }),
      make({ id: "published", start_date: "2026-09-10" }),
    ];
    expect(nextPublishedAfter(rows, TODAY)?.id).toBe("published");
  });

  it("never returns today's own assignment", () => {
    const rows = [make({ id: "today", start_date: TODAY })];
    expect(nextPublishedAfter(rows, TODAY)).toBeNull();
  });

  it("drops anything more than 7 days out", () => {
    const rows = [make({ id: "far", start_date: "2026-09-20" })];
    expect(nextPublishedAfter(rows, TODAY)).toBeNull();
  });

  it("returns null when nothing is published ahead", () => {
    expect(nextPublishedAfter([], TODAY)).toBeNull();
  });
});

describe("weekChips", () => {
  it("returns Monday through Friday of the current week", () => {
    const chips = weekChips([], TODAY);
    expect(chips.map((c) => c.dateISO)).toEqual([
      "2026-09-07",
      "2026-09-08",
      "2026-09-09",
      "2026-09-10",
      "2026-09-11",
    ]);
  });

  it("marks today", () => {
    const chips = weekChips([], TODAY);
    expect(chips.find((c) => c.isToday)?.dateISO).toBe(TODAY);
    expect(chips.filter((c) => c.isToday)).toHaveLength(1);
  });

  it("dots a day a published assignment touches, spanning multiple days", () => {
    const rows = [
      make({ start_date: "2026-09-10", end_date: "2026-09-11" }),
    ];
    const chips = weekChips(rows, TODAY);
    const byDate = new Map(chips.map((c) => [c.dateISO, c.hasWork]));
    expect(byDate.get("2026-09-09")).toBe(false);
    expect(byDate.get("2026-09-10")).toBe(true);
    expect(byDate.get("2026-09-11")).toBe(true);
  });

  it("ignores drafts", () => {
    const rows = [make({ start_date: "2026-09-09", status: "draft" })];
    expect(weekChips(rows, TODAY).every((c) => !c.hasWork)).toBe(true);
  });
});

describe("tomorrowLineParts", () => {
  it("counts the crew minus the viewer", () => {
    const a = make({
      members: [
        { profile_id: "me", role: "installer" },
        { profile_id: "mate-1", role: "installer" },
        { profile_id: "mate-2", role: "foreman" },
      ],
    });
    const parts = tomorrowLineParts(a, "me", "Truck 2", 8);
    expect(parts.othersCount).toBe(2);
    expect(parts.unitCount).toBe(8);
    expect(parts.truckLabel).toBe("Truck 2");
    expect(parts.jobLabel).toBe("Pecan 14");
    expect(parts.startTime).toBe("06:00");
    expect(parts.projectId).toBe("p");
  });

  it("falls back to the job code when the project has no name", () => {
    // The Project type says `name` is never null, but the fallback in
    // tomorrowLineParts (mirroring the same chain in MyWork's Today strip)
    // is defensive against a DB column that, in practice, can be empty —
    // hence the cast, to exercise that branch under the real type.
    const a = make({
      project: { id: "p", job_code: "PECAN14", name: null as unknown as string, address: null },
    });
    expect(tomorrowLineParts(a, "me", null, 0).jobLabel).toBe("PECAN14");
  });

  it("counts zero others alone on the assignment", () => {
    const a = make({ members: [{ profile_id: "me", role: "installer" }] });
    expect(tomorrowLineParts(a, "me", null, 0).othersCount).toBe(0);
  });
});
