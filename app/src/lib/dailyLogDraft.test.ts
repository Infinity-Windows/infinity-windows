import { describe, expect, it } from "vitest";
import {
  buildDailyLogDraft,
  type DailyLogDraftInput,
  type DailyLogDraftRedo,
  type DailyLogDraftSession,
  type DailyLogDraftShift,
} from "./dailyLogDraft";

const DAY = "2026-08-20";
const NOW = new Date(`${DAY}T18:00:00.000Z`);

function shift(p: Partial<DailyLogDraftShift> & { profile_id: string }): DailyLogDraftShift {
  return {
    clock_in_at: `${DAY}T07:00:00.000Z`,
    clock_out_at: `${DAY}T15:00:00.000Z`,
    break_seconds: 0,
    status: "submitted",
    ...p,
  };
}

function session(
  p: Partial<DailyLogDraftSession> & { opening_id: string; opening_code: string },
): DailyLogDraftSession {
  return {
    started_at: `${DAY}T09:00:00.000Z`,
    ended_at: `${DAY}T10:00:00.000Z`,
    end_reason: null,
    ...p,
  };
}

function redo(p: Partial<DailyLogDraftRedo> & { opening_id: string; opening_code: string }): DailyLogDraftRedo {
  return { reason: "reason", ...p };
}

function input(p: Partial<DailyLogDraftInput>): DailyLogDraftInput {
  return { shifts: [], sessions: [], redos: [], now: NOW, ...p };
}

describe("buildDailyLogDraft", () => {
  it("a normal day: finished marks, an open unit with time on it, real crew hours", () => {
    const draft = buildDailyLogDraft(
      input({
        shifts: [
          shift({ profile_id: "p-a", clock_out_at: `${DAY}T15:15:00.000Z` }), // 8h15m = 495m
          shift({ profile_id: "p-b" }), // 8h = 480m
          shift({ profile_id: "p-c", break_seconds: 1800 }), // 8h - 30m = 450m
        ],
        sessions: [
          session({
            opening_id: "o1",
            opening_code: "W1",
            started_at: `${DAY}T07:10:00.000Z`,
            ended_at: `${DAY}T11:00:00.000Z`,
            end_reason: "finish",
          }),
          session({
            opening_id: "o2",
            opening_code: "W2",
            started_at: `${DAY}T11:05:00.000Z`,
            ended_at: `${DAY}T15:00:00.000Z`,
            end_reason: "finish",
          }),
          session({
            opening_id: "o3",
            opening_code: "A-101",
            started_at: `${DAY}T09:00:00.000Z`,
            ended_at: `${DAY}T12:00:00.000Z`,
            end_reason: "block",
          }),
        ],
      }),
    );
    // 495 + 480 + 450 = 1425m = 23.75h -> rounds to 23.8h
    expect(draft.headline).toBe("2 units installed — 3 crew, 23.8h");
    expect(draft.crewLine).toBe("3 crew · 23.8h");
    expect(draft.notesDraft).toBe("Finished: W1, W2\nStill open: A-101 (3h)");
  });

  it("a zero-work day: nothing to report, and says so honestly rather than inventing filler", () => {
    const draft = buildDailyLogDraft(input({}));
    expect(draft.headline).toBe("0 units installed — 0 crew, 0m");
    expect(draft.crewLine).toBe("0 crew · 0m");
    expect(draft.notesDraft).toBe("");
  });

  it("a multi-foreman day: two shifts from the same person count once for crew, twice for hours", () => {
    const draft = buildDailyLogDraft(
      input({
        shifts: [
          // p-lead1 clocked out for a mid-day break and back in — one crew
          // member, two shift rows, both count toward hours.
          shift({
            profile_id: "p-lead1",
            clock_in_at: `${DAY}T07:00:00.000Z`,
            clock_out_at: `${DAY}T11:00:00.000Z`,
          }),
          shift({
            profile_id: "p-lead1",
            clock_in_at: `${DAY}T11:30:00.000Z`,
            clock_out_at: `${DAY}T15:30:00.000Z`,
          }),
          shift({ profile_id: "p-lead2" }),
          shift({ profile_id: "p-installer1" }),
        ],
      }),
    );
    // (240 + 240) + 480 + 480 = 1440m = 24h, over 3 DISTINCT people.
    expect(draft.crewLine).toBe("3 crew · 24h");
  });

  it("a redo day: a redo filed today is its own line, sorted by mark, separate from finished/open", () => {
    const draft = buildDailyLogDraft(
      input({
        shifts: [shift({ profile_id: "p-a" })],
        redos: [
          redo({ opening_id: "o10", opening_code: "W10", reason: "Wrong hardware" }),
          redo({ opening_id: "o3", opening_code: "W3", reason: "Bent frame" }),
        ],
      }),
    );
    expect(draft.headline).toBe("0 units installed — 1 crew, 8h");
    expect(draft.notesDraft).toBe("Redone: W3 — Bent frame, W10 — Wrong hardware");
  });

  it("a voided shift leaves every total instantly (CONTEXT.md's Void) — never counted", () => {
    const draft = buildDailyLogDraft(
      input({
        shifts: [
          shift({ profile_id: "p-a" }), // 8h, counts
          shift({ profile_id: "p-b", status: "voided" }), // must not count at all
        ],
      }),
    );
    expect(draft.crewLine).toBe("1 crew · 8h");
  });

  it("an opening blocked earlier and finished later the same day counts as finished, not open", () => {
    const draft = buildDailyLogDraft(
      input({
        sessions: [
          session({
            opening_id: "o1",
            opening_code: "W1",
            started_at: `${DAY}T07:00:00.000Z`,
            ended_at: `${DAY}T09:00:00.000Z`,
            end_reason: "block",
          }),
          session({
            opening_id: "o1",
            opening_code: "W1",
            started_at: `${DAY}T13:00:00.000Z`,
            ended_at: `${DAY}T14:00:00.000Z`,
            end_reason: "finish",
          }),
        ],
      }),
    );
    expect(draft.notesDraft).toBe("Finished: W1");
  });
});
