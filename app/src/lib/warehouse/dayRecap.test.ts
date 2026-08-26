import { describe, expect, it } from "vitest";
import { dayRecap, isRecapQuiet, localMidnightIso } from "./dayRecap";

describe("dayRecap", () => {
  it("tallies received/stored/checked_out events and ignores everything else", () => {
    const r = dayRecap(
      [
        { event: "received" },
        { event: "received" },
        { event: "stored" },
        { event: "checked_out" },
        { event: "override" }, // an undo — not counted as its own bucket
        { event: "damaged" },
        { event: "preissued" },
      ],
      [],
      [],
    );
    expect(r.checkedIn).toBe(2);
    expect(r.stored).toBe(1);
    expect(r.checkedOut).toBe(1);
  });

  it("groups still-missing packages by their delivery's label", () => {
    const r = dayRecap(
      [],
      [
        { status: "minted", delivery_id: "d1" },
        { status: "minted", delivery_id: "d1" },
        { status: "minted", delivery_id: "d2" },
        { status: "stored", delivery_id: "d1" }, // arrived — not missing
      ],
      [
        { id: "d1", label: "Tech Ridge truck" },
        { id: "d2", label: "Aug 22 truck" },
      ],
    );
    expect(r.missingByDelivery).toEqual([
      { label: "Tech Ridge truck", count: 2 },
      { label: "Aug 22 truck", count: 1 },
    ]);
  });

  it("sorts the missing list by count, ties broken alphabetically", () => {
    const r = dayRecap(
      [],
      [
        { status: "minted", delivery_id: "a" },
        { status: "minted", delivery_id: "b" },
      ],
      [
        { id: "a", label: "Zebra truck" },
        { id: "b", label: "Alpha truck" },
      ],
    );
    // Tied at 1 each — alphabetical.
    expect(r.missingByDelivery.map((m) => m.label)).toEqual(["Alpha truck", "Zebra truck"]);
  });

  it("leaves out a minted package with no delivery at all", () => {
    // e.g. mintMarkPackages — a window declared ahead of any truck. There is
    // no delivery to be "missing from", so it does not get invented a bucket.
    const r = dayRecap([], [{ status: "minted", delivery_id: null }], []);
    expect(r.missingByDelivery).toEqual([]);
  });

  it("leaves out a minted package whose delivery isn't in the given list", () => {
    // listDeliveries caps at the 20 most recent — an older delivery simply
    // isn't in the map handed to this pure function.
    const r = dayRecap([], [{ status: "minted", delivery_id: "old" }], []);
    expect(r.missingByDelivery).toEqual([]);
  });

  it("never counts a received/stored/checked_out package as missing", () => {
    const r = dayRecap(
      [],
      [
        { status: "received", delivery_id: "d1" },
        { status: "stored", delivery_id: "d1" },
        { status: "checked_out", delivery_id: "d1" },
        { status: "blank", delivery_id: null },
      ],
      [{ id: "d1", label: "Tech Ridge truck" }],
    );
    expect(r.missingByDelivery).toEqual([]);
  });
});

describe("isRecapQuiet", () => {
  it("is quiet when every count and the backlog are zero", () => {
    expect(isRecapQuiet({ checkedIn: 0, stored: 0, checkedOut: 0, missingByDelivery: [] })).toBe(
      true,
    );
  });

  it("is not quiet when any one thing happened", () => {
    expect(isRecapQuiet({ checkedIn: 1, stored: 0, checkedOut: 0, missingByDelivery: [] })).toBe(
      false,
    );
    expect(
      isRecapQuiet({
        checkedIn: 0,
        stored: 0,
        checkedOut: 0,
        missingByDelivery: [{ label: "Tech Ridge truck", count: 2 }],
      }),
    ).toBe(false);
  });
});

describe("localMidnightIso", () => {
  it("returns the start of the given local day", () => {
    const now = new Date(2026, 7, 25, 14, 30, 0); // Aug 25, 2026, 2:30pm local
    const iso = localMidnightIso(now);
    const parsed = new Date(iso);
    expect(parsed.getFullYear()).toBe(2026);
    expect(parsed.getMonth()).toBe(7);
    expect(parsed.getDate()).toBe(25);
    expect(parsed.getHours()).toBe(0);
    expect(parsed.getMinutes()).toBe(0);
    expect(parsed.getSeconds()).toBe(0);
  });
});
