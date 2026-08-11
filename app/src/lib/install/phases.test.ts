import { describe, expect, it } from "vitest";
import { flashingOutstanding, type OpeningPhase } from "./phases";

const phase = (over: Partial<OpeningPhase>): OpeningPhase => ({
  id: "ph1",
  opening_id: "op1",
  kind: "flashing",
  status: "active",
  started_at: "2026-08-11T12:00:00Z",
  started_by: "ben",
  submitted_at: null,
  submitted_by: null,
  minutes: null,
  photo_path: null,
  ...over,
});

describe("flashingOutstanding (the install gate)", () => {
  it("a required flashing with no submitted phase blocks the install", () => {
    expect(flashingOutstanding({ needs_flashing: true }, [])).toBe(true);
    // A running clock is not a submitted phase - the photo is the proof.
    expect(flashingOutstanding({ needs_flashing: true }, [phase({})])).toBe(true);
  });

  it("a submitted flashing clears the gate", () => {
    expect(
      flashingOutstanding({ needs_flashing: true }, [
        phase({ status: "submitted", photo_path: "p/x.jpg" }),
      ]),
    ).toBe(false);
  });

  it("openings that don't need flashing never gate", () => {
    expect(flashingOutstanding({ needs_flashing: false }, [])).toBe(false);
  });

  it("an unmigrated database (no column) changes nothing", () => {
    expect(flashingOutstanding({}, [])).toBe(false);
    expect(flashingOutstanding({ needs_flashing: null }, [])).toBe(false);
  });
});

describe("phaseElapsedSeconds (the live clock, net of pauses)", () => {
  const T0 = new Date("2026-08-11T12:00:00Z").getTime();
  it("counts the span minus finished and running pauses", async () => {
    const { phaseElapsedSeconds } = await import("./phases");
    const base = { started_at: "2026-08-11T12:00:00Z", paused_at: null, paused_seconds: 0 };
    expect(phaseElapsedSeconds(base, T0 + 600_000)).toBe(600);
    expect(
      phaseElapsedSeconds({ ...base, paused_seconds: 120 }, T0 + 600_000),
    ).toBe(480);
    // Paused 2 minutes ago and still paused: the clock stands still.
    expect(
      phaseElapsedSeconds(
        { ...base, paused_at: new Date(T0 + 480_000).toISOString() },
        T0 + 600_000,
      ),
    ).toBe(480);
  });

  it("never goes negative", async () => {
    const { phaseElapsedSeconds } = await import("./phases");
    expect(
      phaseElapsedSeconds(
        { started_at: "2026-08-11T12:00:00Z", paused_at: null, paused_seconds: 9999 },
        T0 + 1000,
      ),
    ).toBe(0);
  });
});
