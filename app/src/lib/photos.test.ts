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

  it("sorts delayed uploads by capture date across jobs and by time within each day", () => {
    // Server upload order reproduces the gallery's Sep 9 / Sep 21 / Sep 8 jump.
    const photos = [
      { id: "sep9-early", projectId: "job-a", takenAt: "2026-09-09T10:25:00Z", createdAt: "2026-10-01T12:00:00Z" },
      { id: "sep21-early", projectId: "job-b", takenAt: "2026-09-21T09:40:00Z", createdAt: "2026-10-01T11:00:00Z" },
      { id: "sep8", projectId: "job-c", takenAt: "2026-09-08T16:17:00Z", createdAt: "2026-10-01T10:00:00Z" },
      { id: "sep21-late", projectId: "job-b", takenAt: "2026-09-21T13:55:00Z", createdAt: "2026-10-01T09:00:00Z" },
      { id: "sep9-late", projectId: "job-a", takenAt: "2026-09-09T11:12:00Z", createdAt: "2026-10-01T08:00:00Z" },
    ];
    const original = [...photos];
    const groups = groupPhotosByDay(Object.freeze(photos), "UTC");

    expect(groups.map((g) => g.key)).toEqual(["2026-09-21", "2026-09-09", "2026-09-08"]);
    expect(groups.map((g) => g.photos.map((p) => p.id))).toEqual([
      ["sep21-late", "sep21-early"], ["sep9-late", "sep9-early"], ["sep8"],
    ]);
    expect(photos).toEqual(original);
    expect(groups[0].photos[0]).toBe(photos[3]);
  });

  it("sorts missing capture times by insert time and compares timezone offsets as instants", () => {
    const photos = [
      { id: "earlier", takenAt: "2026-09-21T10:00:00+02:00", createdAt: "2026-10-01T12:00:00Z" },
      { id: "fallback", takenAt: null, createdAt: "2026-09-21T09:00:00Z" },
      { id: "latest", takenAt: "2026-09-21T07:00:00-06:00", createdAt: "2026-09-21T13:00:00Z" },
    ];
    expect(groupPhotosByDay(photos, "UTC")[0].photos.map((p) => p.id)).toEqual([
      "latest", "fallback", "earlier",
    ]);
  });

  it("keeps local-day boundaries and stable order for matching capture times", () => {
    const photos = [
      { id: "previous-day", takenAt: "2026-09-22T05:59:00Z", createdAt: "2026-10-01T12:00:00Z" },
      { id: "a", takenAt: "2026-09-22T06:01:00Z", createdAt: "2026-09-22T06:01:00Z" },
      { id: "b", takenAt: "2026-09-22T06:01:00Z", createdAt: "2026-09-22T06:02:00Z" },
    ];
    const groups = groupPhotosByDay(photos, "America/Denver");
    expect(groups.map((g) => g.key)).toEqual(["2026-09-22", "2026-09-21"]);
    expect(groups[0].photos.map((p) => p.id)).toEqual(["a", "b"]);
  });
});
