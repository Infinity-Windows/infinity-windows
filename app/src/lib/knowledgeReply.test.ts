import { describe, expect, it, vi } from "vitest";
const invoke = vi.hoisted(() => vi.fn());
vi.mock("./supabase", () => ({ supabase: { functions: { invoke } }, supabaseConfigured: true }));
import { askInfinity } from "./knowledge";
import { emptyLearningContent } from "../../../supabase/functions/_shared/learningTools";

describe("Ask response transport", () => {
  it("preserves a new learning checklist and every source request before any reload", async () => {
    const learning = { request_id: "first", source_request_ids: ["first", "second"], project_id: "job", job: null, unit_id: null, unit_label: "16", content: { ...emptyLearningContent(), issue: "Corner leaked" }, missing: ["impact"], reviewer: null };
    invoke.mockResolvedValue({ data: { answer: "Review this lesson", field: { request_id: "second", receipts: [], checklist: null, learning } }, error: null });
    const reply = await askInfinity("Write up a lesson learned");
    expect(reply.field?.learning).toEqual(learning);
    expect(reply.field?.request_id).toBe("second");
  });
});
