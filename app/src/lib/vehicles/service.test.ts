import { describe, expect, it } from "vitest";
import { daysUntil, serviceBadge, serviceLevel } from "./service";

describe("daysUntil", () => {
  it("is signed and timezone-stable", () => {
    expect(daysUntil("2026-07-23", "2026-07-24")).toBe(1);
    expect(daysUntil("2026-07-23", "2026-07-23")).toBe(0);
    expect(daysUntil("2026-07-23", "2026-07-20")).toBe(-3);
  });

  it("returns NaN for malformed input", () => {
    expect(Number.isNaN(daysUntil("nope", "2026-07-24"))).toBe(true);
  });
});

describe("serviceLevel (date-based)", () => {
  const today = "2026-07-23";
  it("flags a past next-service date as overdue", () => {
    expect(serviceLevel({ todayISO: today, nextServiceDate: "2026-07-01" })).toBe("overdue");
  });
  it("flags within the soon window as due_soon", () => {
    expect(serviceLevel({ todayISO: today, nextServiceDate: "2026-07-30" })).toBe("due_soon");
    expect(serviceLevel({ todayISO: today, nextServiceDate: "2026-07-23" })).toBe("due_soon");
  });
  it("is ok when comfortably in the future", () => {
    expect(serviceLevel({ todayISO: today, nextServiceDate: "2026-09-01" })).toBe("ok");
  });
  it("is none when no signals are present", () => {
    expect(serviceLevel({ todayISO: today })).toBe("none");
  });
});

describe("serviceLevel (mileage-based)", () => {
  const today = "2026-07-23";
  it("overdue when odometer reached the target", () => {
    expect(
      serviceLevel({ todayISO: today, odometer: 60000, nextServiceOdometer: 60000 }),
    ).toBe("overdue");
    expect(
      serviceLevel({ todayISO: today, odometer: 61000, nextServiceOdometer: 60000 }),
    ).toBe("overdue");
  });
  it("due_soon within the mile window", () => {
    expect(
      serviceLevel({ todayISO: today, odometer: 59800, nextServiceOdometer: 60000 }),
    ).toBe("due_soon");
  });
  it("ok when far from the target", () => {
    expect(
      serviceLevel({ todayISO: today, odometer: 40000, nextServiceOdometer: 60000 }),
    ).toBe("ok");
  });
});

describe("serviceLevel (combined severity)", () => {
  it("takes the most severe of date and mileage", () => {
    // date is ok, mileage is overdue → overdue
    expect(
      serviceLevel({
        todayISO: "2026-07-23",
        nextServiceDate: "2026-12-01",
        odometer: 60000,
        nextServiceOdometer: 60000,
      }),
    ).toBe("overdue");
  });
});

describe("serviceBadge", () => {
  const today = "2026-07-23";
  it("returns null when nothing needs surfacing", () => {
    expect(serviceBadge({ todayISO: today, nextServiceDate: "2026-12-01" })).toBeNull();
    expect(serviceBadge({ todayISO: today })).toBeNull();
  });
  it("labels overdue and due-soon with tones", () => {
    expect(serviceBadge({ todayISO: today, nextServiceDate: "2026-07-01" })).toEqual({
      label: "Service overdue",
      tone: "overdue",
    });
    expect(serviceBadge({ todayISO: today, nextServiceDate: "2026-07-25" })).toEqual({
      label: "Service in 2d",
      tone: "due_soon",
    });
    expect(serviceBadge({ todayISO: today, nextServiceDate: "2026-07-23" })).toEqual({
      label: "Service due today",
      tone: "due_soon",
    });
  });
  it("uses a generic due-soon label for mileage-only signals", () => {
    expect(
      serviceBadge({ todayISO: today, odometer: 59900, nextServiceOdometer: 60000 }),
    ).toEqual({ label: "Service due soon", tone: "due_soon" });
  });
});
