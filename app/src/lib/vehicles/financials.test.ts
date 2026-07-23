import { describe, expect, it } from "vitest";
import { canSeeFinancials } from "./financials";

describe("canSeeFinancials (UI gate)", () => {
  it("shows only to a real owner who is not previewing", () => {
    expect(canSeeFinancials({ realRole: "owner", isPreviewing: false })).toBe(true);
  });

  it("hides while an owner previews another role", () => {
    expect(canSeeFinancials({ realRole: "owner", isPreviewing: true })).toBe(false);
  });

  it("hides for every non-owner real role", () => {
    for (const role of ["installer", "foreman", "supervisor", null, undefined]) {
      expect(canSeeFinancials({ realRole: role, isPreviewing: false })).toBe(false);
    }
  });

  it("maps the legacy owner name", () => {
    expect(canSeeFinancials({ realRole: "big_boss", isPreviewing: false })).toBe(true);
  });
});
