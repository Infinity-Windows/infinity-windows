import { describe, expect, it } from "vitest";
import { isStudioTooNarrow, STUDIO_MIN_WIDTH_PX } from "./studioWidthGate";

describe("isStudioTooNarrow", () => {
  it("is too narrow just under the threshold", () => {
    expect(isStudioTooNarrow(STUDIO_MIN_WIDTH_PX - 1)).toBe(true);
  });

  it("is NOT too narrow exactly at the threshold", () => {
    expect(isStudioTooNarrow(STUDIO_MIN_WIDTH_PX)).toBe(false);
  });

  it("is not too narrow comfortably above it", () => {
    expect(isStudioTooNarrow(1440)).toBe(false);
  });

  it("a phone width is too narrow", () => {
    expect(isStudioTooNarrow(390)).toBe(true);
  });
});
