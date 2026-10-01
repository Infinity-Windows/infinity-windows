import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  user: "speaker-1" as string | null,
  selects: [] as string[],
  inserted: [] as Record<string, unknown>[],
  updated: [] as Record<string, unknown>[],
  legacy: false,
  zeroRow: false,
}));
vi.mock("./supabase", () => ({ supabase: {
  auth: { getUser: async () => ({ data: { user: state.user ? { id: state.user } : null }, error: null }) },
  from: () => ({
    select: (columns: string) => {
      state.selects.push(columns);
      return { order: async () => state.legacy && columns.includes("category")
        ? { data: null, error: { code: "42703", message: "column category does not exist" } }
        : { data: [{ id: "r1", body: "An older report", status: "open" }], error: null } };
    },
    insert: async (row: Record<string, unknown>) => { state.inserted.push(row); return { error: null }; },
    update: (row: Record<string, unknown>) => {
      state.updated.push(row);
      return { eq: () => ({ select: () => ({ single: async () => state.zeroRow
        ? { data: null, error: { code: "PGRST116", message: "The result contains 0 rows" } }
        : { data: { id: "r1", status: "resolved" }, error: null } }) }) };
    },
  }),
} }));

import { listAppFeedback, resolveAppFeedback, submitAppFeedback } from "./appFeedback";

beforeEach(() => { state.user = "speaker-1"; state.selects = []; state.inserted = []; state.updated = []; state.legacy = false; state.zeroRow = false; });

describe("AI app feedback API", () => {
  it("files in the AI section as the authenticated actor", async () => {
    await submitAppFeedback("bug", "The AI missed my hours", { category: "ai", actorId: "speaker-1" });
    expect(state.inserted).toEqual([{ author: "speaker-1", kind: "bug", body: "The AI missed my hours", category: "ai" }]);
  });
  it("refuses a changed or signed-out account before insert", async () => {
    state.user = "someone-else";
    await expect(submitAppFeedback("bug", "Report", { category: "ai", actorId: "speaker-1" })).rejects.toThrow("sign-in changed");
    state.user = null;
    await expect(submitAppFeedback("bug", "Report", { category: "ai", actorId: "speaker-1" })).rejects.toThrow("sign-in changed");
    expect(state.inserted).toHaveLength(0);
  });
  it("falls back to the legacy list when category and resolution columns are absent", async () => {
    state.legacy = true;
    expect((await listAppFeedback())[0].body).toBe("An older report");
    expect(state.selects).toHaveLength(2);
    expect(state.selects[0]).toContain("category");
    expect(state.selects[1]).not.toContain("category");
  });
  it("does not treat a zero-row resolution as success", async () => {
    state.zeroRow = true;
    await expect(resolveAppFeedback("missing", "Verified in the field")).rejects.toMatchObject({ code: "PGRST116" });
    expect(state.updated[0]).toMatchObject({ status: "resolved", resolved_by: "speaker-1", resolution_note: "Verified in the field" });
  });
});
