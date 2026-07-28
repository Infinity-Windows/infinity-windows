import { describe, expect, it } from "vitest";
import { formatApiError, rawErrorMessage } from "./errors";

describe("formatApiError", () => {
  it("reads a thrown Error", () => {
    expect(formatApiError(new Error("Row not found"))).toBe("Row not found");
  });

  it("reads a PostgREST-shaped object", () => {
    expect(
      formatApiError({
        message: "duplicate key value violates unique constraint",
        code: "23505",
        details: null,
        hint: null,
      }),
    ).toBe("That already exists.");
  });

  it("explains a permission failure in plain English", () => {
    expect(formatApiError({ message: "new row violates row-level security policy", code: "42501" })).toBe(
      "You don't have permission to do that.",
    );
  });

  it("explains being offline", () => {
    expect(formatApiError(new TypeError("Failed to fetch"))).toContain("offline");
  });

  it("passes strings through", () => {
    expect(formatApiError("Clock in before starting a task")).toBe("Clock in before starting a task");
  });

  it("falls back for null and undefined", () => {
    expect(formatApiError(null, "fallback")).toBe("fallback");
    expect(formatApiError(undefined, "fallback")).toBe("fallback");
  });

  it("falls back for an empty object", () => {
    expect(formatApiError({}, "fallback")).toBe("fallback");
  });

  it("never returns [object Object]", () => {
    const cases: unknown[] = [
      {},
      { code: "PGRST205" },
      { message: {} },
      { details: "x", hint: "y" },
      Object.create(null),
      new Error(""),
      [],
      [{}],
      () => {},
      NaN,
    ];
    for (const value of cases) {
      const text = formatApiError(value);
      expect(text).not.toContain("[object Object]");
      expect(text.trim()).not.toBe("");
    }
  });
});

describe("rawErrorMessage", () => {
  it("returns an empty string for objects with nothing readable", () => {
    expect(rawErrorMessage({})).toBe("");
    expect(rawErrorMessage(undefined)).toBe("");
  });
});
