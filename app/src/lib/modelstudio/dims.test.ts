// The grammar has to read dimensions the way window 16's drawing prints
// them: per-panel widths as 30¼", 88½", 90", 87¾", 17" — and the way the
// office already types them (28'6", 28.5).

import { describe, expect, it } from "vitest";
import { fmtFtIn, fmtInchesFromMm, parseFtIn } from "./dims";

const IN = 2.54; // cm

describe("parseFtIn", () => {
  it("reads feet-inches, with and without a fraction", () => {
    expect(parseFtIn('28\'6"')).toBeCloseTo((28 * 12 + 6) * IN, 6);
    expect(parseFtIn("28' 6 1/2\"")).toBeCloseTo((28 * 12 + 6.5) * IN, 6);
    expect(parseFtIn("28'6½\"")).toBeCloseTo((28 * 12 + 6.5) * IN, 6);
  });

  it("reads the drawing's inch style — vulgar glyph or ascii fraction", () => {
    expect(parseFtIn('30¼"')).toBeCloseTo(30.25 * IN, 6);
    expect(parseFtIn('30 1/4"')).toBeCloseTo(30.25 * IN, 6);
    expect(parseFtIn('313 1/2"')).toBeCloseTo(313.5 * IN, 6);
    expect(parseFtIn('17"')).toBeCloseTo(17 * IN, 6);
  });

  it("keeps a bare plain number as feet, but a bare MIXED number as inches", () => {
    expect(parseFtIn("28.5")).toBeCloseTo(28.5 * 12 * IN, 6);
    // Nobody writes a fractional foot as "30 1/4" — the drawing writes
    // inches that way, so that is how it reads.
    expect(parseFtIn("30 1/4")).toBeCloseTo(30.25 * IN, 6);
    expect(parseFtIn("87¾")).toBeCloseTo(87.75 * IN, 6);
  });

  it("rejects what it cannot read", () => {
    expect(parseFtIn("")).toBeNull();
    expect(parseFtIn("wide")).toBeNull();
    expect(parseFtIn("1/0")).toBeNull();
  });
});

describe("formatting", () => {
  it("fmtFtIn round-trips the office style", () => {
    expect(fmtFtIn(parseFtIn('28\'6"')!)).toBe("28'6\"");
  });

  it("fmtInchesFromMm prints the drawing's own labels for window 16", () => {
    expect(fmtInchesFromMm(768)).toBe('30¼"');
    expect(fmtInchesFromMm(2248)).toBe('88½"');
    expect(fmtInchesFromMm(2286)).toBe('90"');
    expect(fmtInchesFromMm(2229)).toBe('87¾"');
    expect(fmtInchesFromMm(432)).toBe('17"');
  });
});
