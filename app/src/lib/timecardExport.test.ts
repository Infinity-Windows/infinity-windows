import { describe, expect, it } from "vitest";
import {
  buildTimecardCsv,
  buildTimecardRows,
  buildTimecardTsv,
  type TimecardExportShift,
} from "./timecardExport";

function s(partial: Partial<TimecardExportShift>): TimecardExportShift {
  return {
    employee: "Alex Rivera",
    day: "2026-01-05",
    start: "8:00 AM",
    end: "4:30 PM",
    hours: 8,
    job: "W-1001",
    costCode: "100 - Install - windows",
    status: "approved",
    ...partial,
  };
}

const payload = {
  periodLabel: "Jan 5 – Jan 11",
  shifts: [
    s({ employee: "Alex Rivera", hours: 8, costCode: "100 - Install - windows" }),
    s({ employee: "Alex Rivera", day: "2026-01-06", hours: 4, costCode: "900 - Travel" }),
    s({ employee: "Bo Chen", hours: 6.5, costCode: "100 - Install - windows" }),
  ],
};

describe("buildTimecardRows", () => {
  it("emits a per-person total that sums each employee's hours", () => {
    const rows = buildTimecardRows(payload);
    const flat = rows.map((r) => r.join("|"));
    const personIdx = flat.findIndex((r) => r.startsWith("Totals per person"));
    expect(personIdx).toBeGreaterThan(-1);
    const alex = rows.find(
      (r, i) => i > personIdx && r[0] === "Alex Rivera",
    );
    expect(alex?.[4]).toBe("12.00"); // 8 + 4
    const bo = rows.find((r, i) => i > personIdx && r[0] === "Bo Chen");
    expect(bo?.[4]).toBe("6.50");
  });

  it("emits a per-cost-code total that sums across people", () => {
    const rows = buildTimecardRows(payload);
    const codeIdx = rows.findIndex((r) => r[0] === "Totals per cost code");
    const install = rows.find(
      (r, i) => i > codeIdx && r[0] === "100 - Install - windows",
    );
    expect(install?.[4]).toBe("14.50"); // 8 + 6.5
    const travel = rows.find((r, i) => i > codeIdx && r[0] === "900 - Travel");
    expect(travel?.[4]).toBe("4.00");
  });

  it("emits a grand total across every shift", () => {
    const rows = buildTimecardRows(payload);
    const grand = rows.find((r) => r[0] === "Grand total");
    expect(grand?.[4]).toBe("18.50");
  });
});

describe("serializers", () => {
  it("prefixes CSV with a UTF-8 BOM and quotes commas", () => {
    const csv = buildTimecardCsv({
      periodLabel: "wk",
      shifts: [s({ job: "W-1, Elm St" })],
    });
    expect(csv.startsWith("\uFEFF")).toBe(true);
    expect(csv).toContain('"W-1, Elm St"');
  });

  it("produces tab-delimited rows with no BOM for Sheets paste", () => {
    const tsv = buildTimecardTsv(payload);
    expect(tsv.startsWith("\uFEFF")).toBe(false);
    expect(tsv.split("\n")[0]).toContain("\t");
  });
});

describe("overtime section", () => {
  it("appears only when a split is provided, with per-person rows", () => {
    const withOt = buildTimecardRows({
      periodLabel: "wk",
      shifts: [s({})],
      overtime: [
        { employee: "Ben", regular: 40, overtime: 5, doubleTime: 0 },
        { employee: "Ammon", regular: 32, overtime: 0, doubleTime: 0 },
      ],
    });
    const header = withOt.findIndex((r) => r[0] === "Overtime split");
    expect(header).toBeGreaterThan(-1);
    expect(withOt[header][4]).toBe("Regular");
    // Sorted by name: Ammon before Ben.
    expect(withOt[header + 1][0]).toBe("Ammon");
    expect(withOt[header + 2].slice(4, 7)).toEqual(["40.00", "5.00", "0.00"]);

    const without = buildTimecardRows({ periodLabel: "wk", shifts: [s({})] });
    expect(without.some((r) => r[0] === "Overtime split")).toBe(false);
  });
});
