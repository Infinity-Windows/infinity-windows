import { describe, expect, it } from "vitest";
import { normalizeDimensions, DimensionInputError, type DimensionInput } from "./dimensions";

const input = (changes: Partial<DimensionInput> = {}): DimensionInput => ({ width: 60, height: 48,
  units: "in", source: "measured", sourceReference: null, ...changes });

describe("sourced dimension input", () => {
  it.each([
    [60, 48, "in"], [5, 4, "ft"], [1524, 1219.2, "mm"], [152.4, 121.92, "cm"],
  ] as const)("preserves %s by %s %s and normalizes the same 20-square-foot geometry", (width, height, units) => {
    const raw = input({ width, height, units, source: "plans", sourceReference: "planset:original-revision" });
    const result = normalizeDimensions(raw);
    expect(result.widthIn).toBeCloseTo(60, 10);
    expect(result.heightIn).toBeCloseTo(48, 10);
    expect(result.areaSqFt).toBeCloseTo(20, 10);
    expect(result.original).toEqual(raw);
    expect(result.original).not.toBe(raw);
  });

  it("requires each dimension, explicit units and source without coercion", () => {
    for (const raw of [input({ width: 0 }), input({ height: -1 }), input({ width: NaN }),
      input({ height: Infinity }), { ...input(), width: "60" }, { ...input(), units: "" },
      { ...input(), source: "From plans" }, { ...input(), sourceReference: " " },
      { width: 60, height: 48, units: "in" }, { ...input(), verified: true }])
      expect(() => normalizeDimensions(raw)).toThrow(DimensionInputError);
  });

  it("rejects overflow and underflow instead of emitting zero or infinite area", () => {
    expect(() => normalizeDimensions(input({ width: Number.MAX_VALUE, units: "ft" }))).toThrow(DimensionInputError);
    expect(() => normalizeDimensions(input({ width: Number.MIN_VALUE, units: "mm" }))).toThrow(DimensionInputError);
  });

  it("keeps an estimate flagged and never manufactures verification", () => {
    const result = normalizeDimensions(input({ source: "estimated" }));
    expect(result.estimated).toBe(true);
    expect(result.original.source).toBe("estimated");
    expect(result).not.toHaveProperty("verified");
  });

  it("rejects accessors and custom objects without running caller code", () => {
    let calls = 0;
    const raw = { ...input(), get width() { calls++; return 60; } };
    expect(() => normalizeDimensions(raw)).toThrow(DimensionInputError);
    expect(calls).toBe(0);
    expect(() => normalizeDimensions(Object.create(input()))).toThrow(DimensionInputError);
  });

  it("preserves provenance and geometry despite later edits to a draft", () => {
    const raw = input({ sourceReference: "field-note:original" });
    const result = normalizeDimensions(raw);
    raw.width = 12;
    raw.sourceReference = "replacement";
    expect(result.original.width).toBe(60);
    expect(result.original.sourceReference).toBe("field-note:original");
    expect(Object.isFrozen(result.original)).toBe(true);
    expect(result.areaSqFt).toBe(20);
  });
});
