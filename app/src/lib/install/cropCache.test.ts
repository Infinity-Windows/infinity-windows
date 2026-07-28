import { describe, expect, it } from "vitest";
import {
  cropCacheKey,
  estimateSize,
  hashBbox,
  keysToEvict,
  MAX_CROP_BYTES,
  MAX_CROP_ENTRIES,
} from "./cropCache";
import type { Bbox } from "./markDrawing";

// Real Claude VISION boxes for page 1 of the Smith / PV Townhomes shop drawing.
const BOX_1: Bbox = [0.217, 0.128, 0.3, 0.29];
const BOX_4A: Bbox = [0.59, 0.462, 0.672, 0.622];
const BOX_4B: Bbox = [0.805, 0.462, 0.89, 0.622];

describe("hashBbox", () => {
  it("is stable for the same box", () => {
    expect(hashBbox(BOX_1)).toBe(hashBbox([0.217, 0.128, 0.3, 0.29]));
  });

  it("separates the real side-by-side 4A / 4B elevations", () => {
    expect(hashBbox(BOX_4A)).not.toBe(hashBbox(BOX_4B));
  });

  it("is order-sensitive — a reordered box is a different picture", () => {
    expect(hashBbox([0.1, 0.2, 0.3, 0.4])).not.toBe(hashBbox([0.3, 0.4, 0.1, 0.2]));
    expect(hashBbox([0.1, 0.2, 0.3, 0.4])).not.toBe(hashBbox([0.2, 0.1, 0.3, 0.4]));
  });

  it("distinguishes boxes that differ in a single coordinate", () => {
    expect(hashBbox([0.217, 0.128, 0.3, 0.29])).not.toBe(
      hashBbox([0.217, 0.128, 0.3, 0.291]),
    );
  });

  it("treats equal values written differently as the same box", () => {
    expect(hashBbox([0.5, 0.25, 0.75, 0.5])).toBe(
      hashBbox([0.5000000, 0.25, 0.75, 0.5]),
    );
  });

  it("returns a short, url-safe token", () => {
    expect(hashBbox(BOX_1)).toMatch(/^[0-9a-z]+$/);
  });
});

describe("cropCacheKey", () => {
  const base = { plansetId: "ps-1", markCode: "4A", bbox: BOX_4A, scale: 2600 };

  it("builds planset:mark:hash:scale", () => {
    expect(cropCacheKey(base)).toBe(`ps-1:4A:${hashBbox(BOX_4A)}:2600`);
  });

  it("folds mark case and surrounding space", () => {
    expect(cropCacheKey({ ...base, markCode: " 4a " })).toBe(cropCacheKey(base));
  });

  it("changes when any part of the identity changes", () => {
    expect(cropCacheKey({ ...base, plansetId: "ps-2" })).not.toBe(cropCacheKey(base));
    expect(cropCacheKey({ ...base, markCode: "4B" })).not.toBe(cropCacheKey(base));
    expect(cropCacheKey({ ...base, bbox: BOX_4B })).not.toBe(cropCacheKey(base));
    expect(cropCacheKey({ ...base, scale: 1600 })).not.toBe(cropCacheKey(base));
  });

  it("does not collide across two marks on the same page of the same planset", () => {
    const a = cropCacheKey({ ...base, markCode: "4A", bbox: BOX_4A });
    const b = cropCacheKey({ ...base, markCode: "4B", bbox: BOX_4B });
    expect(a).not.toBe(b);
  });

  it("rounds a fractional scale so a device pixel ratio can't fragment the cache", () => {
    expect(cropCacheKey({ ...base, scale: 2600.4 })).toBe(cropCacheKey(base));
  });

  it("keeps a plain spec crop keyed exactly as before", () => {
    // Crops already cached on installers' phones must still be found.
    expect(cropCacheKey({ ...base, variant: undefined })).toBe(cropCacheKey(base));
  });

  it("separates a ringed elevation crop from an inverted spec crop", () => {
    // Both are "this mark, this box, this planset" but they are different
    // pictures — one is white-on-black line art, the other has a red ring on it.
    expect(cropCacheKey({ ...base, variant: "elev" })).not.toBe(cropCacheKey(base));
  });

  it("separates two variants of the same box", () => {
    expect(cropCacheKey({ ...base, variant: "elev" })).not.toBe(
      cropCacheKey({ ...base, variant: "other" }),
    );
  });
});

describe("estimateSize", () => {
  it("approximates the decoded byte size of a data URL", () => {
    expect(estimateSize("")).toBe(0);
    expect(estimateSize("a".repeat(4000))).toBe(3000);
  });
});

describe("keysToEvict", () => {
  const entry = (key: string, size: number, lastUsed: number) => ({
    key,
    size,
    lastUsed,
  });

  it("keeps everything while under both caps", () => {
    expect(keysToEvict([entry("a", 10, 1), entry("b", 10, 2)], 100, 10)).toEqual([]);
  });

  it("drops least-recently-used first until the byte cap is met", () => {
    const entries = [
      entry("old", 40, 1),
      entry("mid", 40, 2),
      entry("new", 40, 3),
    ];
    expect(keysToEvict(entries, 100, 10)).toEqual(["old"]);
  });

  it("keeps dropping until it actually fits", () => {
    const entries = [
      entry("a", 50, 1),
      entry("b", 50, 2),
      entry("c", 50, 3),
      entry("d", 50, 4),
    ];
    expect(keysToEvict(entries, 100, 10)).toEqual(["a", "b"]);
  });

  it("enforces the entry cap even when the bytes are tiny", () => {
    const entries = [
      entry("a", 1, 1),
      entry("b", 1, 2),
      entry("c", 1, 3),
    ];
    expect(keysToEvict(entries, 1000, 1)).toEqual(["a", "b"]);
  });

  it("breaks ties on key so eviction is deterministic", () => {
    const entries = [entry("b", 60, 5), entry("a", 60, 5), entry("c", 60, 9)];
    expect(keysToEvict(entries, 120, 10)).toEqual(["a"]);
  });

  it("never returns more keys than it was given", () => {
    const entries = [entry("a", 100, 1), entry("b", 100, 2)];
    expect(keysToEvict(entries, 0, 0)).toEqual(["a", "b"]);
  });

  it("survives negative or missing-ish sizes without looping forever", () => {
    const entries = [entry("a", -5, 1), entry("b", 10, 2)];
    expect(keysToEvict(entries, 0, 10)).toEqual(["a", "b"]);
  });

  it("leaves an empty store alone", () => {
    expect(keysToEvict([], 10, 10)).toEqual([]);
  });

  it("ships with caps that are bounded, not decorative", () => {
    expect(MAX_CROP_BYTES).toBeGreaterThan(0);
    expect(MAX_CROP_ENTRIES).toBeGreaterThan(0);
    const many = Array.from({ length: MAX_CROP_ENTRIES + 5 }, (_, i) =>
      entry(`k${String(i).padStart(4, "0")}`, 1, i),
    );
    expect(keysToEvict(many)).toHaveLength(5);
  });
});
