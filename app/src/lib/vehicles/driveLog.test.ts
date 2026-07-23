import { describe, expect, it } from "vitest";
import { buildDriveLogCsv, buildDriveLogRows, canSeeDriveLog, type DriveLogRow } from "./driveLog";

describe("canSeeDriveLog (UI gate)", () => {
  it("shows to a real supervisor/owner who is not previewing", () => {
    expect(canSeeDriveLog({ realRole: "owner", isPreviewing: false })).toBe(true);
    expect(canSeeDriveLog({ realRole: "supervisor", isPreviewing: false })).toBe(true);
    expect(canSeeDriveLog({ realRole: "admin", isPreviewing: false })).toBe(true);
    expect(canSeeDriveLog({ realRole: "big_boss", isPreviewing: false })).toBe(true);
  });

  it("hides while an owner previews another role", () => {
    expect(canSeeDriveLog({ realRole: "owner", isPreviewing: true })).toBe(false);
  });

  it("hides for foreman/installer and unknown roles", () => {
    for (const role of ["foreman", "lead", "installer", null, undefined]) {
      expect(canSeeDriveLog({ realRole: role, isPreviewing: false })).toBe(false);
    }
  });
});

describe("buildDriveLogRows / CSV", () => {
  const rows: DriveLogRow[] = [
    {
      day: "2026-03-10",
      start: "8:00 AM",
      end: "8:45 AM",
      duration: "0:45:00",
      distance_miles: 12.5,
      duration_seconds: 2700,
      business: true,
      driver: "Sam Diaz",
    },
    {
      day: "2026-03-11",
      start: "6:00 PM",
      end: "6:20 PM",
      duration: "0:20:00",
      distance_miles: 4,
      duration_seconds: 1200,
      business: false,
      driver: "Sam Diaz",
    },
  ];

  it("emits a header, detail rows, and business/personal/all totals", () => {
    const out = buildDriveLogRows({ vehicleLabel: "2020 Ford F-150", year: 2026, rows });
    expect(out[0][0]).toContain("2020 Ford F-150");
    expect(out[0][1]).toBe("2026");
    // Detail rows tag business vs personal
    const businessRow = out.find((r) => r[0] === "2026-03-10");
    expect(businessRow?.[5]).toBe("Business");
    const personalRow = out.find((r) => r[0] === "2026-03-11");
    expect(personalRow?.[5]).toBe("Personal");
    // Write-off total = business only (12.50 miles, 0.75 hr)
    const writeOff = out.find((r) => r[0] === "Business total (write-off)");
    expect(writeOff?.[4]).toBe("12.50");
    expect(writeOff?.[3]).toBe("0.75");
    const personalTotal = out.find((r) => r[0] === "Personal total (not counted)");
    expect(personalTotal?.[4]).toBe("4.00");
    const all = out.find((r) => r[0] === "All drives");
    expect(all?.[4]).toBe("16.50");
  });

  it("serializes to CSV with a BOM", () => {
    const csv = buildDriveLogCsv({ vehicleLabel: "Truck", year: 2026, rows });
    expect(csv.startsWith("\uFEFF")).toBe(true);
    expect(csv).toContain("Business");
    expect(csv).toContain("2026-03-10");
  });
});
