import { describe, expect, it } from "vitest";
import type { TFn } from "../i18n";
import { agoLabel } from "./useSaveJobsOffline";

// A fake t() that shows the key and the numbers, so the test reads the choice.
const t: TFn = (key, vars) => `${key}${vars ? " " + JSON.stringify(vars) : ""}`;
const MIN = 60_000;

describe("agoLabel", () => {
  it("picks the unit a person would say", () => {
    const now = 1_000_000_000;
    expect(agoLabel(t, now - 20_000, now)).toBe("offline.justNow");
    expect(agoLabel(t, now - 12 * MIN, now)).toBe('offline.minAgo {"n":12}');
    expect(agoLabel(t, now - 3 * 60 * MIN, now)).toBe('offline.hoursAgo {"n":3}');
    expect(agoLabel(t, now - 2 * 24 * 60 * MIN, now)).toBe('offline.daysAgo {"n":2}');
  });

  it("never says a negative time when the clock moved", () => {
    expect(agoLabel(t, 5_000, 1_000)).toBe("offline.justNow");
  });
});
