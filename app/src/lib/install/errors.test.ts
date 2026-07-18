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
});
