import { describe, expect, it } from "vitest";
import { flashRunTarget, flashingOutstanding, type OpeningPhase } from "./phases";

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

describe("flashRunTarget (several runners leapfrog one queue)", () => {
  const q = [{ id: "a" }, { id: "b" }, { id: "c" }];
  const active = (opening: string, by: string) =>
    ({
      id: `p-${opening}`,
      opening_id: opening,
      kind: "flashing",
      status: "active",
      started_at: "2026-08-14T10:00:00Z",
      started_by: by,
      submitted_at: null,
      submitted_by: null,
      minutes: null,
      photo_path: null,
      paused_at: null,
      paused_seconds: 0,
    }) as never;

  it("an explicit pick wins over everything", () => {
    expect(flashRunTarget(q, [active("a", "me")], "c", "me")!.id).toBe("c");
  });

  it("resumes the window I already have a clock on", () => {
    expect(flashRunTarget(q, [active("b", "me")], null, "me")!.id).toBe("b");
  });

  it("skips windows another runner is on", () => {
    expect(flashRunTarget(q, [active("a", "them")], null, "me")!.id).toBe("b");
  });

  it("falls back to the head when everything is busy", () => {
    const busy = [active("a", "x"), active("b", "y"), active("c", "z")];
    expect(flashRunTarget(q, busy, null, "me")!.id).toBe("a");
  });

  it("empty queue → null", () => {
    expect(flashRunTarget([], [], null, "me")).toBeNull();
  });
});
