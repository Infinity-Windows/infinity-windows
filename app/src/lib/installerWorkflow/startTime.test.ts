import { describe, expect, it } from "vitest";
import { workStartTime } from "./startTime";

describe("the time recorded for a work start", () => {
  // The case from 2026-11-20: the server stamped the clock-in at :36.785 and
  // the device, 2.6 s behind, stamped the first tap at :34.967.
  it("is the shift's clock-in when the phone's tap reads earlier than it", () => {
    const tap = Date.parse("2026-11-20T20:53:34.967Z");
    const started = workStartTime(tap, "2026-11-20T20:53:36.785+00:00");
    expect(started).toBe("2026-11-20T20:53:36.785+00:00");
    // What the server checks: the shift must not begin after the start.
    expect(Date.parse("2026-11-20T20:53:36.785+00:00") > Date.parse(started)).toBe(false);
  });

  it("is the tap once the shift is already running", () => {
    const tap = Date.parse("2026-11-20T20:55:34.000Z");
    expect(workStartTime(tap, "2026-11-20T20:53:36.785+00:00")).toBe("2026-11-20T20:55:34.000Z");
  });
});
