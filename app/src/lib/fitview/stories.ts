// Stories: the vertical dimension of a fit-view building.
//
// A story owns its own footprint masses, its own floor datum and its own
// floor-to-plate height — because real buildings need all three: a podium
// ground floor is taller than the floors above it, and a great-room "second
// story" is a small box over one part of the plan, not a copy of it
// (docs/maps-interactive-stories-design.md).
//
// Backward compatibility is absolute: every model built before stories
// existed — Ben's hand-traced Black Desert included — is a building with no
// `stories` array, and canonicalizing it yields exactly one story whose
// footprints and height are the building's own. Nothing old re-renders
// differently.
//
// Sill heights: windows in a storied model measure `y` from THEIR OWN
// story's floor, so editing a story's height never silently moves the
// windows above it. The renderer wants absolute heights; `absoluteSill`
// is the one place that conversion happens.

export interface StoryFootprintPoint {
  x: number;
  z: number;
  name?: string;
}

export interface Story {
  /** 1-based story number; drawn bottom-up in ascending `elevM` order. */
  n: number;
  /** Display name: "Ground", "Level 2", "Mezzanine"… */
  name: string;
  /** Floor datum, metres above story 1's floor. */
  elevM: number;
  /** Floor-to-plate height of this story, metres. */
  heightM: number;
  /** This story's masses. A partial story is simply a smaller polygon. */
  footprints: StoryFootprintPoint[][];
  /** Mezzanine/loft flag: own datum, not counted like a full story. */
  partial?: boolean;
  source?: "traced" | "copied" | "detected";
}

export interface StoriedBuildingLike {
  height: number;
  footprints?: StoryFootprintPoint[][];
  stories?: unknown;
}

/** UI ceiling from the design doc; the data model itself doesn't care. */
export const MAX_STORIES = 8;

function parseStory(raw: unknown, index: number): Story | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const footprints = Array.isArray(o.footprints)
    ? (o.footprints as StoryFootprintPoint[][]).filter(
        (fp) => Array.isArray(fp) && fp.length >= 3,
      )
    : [];
  const heightM = typeof o.heightM === "number" && o.heightM > 0 ? o.heightM : null;
  if (!heightM || footprints.length === 0) return null;
  return {
    n: typeof o.n === "number" ? o.n : index + 1,
    name: typeof o.name === "string" && o.name ? o.name : `Level ${index + 1}`,
    elevM: typeof o.elevM === "number" && o.elevM >= 0 ? o.elevM : 0,
    heightM,
    footprints,
    partial: o.partial === true || undefined,
    source:
      o.source === "traced" || o.source === "copied" || o.source === "detected"
        ? o.source
        : undefined,
  };
}

/**
 * Canonical ascending story list for any building shape. A building without
 * a usable `stories` array is one story of the building's own footprints and
 * height — the exact pre-stories model.
 */
export function storiesOf(building: StoriedBuildingLike): Story[] {
  const raw = Array.isArray(building.stories) ? building.stories : [];
  const parsed = raw
    .map((s, i) => parseStory(s, i))
    .filter((s): s is Story => !!s)
    .sort((a, b) => a.elevM - b.elevM);
  if (parsed.length > 0) return parsed;
  return [
    {
      n: 1,
      name: "Ground",
      elevM: 0,
      heightM: building.height,
      footprints: (building.footprints ?? []).filter((fp) => fp.length >= 3),
    },
  ];
}

/** The story a window belongs to, by its `story` number; null = unassigned. */
export function storyForWindow(
  win: { story?: unknown },
  stories: Story[],
): Story | null {
  if (typeof win.story !== "number") return stories.length === 1 ? stories[0] : null;
  return stories.find((s) => s.n === win.story) ?? null;
}

/**
 * Absolute sill height (metres above story 1's floor) for the renderer.
 * Storied windows carry story-relative sills; single-story models keep their
 * historical absolute-y meaning (identical when the only floor is at 0).
 */
export function absoluteSill(
  win: { y?: unknown; story?: unknown },
  stories: Story[],
): number {
  const y = typeof win.y === "number" ? win.y : 0;
  const story = storyForWindow(win, stories);
  return (story?.elevM ?? 0) + y;
}

/** Floor datums above ground (for slab bands / framing rims), ascending. */
export function storyLevels(stories: Story[]): number[] {
  return stories
    .map((s) => s.elevM)
    .filter((e) => e > 0)
    .sort((a, b) => a - b);
}

/** Overall building envelope height: the highest plate of any story. */
export function envelopeHeight(stories: Story[]): number {
  return Math.max(...stories.map((s) => s.elevM + s.heightM));
}
