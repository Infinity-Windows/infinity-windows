// The Data Tab's honesty rules: a stall runs from the Block to the next
// touch (or now), rework counts distinct units, and on-tool never shows a
// percentage of nothing.

import { describe, expect, it } from "vitest";
import {
  autoClosedCount,
  blockedNow,
  estimateVsActual,
  legacyLabor,
  onTool,
  reworkTotals,
  stallsByReason,
  topUnitsByLabor,
  weeklyTrend,
} from "./insights";
import type { UnitSession } from "../install/sessions";

const NOW = Date.parse("2026-08-17T12:00:00Z");

function sess(over: Partial<UnitSession>): UnitSession {
  return {
    id: Math.random().toString(36).slice(2),
    opening_id: "o1",
    profile_id: "p1",
    role: "install",
    is_rework: false,
    started_at: "2026-08-17T08:00:00Z",
    ended_at: "2026-08-17T09:00:00Z",
    end_reason: "finish",
    block_reason: null,
    block_issue_id: null,
    created_at: "2026-08-17T08:00:00Z",
    ...over,
  };
}

describe("stallsByReason", () => {
  it("a stall runs from the block to the unit's next session; still-blocked runs to now", () => {
    const out = stallsByReason(
      [
        // o1: blocked 09:00, resumed 10:30 → 90 min against "Wrong glass".
        sess({ opening_id: "o1", end_reason: "block", block_reason: "Wrong glass" }),
        sess({
          opening_id: "o1",
          started_at: "2026-08-17T10:30:00Z",
          ended_at: null,
          end_reason: null,
        }),
        // o2: blocked 10:00, never resumed → 120 min to NOW on "Missing hardware".
        sess({
          opening_id: "o2",
          started_at: "2026-08-17T09:00:00Z",
          ended_at: "2026-08-17T10:00:00Z",
          end_reason: "block",
          block_reason: "Missing hardware",
        }),
      ],
      NOW,
    );
    expect(out).toEqual([
      { reason: "Missing hardware", count: 1, stalledMin: 120 },
      { reason: "Wrong glass", count: 1, stalledMin: 90 },
    ]);
  });
});

describe("reworkTotals / autoClosedCount", () => {
  it("counts distinct redone units and their minutes; flags dead-phone sessions", () => {
    const sessions = [
      sess({ opening_id: "a", is_rework: true }), // 60m
      sess({
        opening_id: "a",
        is_rework: true,
        started_at: "2026-08-17T10:00:00Z",
        ended_at: "2026-08-17T10:30:00Z",
      }), // 30m, same unit
      sess({ opening_id: "b", end_reason: "auto_closed" }),
    ];
    expect(reworkTotals(sessions, NOW)).toEqual({ units: 1, minutes: 90 });
    expect(autoClosedCount(sessions)).toBe(1);
  });
});

describe("topUnitsByLabor", () => {
  it("sums finished minutes per unit, biggest first, open sessions excluded", () => {
    const out = topUnitsByLabor(
      [
        sess({ opening_id: "a" }), // 60m
        sess({ opening_id: "b", started_at: "2026-08-17T08:00:00Z", ended_at: "2026-08-17T09:30:00Z" }), // 90m
        sess({ opening_id: "a", started_at: "2026-08-17T10:00:00Z", ended_at: "2026-08-17T10:45:00Z" }), // +45m
        sess({ opening_id: "c", ended_at: null, end_reason: null }), // open — excluded
      ],
      2,
      NOW,
    );
    expect(out).toEqual([
      { openingId: "a", minutes: 105 },
      { openingId: "b", minutes: 90 },
    ]);
  });
});

describe("legacyLabor / topUnitsByLabor with old-era minutes", () => {
  it("old minutes fill gaps only — automatic timing wins per window", () => {
    const sessions = [sess({ opening_id: "a" })]; // a: 60m automatic
    const events = [
      { opening_id: "a", minutes: 999 }, // ignored — sessions cover a
      { opening_id: "b", minutes: 207 }, // counted — no sessions for b
    ];
    expect(legacyLabor(events, sessions)).toEqual({ minutes: 207, units: 1 });
    expect(topUnitsByLabor(sessions, 5, NOW, events)).toEqual([
      { openingId: "b", minutes: 207 },
      { openingId: "a", minutes: 60 },
    ]);
  });
});

