// updateProject writes ONLY the columns the caller named.
//
// This test exists because of a real bug, not a hypothetical one. The patch
// used to be built from all nine detail columns every time, and a field the
// caller left out became an explicit null — so wave J's Pipeline card, which
// saves an expected start date and nothing else, was sending "erase the
// address, the customer, the phone, the email, the state, the unit number, the
// end date and the notes" along with it. Every one of those columns is on wave
// D's update grant, so the database accepted it without a word.
//
// The one caller that predates the Pipeline card names every field, which is
// why nothing broke for a year. The last test below pins that behaviour too:
// a form that deliberately empties a field must still be able to.

import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  patches: [] as Record<string, unknown>[],
}));

vi.mock("./supabase", () => {
  const builder: Record<string, unknown> = {};
  builder.update = (patch: Record<string, unknown>) => {
    db.patches.push(patch);
    return builder;
  };
  builder.eq = () => builder;
  builder.select = () => builder;
  builder.single = () => Promise.resolve({ data: { id: "p1" }, error: null });
  return {
    supabase: { from: () => builder },
    supabaseConfigured: true,
  };
});

import { updateProject } from "./api";

describe("updateProject", () => {
  beforeEach(() => {
    db.patches = [];
  });

  it("sends only start_date when only the start date was given", async () => {
    await updateProject("p1", { startDate: "2026-09-22" });
    expect(db.patches).toHaveLength(1);
    expect(db.patches[0]).toEqual({ start_date: "2026-09-22" });
  });

  it("clears the start date without touching anything else", async () => {
    await updateProject("p1", { startDate: null });
    expect(db.patches[0]).toEqual({ start_date: null });
  });

  it("leaves the contact fields alone when the caller never mentions them", async () => {
    await updateProject("p1", { startDate: "2026-09-22" });
    const patch = db.patches[0];
    for (const column of [
      "address",
      "customer_name",
      "contact_phone",
      "contact_email",
      "site_state",
      "unit_number",
      "end_date",
      "notes",
      "name",
    ]) {
      expect(patch).not.toHaveProperty(column);
    }
  });

  it("still writes every column the job details form names, blanks included", async () => {
    await updateProject("p1", {
      name: "Sand Hollow",
      address: "1 Main St",
      customerName: "",
      contactPhone: "555-0100",
      contactEmail: "",
      siteState: "ut",
      unitNumber: "",
      startDate: "2026-09-22",
      endDate: "",
      notes: "gate code 1234",
    });
    expect(db.patches[0]).toEqual({
      name: "Sand Hollow",
      address: "1 Main St",
      customer_name: null,
      contact_phone: "555-0100",
      contact_email: null,
      site_state: "UT",
      unit_number: null,
      start_date: "2026-09-22",
      end_date: null,
      notes: "gate code 1234",
    });
  });

  it("refuses a save that names nothing rather than sending an empty patch", async () => {
    await expect(updateProject("p1", {})).rejects.toThrow(/Nothing to save/);
    expect(db.patches).toHaveLength(0);
  });

  it("still refuses a blank name", async () => {
    await expect(updateProject("p1", { name: "   " })).rejects.toThrow(/name is required/i);
  });
});
