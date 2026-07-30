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

describe("faults in our own queries", () => {
  // The real payload the timecard showed a user: PostgREST refusing an
  // ambiguous embed. Short and brace-free, so it slipped through the
  // "keep a server message if it is short" rule and reached the screen.
  const ambiguousEmbed = {
    code: "PGRST201",
    message:
      "Could not embed because more than one relationship was found for 'time_shifts' and 'profiles'",
    hint: "Try changing 'profiles' to one of the following: 'profiles!time_shifts_profile_id_fkey'",
  };

  it("never shows the database's embed wording to a user", () => {
    const text = formatApiError(ambiguousEmbed);
    expect(text).not.toMatch(/embed/i);
    expect(text).not.toMatch(/relationship/i);
    expect(text).not.toMatch(/time_shifts/);
    expect(text).toMatch(/our side/i);
  });

  it("recognises the fault by wording even with no code", () => {
    expect(formatApiError({ message: ambiguousEmbed.message })).toMatch(/our side/i);
  });

  it("covers the rest of the schema-shape faults", () => {
    for (const code of ["PGRST100", "PGRST200", "PGRST202", "PGRST203", "PGRST204"]) {
      expect(formatApiError({ code, message: "whatever the server said" })).toMatch(
        /our side/i,
      );
    }
    expect(
      formatApiError({ message: `column "widget" does not exist` }),
    ).toMatch(/our side/i);
  });

  it("still lets a real, actionable server message through", () => {
    expect(formatApiError({ message: "Clock in before starting a task" })).toBe(
      "Clock in before starting a task",
    );
    expect(
      formatApiError({ message: "Only a foreman or above can move a mark on the plan." }),
    ).toBe("Only a foreman or above can move a mark on the plan.");
  });
});
