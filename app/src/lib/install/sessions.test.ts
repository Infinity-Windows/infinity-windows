// The sessions lib's pure math: minutes are capped like every other clock,
// the chain's grace counts down honestly, and "blocked" is derived from
// the newest session — never stored.

import { describe, expect, it } from "vitest";
import {
  blockedUnits,
  chainGraceRemainingMs,
  laborBreakdown,
  reworkRate,
  sessionMinutes,
  type UnitSession,
} from "./sessions";

const T0 = Date.parse("2026-08-16T10:00:00Z");

function sess(over: Partial<UnitSession>): UnitSession {
  return {
    id: Math.random().toString(36).slice(2),
    opening_id: "o1",
    profile_id: "p1",
    role: "install",
    is_rework: false,
    started_at: "2026-08-16T09:00:00Z",
    ended_at: null,
    end_reason: null,
    block_reason: null,
    block_issue_id: null,
    created_at: "2026-08-16T09:00:00Z",
    ...over,
  };
}

describe("sessionMinutes", () => {
  it("closed sessions use their stamps; open ones run against now", () => {
    expect(
      sessionMinutes(sess({ started_at: "2026-08-16T09:00:00Z", ended_at: "2026-08-16T09:42:00Z" })),
    ).toBe(42);
    expect(sessionMinutes(sess({ started_at: "2026-08-16T09:30:00Z" }), T0)).toBe(30);
  });

  it("caps at 480 and never goes negative", () => {
    expect(
      sessionMinutes(sess({ started_at: "2026-08-10T09:00:00Z", ended_at: "2026-08-16T09:00:00Z" })),
    ).toBe(480);
    expect(sessionMinutes(sess({ started_at: "2026-08-16T11:00:00Z" }), T0)).toBe(0);
  });
});

describe("chainGraceRemainingMs", () => {
  it("counts the 5-minute window down and clamps at zero", () => {
    const start = new Date(T0 - 2 * 60 * 1000).toISOString();
    expect(chainGraceRemainingMs(start, T0)).toBe(3 * 60 * 1000);
    const old = new Date(T0 - 10 * 60 * 1000).toISOString();
    expect(chainGraceRemainingMs(old, T0)).toBe(0);
  });
});

describe("blockedUnits (derived, newest session decides)", () => {
  it("a unit whose latest session ended in block is blocked; a later session clears it", () => {
    // Newest-first, as listProjectSessions returns them.
    const sessions = [
      // o1: blocked then RESUMED — not blocked.
      sess({ opening_id: "o1", started_at: "2026-08-16T11:00:00Z" }),
      sess({
        opening_id: "o1",
        started_at: "2026-08-16T09:00:00Z",
        ended_at: "2026-08-16T10:00:00Z",
        end_reason: "block",
        block_reason: "Wrong glass",
      }),
      // o2: latest ended in block — blocked, with its reason and issue.
      sess({
        opening_id: "o2",
        started_at: "2026-08-16T08:00:00Z",
        ended_at: "2026-08-16T08:30:00Z",
        end_reason: "block",
        block_reason: "Missing hardware",
        block_issue_id: "issue-9",
      }),
      // o3: finished — not blocked.
      sess({
        opening_id: "o3",
        started_at: "2026-08-16T07:00:00Z",
        ended_at: "2026-08-16T07:45:00Z",
        end_reason: "finish",
      }),
    ];
    expect(blockedUnits(sessions)).toEqual([
      { openingId: "o2", reason: "Missing hardware", issueId: "issue-9" },
    ]);
  });
});

describe("laborBreakdown (labor-minutes with rework separate)", () => {
  it("splits install / helper / rework and adds flashing", () => {
    const b = laborBreakdown(
      [
        sess({ started_at: "2026-08-17T08:00:00Z", ended_at: "2026-08-17T08:40:00Z" }),
        sess({ started_at: "2026-08-17T08:10:00Z", ended_at: "2026-08-17T08:25:00Z", role: "helper" }),
        sess({ started_at: "2026-08-17T10:00:00Z", ended_at: "2026-08-17T10:30:00Z", is_rework: true }),
      ],
      12,
    );
    expect(b).toEqual({ installMin: 40, helperMin: 15, reworkMin: 30, flashMin: 12, totalMin: 97 });
  });
});

describe("reworkRate", () => {
  it("redone units over finished units; null before anything finished", () => {
    expect(reworkRate(2, 40)).toBeCloseTo(0.05, 6);
    expect(reworkRate(0, 0)).toBeNull();
  });
});
