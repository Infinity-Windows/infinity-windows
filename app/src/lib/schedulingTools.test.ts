import { describe, expect, it } from "vitest";
import {
  CLEAR_AI_DRAFTS_TOOL,
  DRAFT_ASSIGNMENTS_TOOL,
  GET_SCHEDULING_PICTURE_TOOL,
  MAX_DRAFT_ENTRIES,
  parseDateRangeInput,
  parseDraftEntriesInput,
  SCHEDULING_MIN_RANK,
  SCHEDULING_REFUSAL,
  SCHEDULING_TOOLS,
  schedulingRefusal,
} from "../../../supabase/functions/_shared/schedulingTools.ts";

const PROJECT = "11111111-1111-1111-1111-111111111111";
const PROFILE = "22222222-2222-2222-2222-222222222222";

describe("schedulingRefusal (PERMISSION MIRROR — the refusal path)", () => {
  it("refuses an installer (rank 0)", () => {
    expect(schedulingRefusal(0)).toBe(SCHEDULING_REFUSAL);
  });

  it("refuses a foreman (rank 1) — the exact caller a foreman asking to plan hits", () => {
    expect(schedulingRefusal(1)).toBe(SCHEDULING_REFUSAL);
  });

  it("allows a supervisor (rank 2)", () => {
    expect(schedulingRefusal(2)).toBeNull();
  });

  it("allows an owner (rank 3)", () => {
    expect(schedulingRefusal(3)).toBeNull();
  });

  it("SCHEDULING_MIN_RANK is supervisor (2), matching role_rank()/roleRank()", () => {
    expect(SCHEDULING_MIN_RANK).toBe(2);
  });
});

describe("parseDateRangeInput", () => {
  it("accepts a plain {from, to}", () => {
    expect(parseDateRangeInput({ from: "2026-09-01", to: "2026-09-05" })).toEqual({
      from: "2026-09-01",
      to: "2026-09-05",
      projectId: null,
      formatError: null,
    });
  });

  it("carries an optional project_id when it looks like a real id", () => {
    const result = parseDateRangeInput({ from: "2026-09-01", to: "2026-09-05", project_id: PROJECT });
    expect(result.projectId).toBe(PROJECT);
  });

  it("drops a project_id that isn't a real uuid rather than passing it through", () => {
    const result = parseDateRangeInput({ from: "2026-09-01", to: "2026-09-05", project_id: "not-an-id" });
    expect(result.projectId).toBeNull();
  });

  it.each([
    [null, "null input"],
    ["a string", "a bare string"],
    [{}, "missing both dates"],
    [{ from: "2026-09-01" }, "missing to"],
    [{ from: "09/01/2026", to: "2026-09-05" }, "wrong date format"],
    [{ from: "2026-02-30", to: "2026-09-05" }, "a date that doesn't exist"],
    [{ from: "2026-09-10", to: "2026-09-05" }, "from after to"],
  ])("rejects %o (%s)", (input, _description) => {
    expect(parseDateRangeInput(input).formatError).not.toBeNull();
  });
});

describe("parseDraftEntriesInput", () => {
  it("parses well-formed entries", () => {
    const result = parseDraftEntriesInput({
      entries: [{ project_id: PROJECT, profile_id: PROFILE, date: "2026-09-01" }],
    });
    expect(result.formatError).toBeNull();
    expect(result.errors).toEqual([]);
    expect(result.entries).toEqual([{ project_id: PROJECT, profile_id: PROFILE, date: "2026-09-01" }]);
  });

  it("reports a whole-input format error for a non-array entries", () => {
    expect(parseDraftEntriesInput({ entries: "nope" }).formatError).toMatch(/array/);
  });

  it("reports a whole-input format error for an empty entries array", () => {
    expect(parseDraftEntriesInput({ entries: [] }).formatError).toMatch(/cannot be empty/);
  });

  it(`refuses more than ${MAX_DRAFT_ENTRIES} entries in one call`, () => {
    const entries = Array.from({ length: MAX_DRAFT_ENTRIES + 1 }, () => ({
      project_id: PROJECT,
      profile_id: PROFILE,
      date: "2026-09-01",
    }));
    const result = parseDraftEntriesInput({ entries });
    expect(result.formatError).toMatch(new RegExp(String(MAX_DRAFT_ENTRIES)));
  });

  it("collects a per-entry error by index, without discarding the entries that DID parse", () => {
    const result = parseDraftEntriesInput({
      entries: [
        { project_id: PROJECT, profile_id: PROFILE, date: "2026-09-01" }, // ok, index 0
        { project_id: "not-a-uuid", profile_id: PROFILE, date: "2026-09-02" }, // index 1
        { project_id: PROJECT, profile_id: PROFILE, date: "09-03-2026" }, // index 2
        { project_id: PROJECT, profile_id: PROFILE, date: "2026-09-04" }, // ok, index 3
      ],
    });
    expect(result.formatError).toBeNull();
    expect(result.entries).toHaveLength(2);
    expect(result.errors).toEqual([
      { index: 1, reason: "project_id must be a valid id" },
      { index: 2, reason: "date must be YYYY-MM-DD" },
    ]);
  });

  it("treats a missing profile_id as a per-entry error, not a crash", () => {
    const result = parseDraftEntriesInput({
      entries: [{ project_id: PROJECT, date: "2026-09-01" }],
    });
    expect(result.errors).toEqual([{ index: 0, reason: "profile_id must be a valid id" }]);
  });
});

describe("the tool JSON shapes", () => {
  it("SCHEDULING_TOOLS is exactly the three, in the order the spec names them", () => {
    expect(SCHEDULING_TOOLS.map((t) => t.name)).toEqual([
      "get_scheduling_picture",
      "draft_assignments",
      "clear_ai_drafts",
    ]);
  });

  it("get_scheduling_picture requires from/to and nothing else", () => {
    expect(GET_SCHEDULING_PICTURE_TOOL.input_schema.required).toEqual(["from", "to"]);
  });

  it("draft_assignments requires entries, each with project_id/profile_id/date", () => {
    expect(DRAFT_ASSIGNMENTS_TOOL.input_schema.required).toEqual(["entries"]);
    const items = (DRAFT_ASSIGNMENTS_TOOL.input_schema.properties as Record<string, { items: { required: string[] } }>)
      .entries.items;
    expect(items.required).toEqual(["project_id", "profile_id", "date"]);
  });

  it("clear_ai_drafts requires from/to and leaves project_id optional", () => {
    expect(CLEAR_AI_DRAFTS_TOOL.input_schema.required).toEqual(["from", "to"]);
    expect(Object.keys(CLEAR_AI_DRAFTS_TOOL.input_schema.properties as object)).toContain("project_id");
  });

  it("every tool description names the supervisor-rank refusal", () => {
    for (const tool of SCHEDULING_TOOLS) {
      expect(tool.description.toLowerCase()).toContain("supervisor");
    }
  });
});
