import { describe, expect, it } from "vitest";
import { formatLocalTime, toTimeInput } from "./companySettings";

describe("toTimeInput", () => {
  it("trims Postgres' seconds off a time so a time input accepts it", () => {
    expect(toTimeInput("17:30:00")).toBe("17:30");
    expect(toTimeInput("07:05:00")).toBe("07:05");
  });

  it("has nothing to say about nothing", () => {
    expect(toTimeInput(null)).toBe("");
    expect(toTimeInput(undefined)).toBe("");
  });
});

describe("formatLocalTime", () => {
  it("reads a stored time back as a clock face", () => {
    // The exact separator is the viewer's locale; the hour and minute are not.
    expect(formatLocalTime("17:30:00")).toMatch(/5[:.]30/);
    expect(formatLocalTime("07:05")).toMatch(/7[:.]05/);
  });

  it("says '—' rather than 'Invalid Date' for anything unusable", () => {
    expect(formatLocalTime(null)).toBe("—");
    expect(formatLocalTime("")).toBe("—");
    expect(formatLocalTime("half past five")).toBe("—");
  });
});
