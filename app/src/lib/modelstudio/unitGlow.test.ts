import { describe, expect, it } from "vitest";
import { markOfPackage, unitsForMark } from "./unitGlow";

describe("markOfPackage", () => {
  it("reads the first tagged mark", () => {
    const pkg = { package_marks: [{ mark_code: "16" }, { mark_code: "17" }] };
    expect(markOfPackage(pkg)).toBe("16");
  });

  it("trims whitespace off the mark", () => {
    expect(markOfPackage({ package_marks: [{ mark_code: "  16  " }] })).toBe("16");
  });

  it("null when nothing is tagged yet", () => {
    expect(markOfPackage({ package_marks: [] })).toBeNull();
    expect(markOfPackage({ package_marks: undefined })).toBeNull();
    expect(markOfPackage(null)).toBeNull();
    expect(markOfPackage(undefined)).toBeNull();
  });

  it("null on a blank mark code", () => {
    expect(markOfPackage({ package_marks: [{ mark_code: "   " }] })).toBeNull();
  });
});

describe("unitsForMark", () => {
  it("an exact twin code glows only that twin", () => {
    expect(unitsForMark(["16-1", "16-2"], "16-1")).toEqual(["16-1"]);
  });

  it("an exact non-twin mark glows its one unit", () => {
    expect(unitsForMark(["16", "17"], "16")).toEqual(["16"]);
  });

  it("both survey dialects resolve to the same exact unit", () => {
    // normalizeMarkCode: "13B" and "13-2" are the same physical opening.
    expect(unitsForMark(["13-1", "13-2"], "13B")).toEqual(["13-2"]);
  });

  it("a bare base mark falls back to every unit sharing it — both twins", () => {
    expect(unitsForMark(["16-1", "16-2", "17"], "16")).toEqual(["16-1", "16-2"]);
  });

  it("an exact hit wins outright over the base-mark fallback", () => {
    // "16-1" itself is also a valid exact target, not the base-mark set.
    expect(unitsForMark(["16-1", "16-2"], "16-1")).not.toContain("16-2");
  });

  it("no match anywhere is an empty list, never a guess", () => {
    expect(unitsForMark(["16", "17"], "22")).toEqual([]);
  });

  it("a blank query matches nothing", () => {
    expect(unitsForMark(["16"], "")).toEqual([]);
    expect(unitsForMark(["16"], "   ")).toEqual([]);
  });
});
