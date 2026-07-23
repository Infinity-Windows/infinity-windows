import { describe, expect, it } from "vitest";
import { HOME_STATE, isOutOfTown } from "./homeBase";

describe("isOutOfTown", () => {
  it("treats the home state as local", () => {
    expect(isOutOfTown(HOME_STATE)).toBe(false);
    expect(isOutOfTown("ut")).toBe(false);
    expect(isOutOfTown(" UT ")).toBe(false);
  });

  it("flags a different state as out of town", () => {
    expect(isOutOfTown("TX")).toBe(true);
    expect(isOutOfTown("California")).toBe(true);
  });

  it("does not nag when the state is unknown", () => {
    expect(isOutOfTown(null)).toBe(false);
    expect(isOutOfTown(undefined)).toBe(false);
    expect(isOutOfTown("")).toBe(false);
    expect(isOutOfTown("   ")).toBe(false);
  });

  it("respects an overridden home state", () => {
    expect(isOutOfTown("TX", "TX")).toBe(false);
    expect(isOutOfTown("UT", "TX")).toBe(true);
  });
});