describe("blockedNow", () => {
  it("newest session decides; resumed units drop off; longest-sitting first", () => {
    const out = blockedNow(
      [
        // o1 blocked at 09:00, resumed at 10:30 → not blocked now.
        sess({ opening_id: "o1", end_reason: "block", block_reason: "Wrong glass" }),
        sess({ opening_id: "o1", started_at: "2026-08-17T10:30:00Z", ended_at: null, end_reason: null }),
        // o2 blocked at 10:00, still sitting → 120m at NOW.
        sess({
          opening_id: "o2",
          started_at: "2026-08-17T09:00:00Z",
          ended_at: "2026-08-17T10:00:00Z",
          end_reason: "block",
          block_reason: "Missing hardware",
        }),
      ],
      NOW,
    );
    expect(out).toEqual([
      { openingId: "o2", reason: "Missing hardware", sittingMin: 120 },
    ]);
  });
});

describe("weeklyTrend", () => {
  it("buckets labor by Monday week, attributes lost time to the block's week", () => {
    // NOW is Mon Aug 17 2026 12:00 UTC — this week starts Aug 17.
    const out = weeklyTrend(
      [
        sess({}), // 60m labor this week
        // Last week: 30m labor, then blocked Mon Aug 10 09:00 → resumed Aug 10 11:00 = 120m lost.
        sess({
          opening_id: "w",
          started_at: "2026-08-10T08:30:00Z",
          ended_at: "2026-08-10T09:00:00Z",
          end_reason: "block",
          block_reason: "Wrong glass",
        }),
        sess({
          opening_id: "w",
          started_at: "2026-08-10T11:00:00Z",
          ended_at: "2026-08-10T11:30:00Z",
        }),
      ],
      2,
      NOW,
    );
    expect(out).toEqual([
      { weekStart: "2026-08-10", laborMin: 60, lostMin: 120 },
      { weekStart: "2026-08-17", laborMin: 60, lostMin: 0 },
    ]);
  });
});

describe("estimateVsActual", () => {
  it("median ratio at n>=5; null below — a percentage from three windows is a guess", () => {
    const five = [1.2, 0.9, 1.1, 1.0, 1.3].map((r) => ({
      estimateMin: 100,
      actualMin: r * 100,
    }));
    expect(estimateVsActual(five)).toEqual({ n: 5, medianRatio: 1.1 });
    expect(estimateVsActual(five.slice(0, 4))).toBeNull();
  });
});

describe("onTool", () => {
  it("crew total + per person, session time clamped to shift time, no pct of nothing", () => {
    const shifts = [
      { profile_id: "p1", clock_in_at: "2026-08-17T07:00:00Z", clock_out_at: "2026-08-17T11:00:00Z", break_seconds: 1800 }, // 210 worked
      { profile_id: "p2", clock_in_at: "2026-08-17T07:00:00Z", clock_out_at: null, break_seconds: 0 }, // open → 300 to NOW
    ];
    const sessions = [
      sess({ profile_id: "p1" }), // 60m
      sess({ profile_id: "p1", started_at: "2026-08-17T09:30:00Z", ended_at: "2026-08-17T10:30:00Z" }), // 60m
      sess({ profile_id: "p3" }), // sessions but NO shift → pct null
    ];
    const { total, perPerson } = onTool(sessions, shifts, NOW);
    const p1 = perPerson.find((p) => p.profileId === "p1")!;
    expect(p1).toEqual({ profileId: "p1", sessionMin: 120, shiftMin: 210, pct: 120 / 210 });
    expect(perPerson.find((p) => p.profileId === "p2")!.pct).toBe(0);
    expect(perPerson.find((p) => p.profileId === "p3")!.pct).toBeNull();
    expect(total.shiftMin).toBe(210 + 300);
    expect(total.sessionMin).toBe(180);
  });
});
