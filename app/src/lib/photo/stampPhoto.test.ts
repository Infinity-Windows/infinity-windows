import { describe, it, expect } from "vitest";
import {
  composeStampLines,
  formatCoords,
  formatStampTime,
  toPhotoMetaFields,
  type StampMeta,
} from "./stampPhoto";

describe("formatCoords", () => {
  it("formats a valid pair to 4 decimals", () => {
    expect(formatCoords(37.7749295, -122.4194155)).toBe("37.7749, -122.4194");
  });

  it("returns null when either coordinate is missing or invalid", () => {
    expect(formatCoords(null, -122.4)).toBeNull();
    expect(formatCoords(37.7, null)).toBeNull();
    expect(formatCoords(undefined, undefined)).toBeNull();
    expect(formatCoords(Number.NaN, 1)).toBeNull();
  });
});

describe("formatStampTime", () => {
  it("renders date and time with a dot separator (UTC pinned)", () => {
    const d = new Date("2026-07-21T13:16:00Z");
    expect(formatStampTime(d, "UTC")).toBe("Jul 21, 2026 · 1:16 PM");
  });
});

describe("composeStampLines", () => {
  const base: StampMeta = { takenAt: new Date("2026-07-21T13:16:00Z") };

  it("includes label, time, and GPS with accuracy when present", () => {
    const lines = composeStampLines(
      { ...base, label: "J-1042", lat: 37.7749, lng: -122.4194, accuracyM: 8.6 },
      "UTC",
    );
    expect(lines).toEqual([
      "J-1042",
      "Jul 21, 2026 · 1:16 PM",
      "GPS 37.7749, -122.4194  ±9m",
    ]);
  });

  it("omits the GPS line when there is no fix", () => {
    const lines = composeStampLines({ ...base, label: "J-1042" }, "UTC");
    expect(lines).toEqual(["J-1042", "Jul 21, 2026 · 1:16 PM"]);
  });

  it("omits the label line when unset and shows GPS without accuracy", () => {
    const lines = composeStampLines(
      { ...base, lat: 37.7749, lng: -122.4194 },
      "UTC",
    );
    expect(lines).toEqual(["Jul 21, 2026 · 1:16 PM", "GPS 37.7749, -122.4194"]);
  });

  it("drops a blank label", () => {
    const lines = composeStampLines({ ...base, label: "   " }, "UTC");
    expect(lines).toEqual(["Jul 21, 2026 · 1:16 PM"]);
  });
});

describe("toPhotoMetaFields", () => {
  it("passes through a full fix and ISO timestamp", () => {
    const fields = toPhotoMetaFields({
      takenAt: new Date("2026-07-21T13:16:00Z"),
      lat: 37.7749,
      lng: -122.4194,
      accuracyM: 8.6,
    });
    expect(fields).toEqual({
      lat: 37.7749,
      lng: -122.4194,
      accuracyM: 8.6,
      takenAt: "2026-07-21T13:16:00.000Z",
    });
  });

  it("nulls out missing/invalid geo but keeps the timestamp", () => {
    const fields = toPhotoMetaFields({
      takenAt: new Date("2026-07-21T13:16:00Z"),
      lat: null,
      lng: Number.NaN,
    });
    expect(fields).toEqual({
      lat: null,
      lng: null,
      accuracyM: null,
      takenAt: "2026-07-21T13:16:00.000Z",
    });
  });
});
