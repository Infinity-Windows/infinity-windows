import { describe, expect, it } from "vitest";
import { routePaidSeconds as paidSeconds } from "./routePaidSeconds";
import type { NativeClockFlow } from "../paidClock/flow";
import type { TimeShift } from "../timeclock";

const routePaidSeconds: typeof paidSeconds = (flow, now) => paidSeconds(flow, now, {userId: "u1", generation: 1});

const shift = {
  id: "s1", profile_id: "u1", project_id: null, cost_code_id: null,
  clock_in_at: "2026-10-04T12:00:00.000000Z", clock_out_at: null,
  break_seconds: 0, break_started_at: null, break_type: null, injured: null,
  time_confirmed: null, status: "open", created_at: "2026-10-04T12:00:00.000000Z",
  note: null, injury_note: null, job_mode: null, review_reason: null,
  projects: null, cost_codes: null,
} as unknown as TimeShift;

function flow(partial: Partial<NativeClockFlow>): NativeClockFlow {
  return {
    ownerId: "u1", loginGeneration: 1, route: "isolated", nativeRead: "ready",
    records: [], currentRead: "ready",
    current: { kind: "open", shift, observedAt: "2026-10-04T12:30:00.000000Z" },
    canStartDay: false, canRequestSafety: true,
    authorStart: async () => ({ kind: "held", clientId: "c", reason: "basis_unavailable" }),
    authorSafety: async () => ({ kind: "held", clientId: "c", reason: "basis_unavailable" }),
    refresh: () => {},
    ...partial,
  };
}

describe("routePaidSeconds", () => {
  it("rejects another owner or login generation even with a ready current", () => {
    expect(routePaidSeconds(flow({ownerId: "u2"}), Date.now()).seconds).toBeNull();
    expect(routePaidSeconds(flow({loginGeneration: 2}), Date.now()).seconds).toBeNull();
    expect(routePaidSeconds(flow({current: {kind: "open", shift: {...shift, profile_id: "u2"}}}), Date.now()).seconds).toBeNull();
  });
  it("returns null with no native flow", () => {
    expect(routePaidSeconds(null, Date.now())).toEqual({ seconds: null, stale: false });
  });

  it("returns null off the clock", () => {
    expect(routePaidSeconds(flow({ current: { kind: "off", shift: null } }), Date.now()))
      .toEqual({ seconds: null, stale: false });
  });

  it.each(["loading", "blocked", "unavailable"] as const)(
    "returns null while the native read is %s — never a fabricated zero",
    (currentRead) => {
      expect(routePaidSeconds(flow({ currentRead }), Date.now())).toEqual({ seconds: null, stale: false });
    },
  );

  it("uses the live clock for a ready read", () => {
    const now = Date.parse("2026-10-04T12:05:00.000000Z");
    expect(routePaidSeconds(flow({}), now)).toEqual({ seconds: 300, stale: false });
  });

  it("freezes at observedAt for a stale read, labelled stale", () => {
    const result = routePaidSeconds(flow({ currentRead: "stale" }), Date.parse("2026-10-04T13:00:00.000000Z"));
    expect(result).toEqual({ seconds: 1800, stale: true }); // frozen at 12:30, not the later now
  });

  it("reports null, not zero, when a stale read has no parseable observedAt", () => {
    const result = routePaidSeconds(
      flow({ currentRead: "stale", current: { kind: "open", shift, observedAt: undefined } }),
      Date.now(),
    );
    expect(result).toEqual({ seconds: null, stale: true });
  });

  it("never reads a needs_finish shift as live time", () => {
    expect(routePaidSeconds(flow({ current: { kind: "needs_finish", shift } }), Date.now()))
      .toEqual({ seconds: null, stale: false });
  });
});
