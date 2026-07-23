import { describe, expect, it } from "vitest";
import { isMissingClockInOverload, normalizeNote } from "./timeclockNote";

describe("normalizeNote", () => {
  it("keeps a real note, trimmed", () => {
    expect(normalizeNote("  needs a bigger ladder  ")).toBe("needs a bigger ladder");
  });

  it("collapses blank/whitespace-only notes to null", () => {
    expect(normalizeNote("")).toBeNull();
    expect(normalizeNote("   ")).toBeNull();
    expect(normalizeNote("\n\t ")).toBeNull();
  });

  it("treats missing values as null", () => {
    expect(normalizeNote(null)).toBeNull();
    expect(normalizeNote(undefined)).toBeNull();
  });
});

describe("isMissingClockInOverload", () => {
  it("recognises the PostgREST no-matching-function code", () => {
    expect(isMissingClockInOverload({ code: "PGRST202" })).toBe(true);
  });

  it("recognises message-shaped 'function does not exist' errors", () => {
    expect(
      isMissingClockInOverload(new Error("Could not find the function public.clock_in")),
    ).toBe(true);
    expect(
      isMissingClockInOverload(new Error("function clock_in(...) does not exist")),
    ).toBe(true);
  });

  it("does not treat a normal failure as a missing overload", () => {
    expect(isMissingClockInOverload(new Error("permission denied"))).toBe(false);
    expect(isMissingClockInOverload({ code: "42501" })).toBe(false);
  });
});
