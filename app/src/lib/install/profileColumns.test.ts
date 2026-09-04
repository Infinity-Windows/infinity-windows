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
  // 20260978000000_money_doors.sql granted SELECT on the two money grants
  // (wave Z, Z1). Readable so the Roster can draw the checkboxes and canAccess
  // can open /costing for a granted person; never UPDATE — set_profile_grants
  // is the one writer, exactly like role, pin_hash and language before it.
  "can_see_costs",
  "can_see_pay",
  // 20260987000000 granted SELECT (retired_at, retired_by) to the authenticated
  // role. Only retired_at is asked for here: the roster needs to know a login
  // was removed for good, so it can grey the row and keep the person out of
  // every picker; WHO removed it is an owner's question and is read off
  // crew_access_directory on the Crew access screen. Never UPDATE — the
  // manage-crew-access edge function is the one writer, like access_revoked_at.
  "retired_at",
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
