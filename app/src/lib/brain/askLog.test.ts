import { describe, expect, it } from "vitest";
import { groupAskLog, toLogEntry, type AskLogRow } from "./askLog";
import type { BrainOutcome } from "./answer";
import type { BrainEntry } from "./types";

const entry = (id: string, title: string): BrainEntry => ({
  id,
  kind: "tip",
  title,
  source: "SH3252 · Single-Hung 32x52",
  body: "…",
});

const answered: BrainOutcome = {
  kind: "answers",
  hits: [
    { entry: entry("tip:SH3252:0", "Install tip — Single-Hung"), score: 9, matched: ["drain"] },
  ],
};

describe("shaping a log entry", () => {
  it("records what the brain matched, so a foreman can see if it was right", () => {
    const row = toLogEntry("which side does the drain face?", answered, { online: true });
    expect(row).toMatchObject({
      answered: true,
      outcome: "answers",
      matched_ids: ["tip:SH3252:0"],
      matched_titles: ["Install tip — Single-Hung"],
      online: true,
    });
  });

  it("marks a miss as unanswered — that is the whole point of the log", () => {
    const row = toLogEntry("what torque on anchors?", { kind: "miss", message: "" }, {
      online: true,
    });
    expect(row.answered).toBe(false);
    expect(row.outcome).toBe("miss");
    expect(row.matched_ids).toEqual([]);
  });

  it("counts a live-data question as unanswered too", () => {
    const row = toLogEntry("what did Ammon say?", { kind: "live", message: "" }, { online: false });
    expect(row).toMatchObject({ answered: false, outcome: "live", online: false });
  });

  it("trims a runaway question instead of rejecting it", () => {
    const row = toLogEntry("x".repeat(900), { kind: "miss", message: "" }, { online: true });
    expect(row.question).toHaveLength(500);
  });
});

const row = (over: Partial<AskLogRow>): AskLogRow => ({
  id: "1",
  asker_id: "u",
  question: "What torque on anchors?",
  answered: false,
  outcome: "miss",
  matched_ids: [],
  matched_titles: [],
  online: true,
  asked_at: "2026-07-29T10:00:00Z",
  reviewed_at: null,
  reviewed_by: null,
  ...over,
});

describe("grouping the log for a foreman", () => {
  it("collapses the same question asked many times into one line", () => {
    const groups = groupAskLog([
      row({ id: "a" }),
      row({ id: "b", question: "what torque on anchors" }),
      row({ id: "c", question: "How deep on stucco?", asked_at: "2026-07-29T11:00:00Z" }),
    ]);
    expect(groups).toHaveLength(2);
    expect(groups[0]).toMatchObject({ asks: 2, ids: ["a", "b"] });
  });

  it("puts the most-asked question first", () => {
    const groups = groupAskLog([
      row({ id: "a", question: "rare one" }),
      row({ id: "b", question: "common one" }),
      row({ id: "c", question: "common one" }),
    ]);
    expect(groups[0].question).toBe("common one");
  });

  it("only counts a question handled once every ask of it is", () => {
    const groups = groupAskLog([
      row({ id: "a", reviewed_at: "2026-07-29T12:00:00Z" }),
      row({ id: "b" }),
    ]);
    expect(groups[0].reviewed).toBe(false);
  });

  it("keeps the newest ask's matches, so the foreman sees what we showed", () => {
    const groups = groupAskLog([
      row({ id: "a", matched_titles: ["old"] }),
      row({ id: "b", matched_titles: ["new"], asked_at: "2026-07-30T10:00:00Z" }),
    ]);
    expect(groups[0].matchedTitles).toEqual(["new"]);
  });
});
