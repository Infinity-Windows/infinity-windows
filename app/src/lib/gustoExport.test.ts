import { describe, expect, it } from "vitest";
import {
  GUSTO_COLUMNS,
  buildGustoCsv,
  buildGustoRows,
  gustoFileName,
  splitDisplayName,
} from "./gustoExport";

const ROWS = [
  { firstName: "Ana", lastName: "Ruiz", regular: 80, overtime: 6.5, doubleOvertime: 0 },
  { firstName: "Ben", lastName: "", regular: 72.25, overtime: 0, doubleOvertime: 2 },
];

describe("splitDisplayName", () => {
  it("takes the first word as the given name and the rest as the surname", () => {
    expect(splitDisplayName("Ana Ruiz")).toEqual({ firstName: "Ana", lastName: "Ruiz" });
    expect(splitDisplayName("Jose Ramirez Diaz")).toEqual({
      firstName: "Jose",
      lastName: "Ramirez Diaz",
    });
  });

  it("keeps a one-word name whole rather than inventing a surname", () => {
    expect(splitDisplayName("Tiny")).toEqual({ firstName: "Tiny", lastName: "" });
  });

  it("survives stray whitespace and an empty name", () => {
    expect(splitDisplayName("  Ana   Ruiz  ")).toEqual({
      firstName: "Ana",
      lastName: "Ruiz",
    });
    expect(splitDisplayName("   ")).toEqual({ firstName: "", lastName: "" });
  });
});

describe("buildGustoRows", () => {
  it("leads with Gusto's own column names", () => {
    expect(buildGustoRows([])).toEqual([[...GUSTO_COLUMNS]]);
  });

  it("writes one row per employee, hours as decimals", () => {
    const rows = buildGustoRows(ROWS);
    expect(rows).toHaveLength(3);
    expect(rows[1]).toEqual(["Ana", "Ruiz", "80.00", "6.50", "0.00"]);
    expect(rows[2]).toEqual(["Ben", "", "72.25", "0.00", "2.00"]);
  });
});

describe("buildGustoCsv", () => {
  it("is a clean table: a BOM, a header line, then the people", () => {
    const csv = buildGustoCsv(ROWS);
    expect(csv.startsWith("﻿")).toBe(true);
    const lines = csv.slice(1).split("\r\n");
    expect(lines[0]).toBe(
      "First name,Last name,Regular hours,Overtime hours,Double overtime",
    );
    expect(lines[1]).toBe("Ana,Ruiz,80.00,6.50,0.00");
    expect(lines).toHaveLength(3);
  });

  it("carries no comment rows an importer would read as data", () => {
    expect(buildGustoCsv(ROWS)).not.toContain("#");
  });

  it("quotes a name with a comma in it", () => {
    const csv = buildGustoCsv([
      { firstName: "Ana", lastName: "Ruiz, Jr", regular: 1, overtime: 0, doubleOvertime: 0 },
    ]);
    expect(csv).toContain('"Ruiz, Jr"');
  });
});

describe("gustoFileName", () => {
  it("names the file after the period it covers", () => {
    expect(gustoFileName("2026-09-07T06:00:00.000Z")).toBe("gusto-hours-2026-09-07.csv");
  });
});
