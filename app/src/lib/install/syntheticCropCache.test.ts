// Only syntheticCropKey is pure enough to unit-test — the IndexedDB I/O
// below it stays untested directly, same convention cropCache.test.ts and
// jobModelCache.test.ts already use (keysToEvict, reused rather than
// forked, already carries its own coverage in cropCache.test.ts).

import { describe, expect, it } from "vitest";
import { syntheticCropKey } from "./syntheticCropCache";

describe("syntheticCropKey", () => {
  it("builds the documented synthetic:{projectId}:{mark}:{savedAt} shape", () => {
    expect(syntheticCropKey("proj-1", "4A", "2026-08-19T00:00:00Z")).toBe(
      "synthetic:proj-1:4A:2026-08-19T00:00:00Z",
    );
  });

  it("normalizes the mark the same way cropCacheKey does — trim, upper-case", () => {
    expect(syntheticCropKey("proj-1", " 4a ", "t1")).toBe(
      syntheticCropKey("proj-1", "4A", "t1"),
    );
  });

  it("changes when the model's savedAt changes — a re-save invalidates naturally", () => {
    const before = syntheticCropKey("proj-1", "4A", "2026-08-19T00:00:00Z");
    const after = syntheticCropKey("proj-1", "4A", "2026-08-19T00:05:00Z");
    expect(before).not.toBe(after);
  });

  it("tolerates a model with no savedAt at all rather than throwing", () => {
    expect(() => syntheticCropKey("proj-1", "4A", null)).not.toThrow();
    expect(() => syntheticCropKey("proj-1", "4A", undefined)).not.toThrow();
    expect(syntheticCropKey("proj-1", "4A", null)).toBe(syntheticCropKey("proj-1", "4A", undefined));
  });

  it("keeps two projects' same-mark renders apart", () => {
    expect(syntheticCropKey("proj-1", "4A", "t1")).not.toBe(syntheticCropKey("proj-2", "4A", "t1"));
  });
});
