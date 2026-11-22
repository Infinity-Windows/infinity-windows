import { describe, expect, it } from "vitest";
import { matchOption, optionsWith, UNIT_MATERIALS, unitConfigurations } from "./unitVocabulary";

describe("unit vocabulary", () => {
  it("reads a differently spelled value as the listed option", () => {
    expect(matchOption(UNIT_MATERIALS, " thermal-break Aluminium ")).toBe("Aluminum");
    expect(matchOption(UNIT_MATERIALS, "Thermally broken aluminum")).toBe("Aluminum");
    expect(matchOption(UNIT_MATERIALS, "VINYL")).toBe("Vinyl");
  });
  it("keeps a value that is not on the list", () => {
    expect(matchOption(UNIT_MATERIALS, " Bronze ")).toBe("Bronze");
    expect(matchOption(UNIT_MATERIALS, null)).toBe("");
  });
  it("adds values in use after the short list, once each", () => {
    const options = optionsWith(UNIT_MATERIALS, "Bronze", "aluminum", "bronze", "", null);
    expect(options).toEqual([...UNIT_MATERIALS, "Bronze"]);
  });
  it("offers a type's configurations, or all of them when the type is unknown", () => {
    expect(unitConfigurations("door")).toEqual(["Swing door", "Sliding door"]);
    expect(unitConfigurations("curtain_wall")).toEqual([]);
    expect(unitConfigurations("")).toContain("Two fixed panels");
    expect(unitConfigurations("")).toContain("Swing door");
  });
});
