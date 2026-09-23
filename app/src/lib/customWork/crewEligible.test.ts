import { describe, expect, it } from "vitest";
import { crewRecordEligible, type CrewPerson } from "./model";

const person = (over: Partial<CrewPerson>): CrewPerson => ({ id: "p", display_name: "P", active: true, role: "installer", is_partner: false, retired_at: null, access_revoked_at: null, ...over });

describe("who can be named on a crew record", () => {
  it("includes people marked Off today — availability is not login access", () => {
    expect(crewRecordEligible(person({ active: false }))).toBe(true);
    expect(crewRecordEligible(person({ active: false, role: "foreman" }))).toBe(true);
  });
  it("excludes removed, retired, partner and non-crew logins", () => {
    expect(crewRecordEligible(person({ access_revoked_at: "2026-09-01T00:00:00Z" }))).toBe(false);
    expect(crewRecordEligible(person({ retired_at: "2026-09-01T00:00:00Z" }))).toBe(false);
    expect(crewRecordEligible(person({ is_partner: true }))).toBe(false);
    expect(crewRecordEligible(person({ role: "partner" }))).toBe(false);
  });
});
