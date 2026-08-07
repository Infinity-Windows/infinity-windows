import { describe, expect, it } from "vitest";
import {
  absoluteSill,
  envelopeHeight,
  storiesOf,
  storyForWindow,
  storyLevels,
} from "./stories";

const RECT = [
  { x: 0, z: 0 },
  { x: 10, z: 0 },
  { x: 10, z: 8 },
  { x: 0, z: 8 },
];
const SMALL = [
  { x: 2, z: 2 },
  { x: 6, z: 2 },
  { x: 6, z: 6 },
  { x: 2, z: 6 },
];

describe("storiesOf", () => {
  it("a building without stories is one story of itself — the legacy shape", () => {
    const s = storiesOf({ height: 4.7, footprints: [RECT, SMALL] });
    expect(s).toHaveLength(1);
    expect(s[0]).toMatchObject({ n: 1, name: "Ground", elevM: 0, heightM: 4.7 });
    expect(s[0].footprints).toHaveLength(2);
  });

  it("parses, sorts by datum, and fills defaults", () => {
    const s = storiesOf({
      height: 6,
      stories: [
        { n: 2, elevM: 3.2, heightM: 1.5, footprints: [SMALL], partial: true },
        { n: 1, name: "Ground", elevM: 0, heightM: 3.2, footprints: [RECT] },
      ],
    });
    expect(s.map((x) => x.n)).toEqual([1, 2]);
    expect(s[1].partial).toBe(true);
    expect(s[1].name).toBe("Level 1"); // unnamed gets a default from its slot
  });

  it("drops junk stories and falls back to legacy when none survive", () => {
    const s = storiesOf({
      height: 3,
      footprints: [RECT],
      stories: [{ heightM: 0, footprints: [] }, "nonsense"],
    });
    expect(s).toHaveLength(1);
    expect(s[0].heightM).toBe(3);
  });
});

describe("window ↔ story resolution", () => {
  const stories = storiesOf({
    height: 4.7,
    stories: [
      { n: 1, name: "Ground", elevM: 0, heightM: 3.2, footprints: [RECT] },
      { n: 2, name: "Great room", elevM: 3.2, heightM: 1.5, footprints: [SMALL], partial: true },
    ],
  });

  it("resolves by story number; single-story models absorb everything", () => {
    expect(storyForWindow({ story: 2 }, stories)?.name).toBe("Great room");
    expect(storyForWindow({}, stories)).toBeNull();
    const single = storiesOf({ height: 4.7, footprints: [RECT] });
    expect(storyForWindow({}, single)?.n).toBe(1);
  });

  it("absolute sill = story datum + relative sill; legacy y passes through", () => {
    // The clerestory case: story 2, sill 0.4m above ITS floor -> 3.6m absolute.
    expect(absoluteSill({ story: 2, y: 0.4 }, stories)).toBeCloseTo(3.6, 5);
    expect(absoluteSill({ story: 1, y: 0.9 }, stories)).toBeCloseTo(0.9, 5);
    const single = storiesOf({ height: 4.7, footprints: [RECT] });
    expect(absoluteSill({ y: 3.6 }, single)).toBeCloseTo(3.6, 5);
  });

  it("levels and envelope derive from the stories", () => {
    expect(storyLevels(stories)).toEqual([3.2]);
    expect(envelopeHeight(stories)).toBeCloseTo(4.7, 5);
  });
});
