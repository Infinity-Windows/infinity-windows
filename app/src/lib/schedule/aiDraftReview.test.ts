import { describe, expect, it } from "vitest";
import { aiDraftsForReview, draftDaysLabel, isAiDraft } from "./aiDraftReview";
import type { ScheduleAssignment } from "./types";

function make(over: Partial<ScheduleAssignment>): ScheduleAssignment {
  return {
    id: "a",
    project_id: "p",
    kind: "install",
    delivery_id: null,
    start_date: "2026-09-28",
    end_date: "2026-09-28",
    start_time: null,
    status: "draft",
    color: null,
    note: null,
    created_by: null,
    created_via: "ai",
    published_at: null,
    created_at: "2026-09-24T00:00:00Z",
    updated_at: "2026-09-24T00:00:00Z",
    members: [{ profile_id: "ana", role: "installer", display_name: "Ana" }],
    project: { id: "p", job_code: "SMITH", name: "Smith Residence", address: null },
    ...over,
  };
}

const WEEK = { from: "2026-09-28", to: "2026-10-04" };

describe("which rows the Review AI drafts card lists (K2.8)", () => {
  it("only rows the AI wrote that are still drafts — a published AI row keeps its flag but is not reviewable", () => {
    expect(isAiDraft(make({}))).toBe(true);
    expect(isAiDraft(make({ status: "published" }))).toBe(false);
    expect(isAiDraft(make({ created_via: null }))).toBe(false);
    expect(isAiDraft(make({ created_via: undefined }))).toBe(false);
  });

  it("lists the visible week's AI drafts earliest first and counts the rest, so nothing hides", () => {
    const drafts = [
      make({ id: "later", start_date: "2026-10-02", end_date: "2026-10-02" }),
      make({ id: "human", created_via: null }),
      make({ id: "next-week", start_date: "2026-10-06", end_date: "2026-10-06" }),
      make({ id: "spans-in", start_date: "2026-09-25", end_date: "2026-09-29" }),
      make({ id: "published", status: "published" }),
      make({ id: "mon", project: { id: "p2", job_code: "BLACK22", name: "Black Desert", address: null } }),
    ];
    const list = aiDraftsForReview(drafts, WEEK);
    expect(list.inRange.map((a) => a.id)).toEqual(["spans-in", "mon", "later"]);
    expect(list.outside).toBe(1);
  });

  it("leaves a draft linked to a connected plan to its plan", () => {
    const drafts = [make({ id: "planned" }), make({ id: "free" })];
    const list = aiDraftsForReview(drafts, WEEK, (id) => id === "planned");
    expect(list.inRange.map((a) => a.id)).toEqual(["free"]);
    expect(list.outside).toBe(0);
  });
});

describe("the days label", () => {
  it("reads one day or a span in the board's short style", () => {
    expect(draftDaysLabel({ start_date: "2026-09-28", end_date: "2026-09-28" })).toMatch(/Sep 28/);
    expect(draftDaysLabel({ start_date: "2026-09-28", end_date: "2026-10-01" })).toMatch(/Sep 28 – Oct 1/);
  });
});
