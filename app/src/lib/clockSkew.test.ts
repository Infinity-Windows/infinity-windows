// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import {
  CLOCK_SKEW_WARN_MS,
  clockSkewDismissedToday,
  clockSkewMs,
  dismissClockSkewToday,
  isClockSkewed,
} from "./clockSkew";

describe("clockSkewMs", () => {
  it("is positive when the device is ahead of the server", () => {
    expect(clockSkewMs(1_000_000, 900_000)).toBe(100_000);
  });
  it("is negative when the device is behind the server", () => {
    expect(clockSkewMs(900_000, 1_000_000)).toBe(-100_000);
  });
  it("is zero when they agree", () => {
    expect(clockSkewMs(1_000_000, 1_000_000)).toBe(0);
  });
});

describe("isClockSkewed", () => {
  it("is false right at the threshold", () => {
    expect(isClockSkewed(CLOCK_SKEW_WARN_MS)).toBe(false);
    expect(isClockSkewed(-CLOCK_SKEW_WARN_MS)).toBe(false);
  });
  it("is true just past the threshold in either direction", () => {
    expect(isClockSkewed(CLOCK_SKEW_WARN_MS + 1)).toBe(true);
    expect(isClockSkewed(-CLOCK_SKEW_WARN_MS - 1)).toBe(true);
  });
  it("is false for a small, believable skew", () => {
    expect(isClockSkewed(30_000)).toBe(false);
  });
});

describe("clockSkewDismissedToday / dismissClockSkewToday", () => {
  afterEach(() => {
    localStorage.clear();
  });

  it("is not dismissed until dismissed", () => {
    expect(clockSkewDismissedToday("2026-08-25")).toBe(false);
  });

  it("remembers a dismissal for that exact day only", () => {
    dismissClockSkewToday("2026-08-25");
    expect(clockSkewDismissedToday("2026-08-25")).toBe(true);
    expect(clockSkewDismissedToday("2026-08-26")).toBe(false);
  });
});
