import { describe, expect, it } from "vitest";
import {
  checkFit,
  readyToInstall,
  smallest,
  DEFAULT_CLEARANCE,
} from "./fit";

describe("checkFit", () => {
  it("returns unknown when inputs are missing", () => {
    expect(checkFit({ unitWidthIn: 30, unitHeightIn: 50, roWidthIn: null, roHeightIn: null }).verdict).toBe("unknown");
  });

  it("passes with proper shim clearance", () => {
    // 30x50 unit, RO 30.75 x 50.75 => 0.75 gap each = 0.375/side, within 0.25-0.5
    const r = checkFit({ unitWidthIn: 30, unitHeightIn: 50, roWidthIn: 30.75, roHeightIn: 50.75 });
    expect(r.verdict).toBe("fits");
    expect(r.widthGap).toBe(0.75);
  });

  it("flags too_small as a hard stop", () => {
    const r = checkFit({ unitWidthIn: 30, unitHeightIn: 50, roWidthIn: 29.5, roHeightIn: 50.75 });
    expect(r.verdict).toBe("too_small");
    expect(r.message).toMatch(/flag the office/i);
  });

  it("flags tight when under min clearance", () => {
    // gap 0.25 total = 0.125/side < 0.25 min
    const r = checkFit({ unitWidthIn: 30, unitHeightIn: 50, roWidthIn: 30.25, roHeightIn: 50.75 });
    expect(r.verdict).toBe("tight");
  });

  it("flags too_big when over max clearance", () => {
    // gap 1.5 total = 0.75/side > 0.5 max
    const r = checkFit({ unitWidthIn: 30, unitHeightIn: 50, roWidthIn: 31.5, roHeightIn: 50.75 });
    expect(r.verdict).toBe("too_big");
  });

  it("respects a custom clearance", () => {
    const r = checkFit({
      unitWidthIn: 30,
      unitHeightIn: 50,
      roWidthIn: 31.5,
      roHeightIn: 51.5,
      clearance: { minPerSide: 0.5, maxPerSide: 1 },
    });
    expect(r.verdict).toBe("fits");
  });
});

describe("smallest", () => {
  it("returns the smallest positive measurement", () => {
    expect(smallest([30.5, 30.25, 30.75])).toBe(30.25);
  });
  it("ignores nulls and non-positive values", () => {
    expect(smallest([null, 0, 48, undefined, 47.5])).toBe(47.5);
  });
  it("returns null when nothing valid", () => {
    expect(smallest([null, undefined])).toBeNull();
  });
});

describe("readyToInstall", () => {
  const base = {
    hasUnit: true,
    typeMatches: true,
    fit: "fits" as const,
    condition: "ok" as const,
    atLocationOrLoaded: true,
  };

  it("is ready when everything checks out", () => {
    expect(readyToInstall(base).status).toBe("ready");
  });

  it("blocks on wrong type", () => {
    expect(readyToInstall({ ...base, typeMatches: false }).status).toBe("blocked");
  });

  it("blocks on damaged", () => {
    expect(readyToInstall({ ...base, condition: "damaged" }).status).toBe("blocked");
  });

  it("blocks on too_small", () => {
    expect(readyToInstall({ ...base, fit: "too_small" }).status).toBe("blocked");
  });

  it("is incomplete when unmeasured or unchecked", () => {
    expect(readyToInstall({ ...base, fit: "unknown" }).status).toBe("incomplete");
    expect(readyToInstall({ ...base, condition: "unknown" }).status).toBe("incomplete");
    expect(readyToInstall({ ...base, hasUnit: false }).status).toBe("incomplete");
  });

  it("exposes default clearance constants", () => {
    expect(DEFAULT_CLEARANCE.minPerSide).toBe(0.25);
    expect(DEFAULT_CLEARANCE.maxPerSide).toBe(0.5);
  });
});
