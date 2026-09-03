import { describe, expect, it } from "vitest";
import { isMissingFunction, OPENING_SELECT, PROFILE_COLS } from "./api";

/**
 * Guards the column contract introduced by
 * supabase/migrations/20260729200000_profiles_rls_lockdown.sql. The
 * `authenticated` database role now holds SELECT on an explicit list of
 * profiles columns, so asking for anything outside it — a credential column, or
 * a bare `*` — fails at the database with 42501 instead of quietly succeeding.
 * These assertions catch that at build time rather than in front of a crew.
 */

const GRANTED_SELECT_COLUMNS = [
  "id",
  "display_name",
  "skill_level",
  "role",
  "active",
  // 20260968000000_profile_language.sql granted SELECT (language) to the
  // authenticated role — a person may read their own app-language preference.
  "language",
  "created_at",
  "updated_at",
];

function columnsOf(list: string): string[] {
  return list.split(",").map((c) => c.trim()).filter(Boolean);
}

describe("PROFILE_COLS", () => {
  it("asks only for columns the authenticated role may read", () => {
    expect(columnsOf(PROFILE_COLS)).toEqual(GRANTED_SELECT_COLUMNS);
  });

  it("never asks for a PIN column", () => {
    expect(PROFILE_COLS).not.toMatch(/\bpin\b/);
    expect(PROFILE_COLS).not.toMatch(/pin_hash/);
  });

  it("never uses a wildcard", () => {
    expect(PROFILE_COLS).not.toContain("*");
  });
});

describe("OPENING_SELECT", () => {
  const assignee = /assignee:assigned_to\(([^)]*)\)/.exec(OPENING_SELECT)?.[1];

  it("embeds the assignee profile by explicit column, not by wildcard", () => {
    expect(assignee).toBeDefined();
    expect(assignee).not.toContain("*");
  });

  it("embeds only columns the authenticated role may read", () => {
    for (const column of columnsOf(assignee ?? "")) {
      expect(GRANTED_SELECT_COLUMNS).toContain(column);
    }
  });

  it("never embeds a PIN column", () => {
    expect(assignee).not.toMatch(/\bpin/);
  });
});

describe("isMissingFunction", () => {
  it("recognises an RPC that the database does not have yet", () => {
    expect(isMissingFunction({ code: "PGRST202" })).toBe(true);
    expect(isMissingFunction({ code: "42883" })).toBe(true);
    expect(
      isMissingFunction({ message: 'function public.claim_owner_bootstrap() does not exist' }),
    ).toBe(true);
  });

  it("does not swallow a permission refusal", () => {
    expect(
      isMissingFunction({ code: "42501", message: "permission denied for function" }),
    ).toBe(false);
    expect(isMissingFunction(null)).toBe(false);
    expect(isMissingFunction("boom")).toBe(false);
  });
});
