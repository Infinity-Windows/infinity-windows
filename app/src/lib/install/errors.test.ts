import { describe, expect, it } from "vitest";
import { formatApiError, formatFieldError, isInternalJsError } from "./errors";

describe("formatApiError", () => {
  it("reads PostgREST-style objects instead of [object Object]", () => {
    expect(
      formatApiError({
        code: "PGRST205",
        message: "Could not find the table 'public.project_plan_outlines'",
        hint: "Perhaps you meant the table 'public.project_plansets'",
      }),
    ).toContain("Could not find the table");
  });

  it("falls back for empty values", () => {
    expect(formatApiError(null, "fallback")).toBe("fallback");
  });

  it("reads a thrown Error", () => {
    expect(formatApiError(new Error("PDF failed to load"))).toBe("PDF failed to load");
  });

  it("includes hint and code alongside a PostgREST message", () => {
    const text = formatApiError({
      message: "permission denied for table project_openings",
      code: "42501",
      details: null,
      hint: "Check your role",
    });
    expect(text).toContain("permission denied for table project_openings");
    expect(text).toContain("Check your role");
    expect(text).toContain("42501");
  });

  it("passes strings through", () => {
    expect(formatApiError("Upload cancelled")).toBe("Upload cancelled");
  });

  it("falls back for blank strings", () => {
    expect(formatApiError("   ", "fallback")).toBe("fallback");
  });

  it("falls back for undefined", () => {
    expect(formatApiError(undefined, "fallback")).toBe("fallback");
  });

  it("falls back for an empty object", () => {
    expect(formatApiError({}, "fallback")).toBe("fallback");
  });

  it("uses details when there is no message", () => {
    expect(formatApiError({ details: "Key (id)=(x) is not present in table" })).toContain(
      "Key (id)=(x) is not present",
    );
  });

  it("uses the code when nothing else is readable", () => {
    expect(formatApiError({ code: "PGRST301" })).toBe("Request failed [PGRST301]");
  });

  it("unwraps edge-function style { error: { message } }", () => {
    expect(formatApiError({ error: { message: "Anthropic rate limit" } })).toContain(
      "Anthropic rate limit",
    );
  });

  it("serialises an object with no recognised fields rather than stringifying it", () => {
    expect(formatApiError({ weird: "shape" })).toBe('{"weird":"shape"}');
  });

  it("never returns [object Object]", () => {
    const cases: unknown[] = [
      {},
      { nested: {} },
      { message: {} },
      { message: 42 },
      Object.create(null),
      new Error(""),
      [{}],
      [],
      () => {},
      Symbol("x"),
      NaN,
      { toString: () => "[object Object]" },
    ];
    for (const value of cases) {
      expect(formatApiError(value)).not.toContain("[object Object]");
      expect(formatApiError(value).trim()).not.toBe("");
    }
  });

  it("survives circular objects", () => {
    const a: Record<string, unknown> = { code: null };
    a.self = a;
    expect(formatApiError(a, "fallback")).toBe("fallback");
  });
});

describe("isInternalJsError", () => {
  it("recognises engine error types", () => {
    for (const err of [
      new TypeError("undefined is not a function"),
      new ReferenceError("x is not defined"),
      new RangeError("out of range"),
      new SyntaxError("Unexpected token"),
    ]) {
      expect(isInternalJsError(err)).toBe(true);
    }
  });

  it("recognises engine wording even when rethrown as a plain Error", () => {
    expect(isInternalJsError(new Error("t.foo is not a function"))).toBe(true);
    expect(isInternalJsError(new Error("Cannot read properties of undefined"))).toBe(true);
  });

  it("does not mistake a real API failure for a bug", () => {
    expect(isInternalJsError({ message: "permission denied for table x" })).toBe(false);
    expect(isInternalJsError(new Error("Only PDF, DWG, or DXF plansets are supported."))).toBe(
      false,
    );
    expect(isInternalJsError(null)).toBe(false);
  });
});

describe("formatFieldError", () => {
  /**
   * The regression that put `undefined is not a function (near '...e of t...')`
   * on an installer's phone where the building plan should have been.
   */
  it("hides engine text behind the caller's plain sentence", () => {
    const text = formatFieldError(
      new TypeError("undefined is not a function (near '...e of t...')"),
      "This plan could not be opened.",
    );
    expect(text).toBe("This plan could not be opened.");
  });

  it("still surfaces a real API message a lead can act on", () => {
    expect(
      formatFieldError({ message: "permission denied for table project_openings" }, "fallback"),
    ).toContain("permission denied");
  });

  it("never returns engine text, whatever it is handed", () => {
    const cases: unknown[] = [
      new TypeError("undefined is not a function"),
      new Error("e is not iterable"),
      new ReferenceError("t is not defined"),
      "Cannot read properties of null",
      { message: "x is not a function" },
    ];
    for (const value of cases) {
      const text = formatFieldError(value, "Could not open this plan.");
      expect(text).toBe("Could not open this plan.");
    }
  });

  it("falls back to a generic sentence when given a blank fallback", () => {
    expect(formatFieldError(new TypeError("boom is not a function"), "  ").trim()).not.toBe("");
  });
});
