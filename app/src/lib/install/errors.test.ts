import { describe, expect, it } from "vitest";
import { formatApiError } from "./errors";

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
