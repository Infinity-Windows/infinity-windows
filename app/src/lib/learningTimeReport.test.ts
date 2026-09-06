// The one piece of arithmetic the owner's page does for itself: turning rows
// per item into one line per person.
//
// The DOUBLE-COUNT is what these tests are really about. Every minute in Learn
// lands on a 'tab' row, and the term / quiz / sequence / video rows are the
// SAME minutes named more precisely. A total that added the kinds together
// would say four hours where somebody spent two, which is the kind of number a
// person is asked about in a review.

import { describe, expect, it } from "vitest";
import {
  foldByPerson,
  itemLabel,
  rangeStart,
  type LearningTimeRow,
  type LearningVideoRow,
} from "./learningTimeReport";

const AMY = "11111111-1111-4111-8111-111111111111";
const BEN = "22222222-2222-4222-8222-222222222222";

function timeRow(over: Partial<LearningTimeRow>): LearningTimeRow {
  return {
    profileId: AMY,
    displayName: "Crew A",
    itemKind: "tab",
    itemKey: "glossary",
    activeSeconds: 60,
    visits: 1,
    lastSeenAt: "2026-09-04T12:00:00Z",
    ...over,
  };
}

function videoRow(over: Partial<LearningVideoRow>): LearningVideoRow {
  return {
    profileId: AMY,
    displayName: "Crew A",
    videoId: "v1",
    videoTitle: "Flashing a head",
    timesWatched: 1,
    bestSeconds: 100,
    unionSeconds: 100,
    durationSeconds: 200,
    completed: false,
    lastWatchedAt: "2026-09-04T13:00:00Z",
    ...over,
  };
}

describe("foldByPerson", () => {
  it("totals ONLY the tab rows, so the parts are never added to the whole", () => {
    const people = foldByPerson(
      [
        timeRow({ itemKind: "tab", itemKey: "glossary", activeSeconds: 600 }),
        timeRow({ itemKind: "term", itemKey: "shim", activeSeconds: 300 }),
        timeRow({ itemKind: "term", itemKey: "sill-pan", activeSeconds: 120 }),
      ],
      [],
    );
    expect(people).toHaveLength(1);
    expect(people[0].totalSeconds).toBe(600);
    expect(people[0].byKind.term).toBe(420);
    expect(people[0].byKind.tab).toBe(600);
  });

  it("leaves the tab rows out of the item list — they ARE the total", () => {
    const [person] = foldByPerson(
      [
        timeRow({ itemKind: "tab", itemKey: "quiz", activeSeconds: 900 }),
        timeRow({ itemKind: "quiz", itemKey: "round", activeSeconds: 880 }),
      ],
      [],
    );
    expect(person.items.map((i) => i.itemKind)).toEqual(["quiz"]);
  });

  it("puts the busiest item first, and the most-watched lesson first", () => {
    const [person] = foldByPerson(
      [
        timeRow({ itemKind: "term", itemKey: "a", activeSeconds: 30 }),
        timeRow({ itemKind: "term", itemKey: "b", activeSeconds: 300 }),
      ],
      [
        videoRow({ videoId: "v1", unionSeconds: 20 }),
        videoRow({ videoId: "v2", unionSeconds: 180 }),
      ],
    );
    expect(person.items.map((i) => i.itemKey)).toEqual(["b", "a"]);
    expect(person.videos.map((v) => v.videoId)).toEqual(["v2", "v1"]);
  });

  it("gives a line to somebody who has only ever watched a lesson", () => {
    // Otherwise a page about learning would leave out the person who watched
    // three lessons and never opened the glossary.
    const people = foldByPerson([], [videoRow({ profileId: BEN, displayName: "Crew B" })]);
    expect(people).toHaveLength(1);
    expect(people[0].profileId).toBe(BEN);
    expect(people[0].totalSeconds).toBe(0);
    expect(people[0].videos).toHaveLength(1);
  });

  it("sorts people by time, and falls back to name so the order is stable", () => {
    const people = foldByPerson(
      [
        timeRow({ profileId: AMY, displayName: "Crew A", activeSeconds: 100 }),
        timeRow({ profileId: BEN, displayName: "Crew B", activeSeconds: 900 }),
      ],
      [],
    );
    expect(people.map((p) => p.displayName)).toEqual(["Crew B", "Crew A"]);

    const tied = foldByPerson(
      [
        timeRow({ profileId: BEN, displayName: "Crew B", activeSeconds: 100 }),
        timeRow({ profileId: AMY, displayName: "Crew A", activeSeconds: 100 }),
      ],
      [],
    );
    expect(tied.map((p) => p.displayName)).toEqual(["Crew A", "Crew B"]);
  });

  it("remembers the most recent thing they did, from either half", () => {
    const [person] = foldByPerson(
      [timeRow({ lastSeenAt: "2026-09-01T09:00:00Z" })],
      [videoRow({ lastWatchedAt: "2026-09-04T18:00:00Z" })],
    );
    expect(person.lastSeenAt).toBe("2026-09-04T18:00:00Z");
  });
});

describe("rangeStart", () => {
  // 2026-09-05 is a Saturday; its week began Monday the 31st of August.
  const SATURDAY = new Date(2026, 8, 5, 10, 0);

  it("starts this week at Monday", () => {
    const from = rangeStart("week", SATURDAY)!;
    expect(from.getMonth()).toBe(7);
    expect(from.getDate()).toBe(31);
  });

  it("counts four weeks as this one and the three before it", () => {
    // Not "28 days back from today", which on a Monday morning would show an
    // almost-empty page and read as though nobody had studied.
    const from = rangeStart("four-weeks", SATURDAY)!;
    expect(from.getMonth()).toBe(7);
    expect(from.getDate()).toBe(10);
  });

  it("asks for no lower bound at all for all time", () => {
    expect(rangeStart("all", SATURDAY)).toBeNull();
  });
});

describe("itemLabel", () => {
  const names = new Map([
    ["sill-pan", "Sill pan"],
    ["11111111-1111-1111-1111-111111111111", "Flashing a head"],
  ]);
  const kinds = { quiz: "Quiz", sequence: "Sequence" };
  const row = (itemKind: string, itemKey: string): LearningTimeRow => ({
    profileId: "p",
    displayName: "Crew A",
    itemKind,
    itemKey,
    activeSeconds: 60,
    visits: 1,
    lastSeenAt: "2026-09-04T18:00:00Z",
  });

  it("names a glossary term the way the glossary does", () => {
    // The whole point of the line: "sill-pan" is an id, "Sill pan" is an answer
    // to what somebody was studying.
    expect(itemLabel(row("term", "sill-pan"), names, kinds)).toBe("Sill pan");
  });

  it("names a lesson by its title", () => {
    expect(
      itemLabel(row("video", "11111111-1111-1111-1111-111111111111"), names, kinds),
    ).toBe("Flashing a head");
  });

  it("calls a quiz and a sequence after their kind, not after 'round'", () => {
    expect(itemLabel(row("quiz", "round"), names, kinds)).toBe("Quiz");
    expect(itemLabel(row("sequence", "round"), names, kinds)).toBe("Sequence");
  });

  it("prints an id it cannot place rather than nothing at all", () => {
    // A term retired from the glossary, or a lesson deleted since. A blank line
    // would be a lie about a row that exists and has real minutes on it.
    expect(itemLabel(row("term", "retired-term"), names, kinds)).toBe("retired-term");
  });
});
