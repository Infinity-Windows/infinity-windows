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

describe("stretchStoriesToFit", () => {
  const base = () =>
    storiesOf({
      height: 3,
      stories: [
        { n: 1, name: "Ground", elevM: 0, heightM: 3, footprints: [RECT] },
        { n: 2, name: "Level 2", elevM: 3, heightM: 3, footprints: [SMALL] },
      ],
    });

  it("raises a story to fit its tallest glass and lifts the stories above", async () => {
    const { stretchStoriesToFit } = await import("./stories");
    // 3645mm window at a 0.45m sill needs 0.45+3.645+0.15 = 4.25m of wall.
    const out = stretchStoriesToFit(base(), [
      { story: 1, y: 0.45, h: 3645 },
      { story: 2, y: 0.4, h: 800 },
    ]);
    expect(out[0].heightM).toBeCloseTo(4.25, 2);
    expect(out[1].elevM).toBeCloseTo(4.25, 2);   // still plate-on-plate
    expect(out[1].heightM).toBe(3);              // tall enough already: untouched
  });

  it("never shrinks a story the user made tall on purpose", async () => {
    const { stretchStoriesToFit } = await import("./stories");
    const tall = base();
    tall[0].heightM = 6;
    const out = stretchStoriesToFit(tall, [{ story: 1, y: 0.9, h: 1200 }]);
    expect(out[0].heightM).toBe(6);
    expect(out).not.toBe(tall);                  // pure: input untouched
    expect(tall[0].elevM).toBe(0);
  });

  it("single-story models absorb story-less windows", async () => {
    const { stretchStoriesToFit } = await import("./stories");
    const single = storiesOf({ height: 3, footprints: [RECT] });
    const out = stretchStoriesToFit(single, [{ y: 3.6, h: 749 }]);
    expect(out[0].heightM).toBeCloseTo(3.6 + 0.749 + 0.15, 2);
  });
});
