import { describe, expect, it } from "vitest";
import { ANOMALY_THRESHOLD, isAnomaly } from "./heartbeat";

/**
 * The Heartbeat flags a running task as "long" when elapsed time exceeds the
 * learned median by the threshold multiple. No median → never a false alarm.
 */
describe("isAnomaly", () => {
  it("flags when elapsed exceeds median * threshold", () => {
    // 10-min window (600s), threshold 2.0 → anomaly past 1200s.
    expect(isAnomaly(1300, 600)).toBe(true);
    expect(isAnomaly(1201, 600)).toBe(true);
  });

  it("does not flag at or below the threshold multiple", () => {
    expect(isAnomaly(1200, 600)).toBe(false); // exactly 2x is not "over"
    expect(isAnomaly(900, 600)).toBe(false);
    expect(isAnomaly(0, 600)).toBe(false);
  });

  it("never flags without a usable median", () => {
    expect(isAnomaly(99999, null)).toBe(false);
    expect(isAnomaly(99999, undefined)).toBe(false);
    expect(isAnomaly(99999, 0)).toBe(false);
    expect(isAnomaly(99999, -5)).toBe(false);
  });

  it("honors a custom threshold", () => {
    // 10-min window, threshold 1.5 → anomaly past 900s.
    expect(isAnomaly(1000, 600, 1.5)).toBe(true);
    expect(isAnomaly(800, 600, 1.5)).toBe(false);
  });

  it("uses a 2.0 default threshold", () => {
    expect(ANOMALY_THRESHOLD).toBe(2.0);
    expect(isAnomaly(600 * ANOMALY_THRESHOLD + 1, 600)).toBe(true);
  });
});
