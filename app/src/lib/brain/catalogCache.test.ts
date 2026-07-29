import { describe, expect, it } from "vitest";
import { shouldRefresh, toCatalogType } from "./catalogCache";
import { CATALOG_SNAPSHOT } from "./catalogSnapshot";

const HOUR = 60 * 60 * 1000;
const now = Date.parse("2026-07-29T12:00:00Z");

describe("refreshing the catalog", () => {
  it("does nothing with no signal — the bundled brain already answers", () => {
    expect(shouldRefresh(null, now, false)).toBe(false);
    expect(
      shouldRefresh({ fetchedAt: "2020-01-01T00:00:00Z", types: [] }, now, false),
    ).toBe(false);
  });

  it("fetches once when there is nothing cached", () => {
    expect(shouldRefresh(null, now, true)).toBe(true);
  });

  it("leaves a fresh cache alone", () => {
    const fetchedAt = new Date(now - HOUR / 2).toISOString();
    expect(shouldRefresh({ fetchedAt, types: [] }, now, true)).toBe(false);
  });

  it("refreshes an hour-old cache", () => {
    const fetchedAt = new Date(now - 2 * HOUR).toISOString();
    expect(shouldRefresh({ fetchedAt, types: [] }, now, true)).toBe(true);
  });

  it("refreshes rather than trusting a corrupt timestamp", () => {
    expect(shouldRefresh({ fetchedAt: "not a date", types: [] }, now, true)).toBe(true);
  });
});

describe("mapping a database row", () => {
  it("keeps everything the brain searches and nothing it doesn't", () => {
    expect(
      toCatalogType({
        type_code: "SH3252",
        name: "Single-Hung 32x52",
        category: "single-hung",
        width_in: 32,
        height_in: 52,
        difficulty_rating: 1,
        notes: null,
        tips_json: ["Drain side out"],
        watch_outs_json: [],
        howto_json: [{ title: "Dry-fit", detail: "Set it without sealant" }],
      }),
    ).toEqual({
      c: "SH3252",
      n: "Single-Hung 32x52",
      cat: "single-hung",
      w: 32,
      h: 52,
      d: 1,
      t: ["Drain side out"],
      hw: [{ t: "Dry-fit", d: "Set it without sealant" }],
    });
  });

  it("survives a row with nothing filled in", () => {
    expect(
      toCatalogType({
        type_code: "AWN2418",
        name: "Awning 24x18",
        category: null,
        width_in: null,
        height_in: null,
        difficulty_rating: null,
        notes: null,
        tips_json: null,
        watch_outs_json: null,
        howto_json: null,
      }),
    ).toEqual({ c: "AWN2418", n: "Awning 24x18" });
  });
});

describe("the brain that ships in the bundle", () => {
  it("holds the 102 real catalog types and no provisional ones", () => {
    expect(CATALOG_SNAPSHOT).toHaveLength(102);
    expect(CATALOG_SNAPSHOT.every((t) => !/^mark/i.test(t.n))).toBe(true);
  });

  it("is small enough to live on a phone — well under 40 KB", () => {
    const bytes = JSON.stringify(CATALOG_SNAPSHOT).length;
    expect(bytes).toBeLessThan(40 * 1024);
  });

  it("carries the 88 seeded tip and watch-out lines", () => {
    const lines = CATALOG_SNAPSHOT.reduce(
      (sum, t) => sum + (t.t?.length ?? 0) + (t.x?.length ?? 0),
      0,
    );
    expect(lines).toBe(88);
  });
});
