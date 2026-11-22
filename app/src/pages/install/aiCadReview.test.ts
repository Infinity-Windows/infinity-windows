import { afterEach, expect, it, vi } from "vitest";
import { cadReviewContext } from "../../../../supabase/functions/_shared/cadReviewPrompt.mts";
import type { CadUnitDraft } from "../../lib/install/cadUnitPreview";
import { reviewOpeningWithAi, variantOf } from "./aiCadReview";

vi.mock("../../lib/supabase", () => ({ supabase: {} }));
afterEach(() => vi.unstubAllGlobals());

const base: CadUnitDraft = {
  key: "a", label: "A", sheet: 1, kind: "window", widthMm: null, heightMm: null, configuration: "",
  itemNumber: "1", quantity: 18, material: "", crop: { left: 0, top: 0, right: 1, bottom: 1 }, dimensions: [],
};
const variant = { ...base, key: "a-1", label: "A-1", quantity: 1 };
const other = { ...variant, key: "a-2", label: "A-2" };

it("passes the exact variant and existing counts to AI and rejects an over-quantity suggestion", async () => {
  const fetchReview = vi.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    const context = cadReviewContext(body, body.candidates, []);
    expect(context.variantKey).toBe("a-1");
    expect(context.options.slice(0, 2)).toMatchObject([
      { key: "a-1", assignedCount: 0, expectedQuantity: 1 },
      { key: "a", assignedCount: 18, expectedQuantity: 18 },
    ]);
    return Response.json({ key: "a", reason: "Same family" });
  });
  vi.stubGlobal("fetch", fetchReview);
  const result = await reviewOpeningWithAi({
    projectId: "test", opening: { x: 0, y: 0, mark: "1-A", sheet: 1, floor: "Level 1", labels: [] },
    plan: {} as Parameters<typeof reviewOpeningWithAi>[0]["plan"], planCrop: "test crop",
    drafts: [base, other, variant], relatedDraft: base, quantities: { a: { found: 18, expected: 18 }, "a-1": { found: 0, expected: 1 } },
  });
  expect(result).toEqual({ key: null, reason: "The suggested CAD drawing already has its stated quantity assigned." });
  expect(variantOf([base, other], base, "1-A")).toBeUndefined();
});
