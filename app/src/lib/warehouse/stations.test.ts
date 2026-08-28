// One source of truth, two consumers (the hub strip, every StationChip) —
// so this file checks the truth itself: five stations, stable numbering,
// and routes that actually exist in the router, not just spelled right.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  STATION_COMING_IN,
  STATION_FIX_MISTAKE,
  STATION_HUB_ROUTE,
  STATION_OFF_TRUCK,
  STATION_OUT_DOOR,
  STATION_PUT_AWAY,
  STATIONS,
  stationNumeral,
} from "./stations";

describe("STATIONS", () => {
  it("has exactly five stations", () => {
    expect(STATIONS).toHaveLength(5);
  });

  it("numbers 1 through 5, in array order — the numbering wave F froze", () => {
    STATIONS.forEach((s, i) => {
      expect(s.number).toBe(i + 1);
    });
  });

  it("names the flow the owner approved, verb first, coming-in to fix-a-mistake", () => {
    expect(STATIONS.map((s) => s.name)).toEqual([
      "Coming in",
      "Off the truck",
      "Put away",
      "Out the door",
      "Fix a mistake",
    ]);
  });

  it("gives every station a when-you're-here line and at least one route", () => {
    for (const s of STATIONS) {
      expect(s.when.trim().length).toBeGreaterThan(0);
      expect(s.routes.length).toBeGreaterThan(0);
    }
  });

  it("keeps the named handles in sync with the array (STATIONS[n] === STATION_X)", () => {
    expect(STATION_COMING_IN).toBe(STATIONS[0]);
    expect(STATION_OFF_TRUCK).toBe(STATIONS[1]);
    expect(STATION_PUT_AWAY).toBe(STATIONS[2]);
    expect(STATION_OUT_DOOR).toBe(STATIONS[3]);
    expect(STATION_FIX_MISTAKE).toBe(STATIONS[4]);
  });

  it("routes resolve: every station route is a path App.tsx actually registers", () => {
    // No router needed — App.tsx's JSX is the ground truth for what
    // resolves, so read it directly rather than mounting the whole app.
    const appTsx = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "../../App.tsx"),
      "utf8",
    );
    const declared = new Set(
      [...appTsx.matchAll(/<Route\s+path="([^"]+)"/g)].map((m) => m[1]),
    );
    for (const s of STATIONS) {
      for (const route of s.routes) {
        // "/warehouse#in-storage" is an anchor into a section already on
        // the hub — only the part before the "#" is a route.
        const [path] = route.split("#");
        expect(declared.has(path), `${route} (station ${s.number}) has no matching <Route>`).toBe(
          true,
        );
      }
    }
  });
});

describe("stationNumeral", () => {
  it("returns a distinct circled glyph per station, in number order", () => {
    const glyphs = STATIONS.map((s) => stationNumeral(s.number));
    expect(glyphs).toEqual(["①", "②", "③", "④", "⑤"]);
    expect(new Set(glyphs).size).toBe(5);
  });
});

describe("STATION_HUB_ROUTE", () => {
  it("points at the warehouse hub — every chip taps back here", () => {
    expect(STATION_HUB_ROUTE).toBe("/warehouse");
  });
});
