import { describe, expect, it } from "vitest";
import { billToCells, canManageBillTo, canSeeBillTo, type ProjectBillTo } from "./billTo";

// The screen's copy of can_see_bill_to / can_manage_bill_to (20261034000000).
// The database is the lock; these only decide what a screen offers, so they
// must never say yes where the database says no.
describe("who sees and who changes a job's bill-to", () => {
  it("shows it to supervisors and the owner, legacy names included", () => {
    for (const role of ["supervisor", "admin", "owner", "big_boss"]) {
      expect(canSeeBillTo(role, {})).toBe(true);
    }
  });

  it("shows it to anybody the owner granted Sees costs, whatever their rank", () => {
    expect(canSeeBillTo("installer", { costs: true })).toBe(true);
    expect(canSeeBillTo("foreman", { costs: true })).toBe(true);
  });

  it("hides it from foremen, installers and an unknown or loading role", () => {
    for (const role of ["foreman", "lead", "installer", null, undefined, "partner"]) {
      expect(canSeeBillTo(role, {})).toBe(false);
    }
    // Sees pay rates is a different door.
    expect(canSeeBillTo("foreman", { pay: true })).toBe(false);
  });

  it("lets only supervisors and the owner change it; Sees costs reads and nothing more", () => {
    expect(canManageBillTo("supervisor")).toBe(true);
    expect(canManageBillTo("owner")).toBe(true);
    expect(canManageBillTo("foreman")).toBe(false);
    expect(canManageBillTo("installer")).toBe(false);
    expect(canManageBillTo(null)).toBe(false);
  });
});

describe("the two export cells", () => {
  const row = (customer: ProjectBillTo["customer"]): ProjectBillTo => ({
    project_id: "job-1", bill_to_customer_id: "c-1", updated_at: "2026-09-26T00:00:00Z", customer,
  });

  it("is the list name exactly, then the bare QuickBooks id", () => {
    expect(billToCells(row({ id: "c-1", name: "STG Windows and Doors", quickbooks_customer_id: "1234", retired_at: null })))
      .toEqual({ name: "STG Windows and Doors", quickbooksId: "1234" });
  });

  it("writes a blank id until somebody types one, and keeps a retired customer's name", () => {
    expect(billToCells(row({ id: "c-2", name: "Strata", quickbooks_customer_id: null, retired_at: "2026-09-26T00:00:00Z" })))
      .toEqual({ name: "Strata", quickbooksId: "" });
  });

  it("is blank, never a guess, when the customer could not be read", () => {
    expect(billToCells(row(null))).toEqual({ name: "", quickbooksId: "" });
  });
});
