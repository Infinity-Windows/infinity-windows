import { describe, expect, it } from "vitest";
import { splitName } from "./crewName";

describe("splitName", () => {
  it("gives a one-word name a first and nothing else", () => {
    expect(splitName("Isaac")).toEqual({ first: "Isaac", rest: "" });
  });

  it("splits a two-word name after the first word", () => {
    expect(splitName("Chace cheek")).toEqual({ first: "Chace", rest: "cheek" });
  });

  it("keeps every word after the first together, in order", () => {
    expect(splitName("Tyson antonio diaz")).toEqual({
      first: "Tyson",
      rest: "antonio diaz",
    });
  });

  it("NEVER changes casing — the roster's spelling is the roster's business", () => {
    expect(splitName("Antonio miguel")).toEqual({
      first: "Antonio",
      rest: "miguel",
    });
    expect(splitName("mcKAY o'Brien")).toEqual({
      first: "mcKAY",
      rest: "o'Brien",
    });
  });

  it("tidies stray whitespace rather than rendering a gap", () => {
    expect(splitName("  Dave   Lee  ")).toEqual({ first: "Dave", rest: "Lee" });
    expect(splitName("Maria\tRuiz")).toEqual({ first: "Maria", rest: "Ruiz" });
  });

  it("survives an empty or blank name instead of throwing", () => {
    expect(splitName("")).toEqual({ first: "", rest: "" });
    expect(splitName("   ")).toEqual({ first: "", rest: "" });
  });
});
