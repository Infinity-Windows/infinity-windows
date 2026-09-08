import { describe, expect, it } from "vitest";
import {
  SHEET_STAGES,
  nextSheetStage,
  sheetStageLabel,
  showBlockFold,
  showSiteNoteFold,
  showSummonFold,
  type SheetStage,
} from "./sheetStages";

describe("sheetStageLabel", () => {
  it("numbers each stage the way the stepper always has", () => {
    expect(sheetStageLabel("check")).toBe("1. Check");
    expect(sheetStageLabel("install")).toBe("2. Install");
    expect(sheetStageLabel("capture")).toBe("3. Capture");
  });
});

describe("nextSheetStage", () => {
  it("walks check -> install -> capture -> nowhere", () => {
    expect(nextSheetStage("check")).toBe("install");
    expect(nextSheetStage("install")).toBe("capture");
    expect(nextSheetStage("capture")).toBeNull();
  });
});

describe("showSiteNoteFold", () => {
  it("shows on check and capture, never install", () => {
    expect(showSiteNoteFold("check")).toBe(true);
    expect(showSiteNoteFold("capture")).toBe(true);
    expect(showSiteNoteFold("install")).toBe(false);
  });
});

describe("showSummonFold", () => {
  it("only folds the summon panel on the check stage", () => {
    expect(showSummonFold("check")).toBe(true);
    expect(showSummonFold("install")).toBe(false);
    expect(showSummonFold("capture")).toBe(false);
  });
});

describe("showBlockFold", () => {
  it("only offers Block while the install stage is on screen", () => {
    expect(showBlockFold("install")).toBe(true);
    expect(showBlockFold("check")).toBe(false);
    expect(showBlockFold("capture")).toBe(false);
  });
});

it("SHEET_STAGES stays in the order the stepper renders", () => {
  const order: SheetStage[] = ["check", "install", "capture"];
  expect(SHEET_STAGES).toEqual(order);
});
