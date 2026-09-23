// The tab's own dictionary keeps the main catalog's promise: every line in
// English AND Spanish, none blank — and the one sentence the owner specified
// word for word is exactly that sentence.
import { describe, expect, it } from "vitest";
import { USING_FORGE_COPY } from "./usingForgeCopy";

describe("Using Forge copy", () => {
  it("has English and Spanish for every line", () => {
    for (const [key, entry] of Object.entries(USING_FORGE_COPY)) {
      expect(entry.en.trim(), `${key} en`).not.toBe("");
      expect(entry.es.trim(), `${key} es`).not.toBe("");
    }
  });

  it("carries the design-preview sentence verbatim", () => {
    expect(USING_FORGE_COPY["uf.previewText"].en).toBe(
      "Design preview — some steps are proposed, not available in the current app.",
    );
  });

  it("never offers a download or offline copy", () => {
    for (const entry of Object.values(USING_FORGE_COPY)) {
      expect(entry.en).not.toMatch(/\b(download (it|this|the video)|save (it|this) for offline|available offline)\b/i);
    }
  });
});
