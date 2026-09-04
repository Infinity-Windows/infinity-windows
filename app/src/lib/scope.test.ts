// Wave X: the line a job card and a job header both say. What appears, in what
// order, and which of a plural pair each count takes — decided here, so the
// rules can be read without rendering a card.

import { describe, expect, it } from "vitest";
import { CATALOG } from "./i18n/catalog";
import { translate } from "./i18n/translate";
import {
  doorBreakdownParts,
  scopeLineParts,
  storiesToShow,
  type ScopeCounts,
} from "./scope";

const counts = (over: Partial<ScopeCounts> = {}): ScopeCounts => ({
  project_id: "job-1",
  openings: 0,
  installed: 0,
  windows: 0,
  doors: 0,
  door_sliders: 0,
  door_french: 0,
  door_bifold: 0,
  door_swing: 0,
  door_other: 0,
  unknown_units: 0,
  ...over,
});

/** The sentence a phone actually shows, in one language. */
const say = (
  parts: { key: string; n: number }[],
  lang: "en" | "es" = "en",
): string =>
  parts.map((p) => translate(CATALOG, lang, p.key, { n: p.n })).join(" · ");

describe("the card line", () => {
  it("is the whole sentence when the job has everything", () => {
    const { parts } = scopeLineParts(
      counts({ openings: 40, installed: 32, windows: 32, doors: 8 }),
      { stories: 2 },
    );
    expect(say(parts)).toBe("40 openings · 32 windows · 8 doors · 2 stories");
  });

  // A job whose specs nobody has read yet knows how many holes there are and
  // nothing else. "0 doors" would read as a job somebody has checked.
  it("leaves out what it cannot say", () => {
    const { parts } = scopeLineParts(counts({ openings: 40, unknown_units: 40 }));
    expect(say(parts)).toBe("40 openings");
  });

  it("says one of a thing in the singular, in both languages", () => {
    const { parts } = scopeLineParts(
      counts({ openings: 1, windows: 0, doors: 1 }),
      { stories: 1 },
    );
    expect(say(parts)).toBe("1 opening · 1 door · 1 story");
    expect(say(parts, "es")).toBe("1 abertura · 1 puerta · 1 piso");
  });

  it("pluralizes in Spanish too", () => {
    const { parts } = scopeLineParts(
      counts({ openings: 40, windows: 32, doors: 8 }),
      { stories: 2 },
    );
    expect(say(parts, "es")).toBe("40 aberturas · 32 ventanas · 8 puertas · 2 pisos");
  });

  // A service call has no openings by design. Zeroes on it would look like a
  // job that had gone wrong.
  it("a tracking job with nothing on it says what it is", () => {
    const { parts, trackingOnly } = scopeLineParts(counts(), { trackingOnly: true });
    expect(trackingOnly).toBe(true);
    expect(parts).toEqual([]);
    expect(translate(CATALOG, "en", "scope.trackingJob")).toBe("Tracking job");
  });

  // A tracking job somebody DID upload plans for counts like any other.
  it("a tracking job with openings counts them", () => {
    const { parts, trackingOnly } = scopeLineParts(
      counts({ openings: 3, windows: 3 }),
      { trackingOnly: true },
    );
    expect(trackingOnly).toBe(false);
    expect(say(parts)).toBe("3 openings · 3 windows");
  });

  it("says nothing at all when the counts have not loaded", () => {
    expect(scopeLineParts(null).parts).toEqual([]);
    expect(scopeLineParts(undefined, { stories: 2 }).parts).toEqual([
      { key: "scope.stories.many", n: 2 },
    ]);
  });

  // The pre-migration and pre-backfill shape: the view is missing, so the
  // degrade path fills in openings and installed only. The line must still be
  // the job's size, which is what the card said before this wave.
  it("degrades to the openings count alone", () => {
    const { parts } = scopeLineParts(counts({ openings: 40, installed: 32 }));
    expect(say(parts)).toBe("40 openings");
  });
});

describe("which doors", () => {
  it("names each kind that is there, most-hung first", () => {
    const parts = doorBreakdownParts(
      counts({ doors: 8, door_sliders: 5, door_french: 2, door_bifold: 1 }),
    );
    expect(say(parts)).toBe("5 sliders · 2 French · 1 bifold");
  });

  it("says 'not stated' rather than hiding the doors nobody described", () => {
    const parts = doorBreakdownParts(counts({ doors: 3, door_french: 1, door_other: 2 }));
    expect(say(parts)).toBe("1 French · 2 not stated");
    expect(say(parts, "es")).toBe("1 francesa · 2 sin especificar");
  });

  it("is empty for a job with no doors", () => {
    expect(doorBreakdownParts(counts({ openings: 12, windows: 12 }))).toEqual([]);
    expect(doorBreakdownParts(null)).toEqual([]);
  });
});

describe("how many storeys to show", () => {
  const model = (stories: unknown) => ({
    features: {
      fitview: {
        model: {
          building: { width: 10, depth: 8, height: 3.6, rise: 0, footprints: [[]], stories },
          windows: [],
        },
      },
    },
  });

  it("prefers the traced model over the typed number", () => {
    const traced = model([
      { elevM: 0, heightM: 3, footprints: [[{ x: 0, z: 0 }, { x: 1, z: 0 }, { x: 1, z: 1 }]] },
      { elevM: 3, heightM: 3, footprints: [[{ x: 0, z: 0 }, { x: 1, z: 0 }, { x: 1, z: 1 }]] },
    ]);
    expect(storiesToShow([traced], 5)).toBe(2);
  });

  // A model traced before storeys existed — which is every model on a real job
  // today, Ben's hand-traced Black Desert included — has no stories array.
  // storiesOf turns that into one storey because the renderer needs a shape to
  // draw, but nobody surveyed it, so it must not beat a number a person typed.
  it("a model that never said how many storeys does not overrule the job form", () => {
    expect(storiesToShow([model(undefined)], 4)).toBe(4);
    expect(storiesToShow([model(undefined)], 2)).toBe(2);
  });

  it("and says nothing when nobody typed one either", () => {
    expect(storiesToShow([model(undefined)], null)).toBeNull();
  });

  it("an empty stories array is silence too, not zero storeys", () => {
    expect(storiesToShow([model([])], 3)).toBe(3);
  });

  it("falls back to the typed number when there is no model", () => {
    expect(storiesToShow([{ features: {} }], 3)).toBe(3);
    expect(storiesToShow([], 3)).toBe(3);
    expect(storiesToShow(null, 3)).toBe(3);
  });

  it("nobody said is a fine answer", () => {
    expect(storiesToShow([], null)).toBeNull();
    expect(storiesToShow([], 0)).toBeNull();
    expect(storiesToShow(undefined, undefined)).toBeNull();
  });
});
