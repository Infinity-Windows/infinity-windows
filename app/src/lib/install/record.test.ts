// The Record's honesty rules: rounds keep their own media, voided rounds
// stay visible, and the timeline reads as plain sentences in time order.

import { describe, expect, it } from "vitest";
import {
  buildTimeline,
  filledTopics,
  groupRounds,
  type RecordEvent,
  type RecordMedia,
} from "./record";
import type { UnitRedo, UnitSession } from "./sessions";

const NOW = Date.parse("2026-08-17T12:00:00Z");

function ev(over: Partial<RecordEvent>): RecordEvent {
  return {
    id: "e1",
    created_at: "2026-08-17T09:00:00Z",
    started_at: null,
    installer: "Isaac",
    minutes: 40,
    quality_grade: 4,
    transcript_raw: null,
    photo_findings: null,
    voided_at: null,
    void_reason: null,
    difficulty: null,
    went_well: null,
    went_poorly: null,
    obstacles: null,
    tools_helped: null,
    time_vs_estimate: null,
    safety_notes: null,
    do_again: null,
    ...over,
  };
}

function sess(over: Partial<UnitSession>): UnitSession {
  return {
    id: Math.random().toString(36).slice(2),
    opening_id: "o1",
    profile_id: "p1",
    role: "install",
    is_rework: false,
    started_at: "2026-08-17T08:00:00Z",
    ended_at: "2026-08-17T08:45:00Z",
    end_reason: "finish",
    block_reason: null,
    block_issue_id: null,
    created_at: "2026-08-17T08:00:00Z",
    ...over,
  };
}

describe("groupRounds", () => {
  it("keeps voided rounds, numbers oldest-first, media stays with its round", () => {
    const events = [
      ev({ id: "e1", voided_at: "2026-08-17T10:00:00Z", void_reason: "wrong unit" }),
      ev({ id: "e2", created_at: "2026-08-17T11:00:00Z" }),
    ];
    const media: RecordMedia[] = [
      { id: "m1", installEventId: "e1", kind: "photo", signedUrl: "u1", createdAt: "" },
      { id: "m2", installEventId: "e2", kind: "video", signedUrl: "u2", createdAt: "" },
    ];
    const rounds = groupRounds(events, media);
    expect(rounds.map((r) => [r.number, r.current, r.media[0]?.id])).toEqual([
      [1, false, "m1"],
      [2, true, "m2"],
    ]);
  });
});

describe("buildTimeline", () => {
  it("plain sentences in time order: work, block with reason, redo, helper", () => {
    const sessions = [
      sess({ started_at: "2026-08-17T08:00:00Z", ended_at: "2026-08-17T08:30:00Z", end_reason: "block", block_reason: "Missing hardware" }),
      sess({ started_at: "2026-08-17T10:00:00Z", ended_at: "2026-08-17T10:22:00Z", profile_id: "p2", role: "helper" }),
      sess({ started_at: "2026-08-17T10:00:00Z", ended_at: "2026-08-17T11:00:00Z", is_rework: true }),
    ];
    const redos: UnitRedo[] = [
      { id: "r1", opening_id: "o1", pressed_by: "p1", reason: "glass scratched", pressed_at: "2026-08-17T09:00:00Z", resolved_at: null, presser: { display_name: "Isaac" } },
    ];
    const names: Record<string, string> = { p1: "Isaac", p2: "Maria" };
    const rows = buildTimeline(sessions, redos, (id) => names[id], NOW);
    expect(rows.map((r) => r.kind)).toEqual(["block", "redo", "work", "work"]);
    expect(rows[0].text).toBe("Isaac — 30m, blocked: Missing hardware");
    expect(rows[1].text).toBe("Isaac pressed Redo: glass scratched");
    expect(rows[2].text).toBe("Maria (helping) — 22m, finished");
    expect(rows[3].text).toBe("Isaac — redo work — 60m, finished");
  });

  it("an open session reads as still on it, minutes against now", () => {
    const rows = buildTimeline(
      [sess({ started_at: "2026-08-17T11:30:00Z", ended_at: null, end_reason: null })],
      [],
      () => undefined,
      NOW,
    );
    expect(rows[0].text).toBe("Crew started — still on it (30m so far)");
  });
});

describe("filledTopics", () => {
  it("returns only topics with content, prompt attached", () => {
    const topics = filledTopics(
      ev({ went_well: "Flashing tape laid clean", obstacles: "  " }),
    );
    expect(topics).toEqual([
      { prompt: "What went well", text: "Flashing tape laid clean" },
    ]);
  });
});
