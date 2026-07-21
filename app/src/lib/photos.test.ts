import { describe, it, expect } from "vitest";
import { groupPhotosByDay, photoTime } from "./photos";

describe("photoTime", () => {
  it("prefers the capture time over the server insert time", () => {
    expect(
      photoTime({ takenAt: "2026-07-20T10:00:00Z", createdAt: "2026-07-21T10:00:00Z" }),
    ).toBe("2026-07-20T10:00:00Z");
  });

  it("falls back to created_at when there is no capture time", () => {
    expect(photoTime({ takenAt: null, createdAt: "2026-07-21T10:00:00Z" })).toBe(
      "2026-07-21T10:00:00Z",
    );
  });
});

describe("groupPhotosByDay", () => {
  it("buckets photos into day groups, preserving newest-first order (UTC)", () => {
    const photos = [
      { id: "a", takenAt: "2026-07-21T18:00:00Z", createdAt: "2026-07-21T18:00:00Z" },
      { id: "b", takenAt: "2026-07-21T09:00:00Z", createdAt: "2026-07-21T09:00:00Z" },
      { id: "c", takenAt: null, createdAt: "2026-07-20T23:30:00Z" },
    ];
    const groups = groupPhotosByDay(photos, "UTC");
    expect(groups.map((g) => g.key)).toEqual(["2026-07-21", "2026-07-20"]);
    expect(groups[0].label).toBe("Tue, Jul 21, 2026");
    expect(groups[0].photos.map((p) => (p as { id: string }).id)).toEqual(["a", "b"]);
    expect(groups[1].photos.map((p) => (p as { id: string }).id)).toEqual(["c"]);
  });

  it("returns an empty array for no photos", () => {
    expect(groupPhotosByDay([], "UTC")).toEqual([]);
  });
});
