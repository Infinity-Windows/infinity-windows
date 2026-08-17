// The Data Tab's honesty rules: a stall runs from the Block to the next
// touch (or now), rework counts distinct units, and on-tool never shows a
// percentage of nothing.

import { describe, expect, it } from "vitest";
import { autoClosedCount, onTool, reworkTotals, stallsByReason } from "./insights";
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
