import { describe, expect, it } from "vitest";
import {
  buildInstallerWorklist,
  buildSequenceAssignments,
  installerColorMap,
  installerInitials,
  INSTALLER_PALETTE,
  maxExistingSequence,
  orderNumberMap,
  reorderById,
  sortedAssignedIds,
  toggleSelection,
} from "./mapDispatch";

describe("installerColorMap", () => {
  it("assigns palette colors by index and is deterministic", () => {
    const a = installerColorMap(["x", "y", "z"]);
    const b = installerColorMap(["x", "y", "z"]);
    expect(a.get("x")).toBe(INSTALLER_PALETTE[0]);
    expect(a.get("y")).toBe(INSTALLER_PALETTE[1]);
    expect(a.get("z")).toBe(INSTALLER_PALETTE[2]);
    expect([...a.entries()]).toEqual([...b.entries()]);
  });

  it("cycles the palette when there are more installers than colors", () => {
    const ids = Array.from({ length: INSTALLER_PALETTE.length + 1 }, (_, i) => `i${i}`);
    const map = installerColorMap(ids);
    expect(map.get(`i${INSTALLER_PALETTE.length}`)).toBe(INSTALLER_PALETTE[0]);
  });

  it("ignores duplicate ids without shifting colors", () => {
    const map = installerColorMap(["x", "x", "y"]);
    expect(map.get("x")).toBe(INSTALLER_PALETTE[0]);
    expect(map.get("y")).toBe(INSTALLER_PALETTE[1]);
  });
});

describe("installerInitials", () => {
  it("single name → first letter", () => {
    expect(installerInitials("Ammon")).toBe("A");
  });
  it("two names → two letters", () => {
    expect(installerInitials("john doe")).toBe("JD");
  });
  it("empty → placeholder", () => {
    expect(installerInitials("   ")).toBe("?");
  });
});

describe("toggleSelection", () => {
  it("appends a new id to the end", () => {
    expect(toggleSelection(["a", "b"], "c")).toEqual(["a", "b", "c"]);
  });
  it("removes an existing id and preserves order (renumbering)", () => {
    expect(toggleSelection(["a", "b", "c"], "b")).toEqual(["a", "c"]);
  });
  it("does not mutate the input", () => {
    const input = ["a"];
    toggleSelection(input, "b");
    expect(input).toEqual(["a"]);
  });
});

describe("maxExistingSequence", () => {
  const openings = [
    { id: "1", assigned_to: "ammon", sequence: 1 },
    { id: "2", assigned_to: "ammon", sequence: 3 },
    { id: "3", assigned_to: "taylor", sequence: 9 },
    { id: "4", assigned_to: "ammon", sequence: null },
  ];
  it("returns the installer's highest sequence", () => {
    expect(maxExistingSequence(openings, "ammon")).toBe(3);
  });
  it("returns 0 when the installer has no sequenced work", () => {
    expect(maxExistingSequence(openings, "nobody")).toBe(0);
  });
  it("ignores openings being reassigned", () => {
    expect(maxExistingSequence(openings, "ammon", ["2"])).toBe(1);
  });
});

describe("buildSequenceAssignments", () => {
  it("numbers 1..N in tap order when starting fresh", () => {
    expect(buildSequenceAssignments(["a", "b", "c"])).toEqual([
      { openingId: "a", sequence: 1 },
      { openingId: "b", sequence: 2 },
      { openingId: "c", sequence: 3 },
    ]);
  });
  it("appends after an installer's existing max sequence", () => {
    expect(buildSequenceAssignments(["x", "y"], 3)).toEqual([
      { openingId: "x", sequence: 4 },
      { openingId: "y", sequence: 5 },
    ]);
  });
  it("returns empty for an empty selection", () => {
    expect(buildSequenceAssignments([])).toEqual([]);
  });
});

describe("sortedAssignedIds", () => {
  const openings = [
    { id: "b", assigned_to: "ammon", sequence: 2 },
    { id: "a", assigned_to: "ammon", sequence: 1 },
    { id: "t", assigned_to: "taylor", sequence: 1 },
    { id: "n", assigned_to: "ammon", sequence: null },
    { id: "c", assigned_to: "ammon", sequence: 3 },
  ];
  it("returns the installer's ids in saved sequence order, nulls last", () => {
    expect(sortedAssignedIds(openings, "ammon")).toEqual(["a", "b", "c", "n"]);
  });
  it("excludes ids being (re)assigned now", () => {
    expect(sortedAssignedIds(openings, "ammon", ["b"])).toEqual(["a", "c", "n"]);
  });
  it("returns empty for an installer with no work", () => {
    expect(sortedAssignedIds(openings, "nobody")).toEqual([]);
  });
});

describe("buildInstallerWorklist", () => {
  const openings = [
    { id: "a", assigned_to: "ammon", sequence: 1 },
    { id: "b", assigned_to: "ammon", sequence: 2 },
    { id: "t", assigned_to: "taylor", sequence: 5 },
    { id: "new1", assigned_to: null, sequence: null },
    { id: "new2", assigned_to: null, sequence: null },
  ];
  it("numbers existing (by sequence) then new taps continuously", () => {
    expect(buildInstallerWorklist(openings, "ammon", ["new1", "new2"])).toEqual([
      { id: "a", order: 1, isNew: false, sequence: 1 },
      { id: "b", order: 2, isNew: false, sequence: 2 },
      { id: "new1", order: 3, isNew: true, sequence: null },
      { id: "new2", order: 4, isNew: true, sequence: null },
    ]);
  });
  it("treats a re-tapped already-assigned opening as new (appended)", () => {
    expect(buildInstallerWorklist(openings, "ammon", ["a"])).toEqual([
      { id: "b", order: 1, isNew: false, sequence: 2 },
      { id: "a", order: 2, isNew: true, sequence: null },
    ]);
  });
  it("is just the existing route when nothing is tapped", () => {
    expect(buildInstallerWorklist(openings, "ammon", [])).toEqual([
      { id: "a", order: 1, isNew: false, sequence: 1 },
      { id: "b", order: 2, isNew: false, sequence: 2 },
    ]);
  });
});

describe("reorderById", () => {
  it("moves an id up", () => {
    expect(reorderById(["a", "b", "c"], "b", -1)).toEqual(["b", "a", "c"]);
  });
  it("moves an id down", () => {
    expect(reorderById(["a", "b", "c"], "b", 1)).toEqual(["a", "c", "b"]);
  });
  it("is a no-op past the top edge", () => {
    expect(reorderById(["a", "b", "c"], "a", -1)).toEqual(["a", "b", "c"]);
  });
  it("is a no-op past the bottom edge", () => {
    expect(reorderById(["a", "b", "c"], "c", 1)).toEqual(["a", "b", "c"]);
  });
  it("is a no-op for an unknown id and does not mutate input", () => {
    const input = ["a", "b"];
    expect(reorderById(input, "z", 1)).toEqual(["a", "b"]);
    expect(input).toEqual(["a", "b"]);
  });
});

describe("orderNumberMap", () => {
  it("maps each id to its 1..N position", () => {
    const map = orderNumberMap(["x", "y", "z"]);
    expect(map.get("x")).toBe(1);
    expect(map.get("y")).toBe(2);
    expect(map.get("z")).toBe(3);
  });
  it("keeps the first position for a duplicated id", () => {
    expect(orderNumberMap(["x", "y", "x"]).get("x")).toBe(1);
  });
});
