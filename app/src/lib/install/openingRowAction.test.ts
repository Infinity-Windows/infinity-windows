import { describe, expect, it } from "vitest";
import {
  openingFullSheetPath,
  openingRowLabel,
  showsVoidedInstall,
  toggleExpandedOpening,
} from "./openingRowAction";

describe("toggleExpandedOpening", () => {
  it("opens a closed row", () => {
    expect(toggleExpandedOpening(null, "o1")).toBe("o1");
  });

  it("closes the row that is already open", () => {
    expect(toggleExpandedOpening("o1", "o1")).toBe(null);
  });

  it("swaps straight to another row without an extra tap", () => {
    expect(toggleExpandedOpening("o1", "o2")).toBe("o2");
  });
});

describe("openingRowLabel", () => {
  it("names the opening and its mark", () => {
    expect(openingRowLabel("12-2")).toBe("Open details for 12-2, mark 12");
  });

  it("does not repeat the mark when the code IS the mark", () => {
    expect(openingRowLabel("18A")).toBe("Open details for 18A");
    expect(openingRowLabel("10")).toBe("Open details for 10");
  });

  it("tolerates a leading # and stray spacing from the plans", () => {
    expect(openingRowLabel(" #1-1 ")).toBe("Open details for 1-1, mark 1");
  });

  it("still reads as something when the code is missing", () => {
    expect(openingRowLabel("")).toBe("Open details for this opening");
  });
});

describe("openingFullSheetPath", () => {
  it("points at the opening sheet route", () => {
    expect(openingFullSheetPath("p1", "o1")).toBe("/projects/p1/opening/o1");
  });
});

describe("showsVoidedInstall", () => {
  const voided = new Set(["o1"]);

  it("is hidden from installers", () => {
    expect(
      showsVoidedInstall("installer", { id: "o1", status: "planned" }, voided),
    ).toBe(false);
    expect(showsVoidedInstall(null, { id: "o1", status: "planned" }, voided)).toBe(
      false,
    );
  });

  it("shows for foreman and above", () => {
    for (const role of ["foreman", "lead", "supervisor", "owner"]) {
      expect(
        showsVoidedInstall(role, { id: "o1", status: "planned" }, voided),
      ).toBe(true);
    }
  });

  it("is not shown once the opening is installed again", () => {
    expect(
      showsVoidedInstall("foreman", { id: "o1", status: "installed" }, voided),
    ).toBe(false);
  });

  it("is not shown for openings that were never undone", () => {
    expect(
      showsVoidedInstall("foreman", { id: "o2", status: "planned" }, voided),
    ).toBe(false);
  });
});
