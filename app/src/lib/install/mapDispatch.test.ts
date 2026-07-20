import { describe, expect, it } from "vitest";
import {
  buildSequenceAssignments,
  installerColorMap,
  installerInitials,
  INSTALLER_PALETTE,
  maxExistingSequence,
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
