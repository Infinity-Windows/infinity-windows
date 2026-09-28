// The card's copy lives outside app/src/lib/i18n (bundle budget), so the
// advisory rule that catches an English string shipped as Spanish never sees
// it. This is that rule, for this catalog: both languages, never the same
// words, the same placeholders.
import { describe, expect, it } from "vitest";
import { SCHEDULE_REVIEW_CATALOG } from "./scheduleReviewCatalog";

describe("the Review AI drafts copy", () => {
  it("ships every string in English and Spanish, translated, with matching placeholders", () => {
    for (const [key, entry] of Object.entries(SCHEDULE_REVIEW_CATALOG)) {
      expect(entry.en.trim(), key).not.toBe("");
      expect(entry.es.trim(), key).not.toBe("");
      expect(entry.es, `${key} ships its English as Spanish`).not.toBe(entry.en);
      const holes = (s: string) => (s.match(/\{[a-z]+\}/g) ?? []).sort();
      expect(holes(entry.es), `${key} placeholders`).toEqual(holes(entry.en));
      expect(key.startsWith("aiReview.")).toBe(true);
    }
  });
});
