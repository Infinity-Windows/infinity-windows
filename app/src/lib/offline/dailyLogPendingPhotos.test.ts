import { describe, expect, it, vi } from "vitest";
import {
  addDailyLogPendingPhoto,
  dailyLogPhotoPath,
  listDailyLogPendingPhotos,
  memoryDailyLogPendingPhotoStore,
  reconcileDailyLogPendingPhotos,
  removeDailyLogPendingPhotos,
  type DailyLogPendingPhoto,
} from "./dailyLogPendingPhotos";

function photo(over: Partial<DailyLogPendingPhoto> = {}): DailyLogPendingPhoto {
  return {
    id: "p1", ownerId: "ana", projectId: "job-1", logDate: "2026-10-01",
    blob: new Blob(["x"]), contentType: "image/jpeg",
    lat: null, lng: null, accuracyM: null, takenAt: null, createdBy: "ana@forge.test",
    capturedAt: 1000,
    ...over,
  };
}

describe("dailyLogPhotoPath", () => {
  it("matches Astra's protected object shape, bucket prefix excluded", () => {
    expect(dailyLogPhotoPath("job-1", "log-1", "uid-1", "client-1")).toBe(
      "job-1/daily-logs/log-1/uid-1/client-1.jpg",
    );
  });
});

describe("pending photo store (memory)", () => {
  it("round-trips, scoped to owner+project+date", async () => {
    const s = memoryDailyLogPendingPhotoStore();
    await addDailyLogPendingPhoto(photo({ id: "a" }), s);
    await addDailyLogPendingPhoto(photo({ id: "b", logDate: "2026-10-02" }), s);
    await addDailyLogPendingPhoto(photo({ id: "c", ownerId: "ben" }), s);
    const mine = await listDailyLogPendingPhotos("ana", "job-1", "2026-10-01", s);
    expect(mine.map((p) => p.id)).toEqual(["a"]);
  });

  it("removes only the ids given", async () => {
    const s = memoryDailyLogPendingPhotoStore();
    await addDailyLogPendingPhoto(photo({ id: "a" }), s);
    await addDailyLogPendingPhoto(photo({ id: "b" }), s);
    await removeDailyLogPendingPhotos(["a"], s);
    const left = await listDailyLogPendingPhotos("ana", "job-1", "2026-10-01", s);
    expect(left.map((p) => p.id)).toEqual(["b"]);
  });

  it("failed storage is surfaced before capture or handoff can claim success", async () => {
    const broken = {
      add: vi.fn().mockRejectedValue(new Error("quota")),
      listFor: vi.fn().mockRejectedValue(new Error("quota")),
      remove: vi.fn().mockRejectedValue(new Error("quota")),
    };
    await expect(addDailyLogPendingPhoto(photo(), broken)).rejects.toThrow("quota");
    await expect(listDailyLogPendingPhotos("ana", "job-1", "2026-10-01", broken)).rejects.toThrow("quota");
    await expect(reconcileDailyLogPendingPhotos({ownerId:"ana",projectId:"job-1",logDate:"2026-10-01",dailyLogId:"log",uploaderUid:"ana"},vi.fn(),broken)).rejects.toThrow("quota");
    await expect(addDailyLogPendingPhoto(photo(),null)).rejects.toThrow("unavailable");
    await expect(removeDailyLogPendingPhotos(["a"], broken)).resolves.toBeUndefined();
  });
});

describe("reconcileDailyLogPendingPhotos", () => {
  it("uploads every pending photo for that job-day with the SAME client id, then clears them", async () => {
    const s = memoryDailyLogPendingPhotoStore();
    await addDailyLogPendingPhoto(photo({ id: "a" }), s);
    await addDailyLogPendingPhoto(photo({ id: "b" }), s);
    const upload = vi.fn().mockResolvedValue("entry-id");
    const result = await reconcileDailyLogPendingPhotos(
      { ownerId: "ana", projectId: "job-1", logDate: "2026-10-01", dailyLogId: "log-9", uploaderUid: "uid-1" },
      upload,
      s,
    );
    expect(result).toEqual({ reconciled: 2, failed: 0 });
    expect(upload).toHaveBeenCalledTimes(2);
    expect(upload.mock.calls[0][0]).toMatchObject({
      clientId: "a", dailyLogId: "log-9", projectId: "job-1",
      path: "job-1/daily-logs/log-9/uid-1/a.jpg",
    });
    expect(await listDailyLogPendingPhotos("ana", "job-1", "2026-10-01", s)).toEqual([]);
  });

  it("leaves a photo pending when its upload throws, and still reconciles the rest", async () => {
    const s = memoryDailyLogPendingPhotoStore();
    await addDailyLogPendingPhoto(photo({ id: "a" }), s);
    await addDailyLogPendingPhoto(photo({ id: "b" }), s);
    const upload = vi.fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce("entry-id");
    const result = await reconcileDailyLogPendingPhotos(
      { ownerId: "ana", projectId: "job-1", logDate: "2026-10-01", dailyLogId: "log-9", uploaderUid: "uid-1" },
      upload,
      s,
    );
    expect(result).toEqual({ reconciled: 1, failed: 1 });
    const left = await listDailyLogPendingPhotos("ana", "job-1", "2026-10-01", s);
    expect(left.map((p) => p.id)).toEqual(["a"]);
  });

  it("never touches another owner's or another job-day's pending photos", async () => {
    const s = memoryDailyLogPendingPhotoStore();
    await addDailyLogPendingPhoto(photo({ id: "mine" }), s);
    await addDailyLogPendingPhoto(photo({ id: "other-owner", ownerId: "ben" }), s);
    await addDailyLogPendingPhoto(photo({ id: "other-day", logDate: "2026-10-02" }), s);
    const upload = vi.fn().mockResolvedValue("entry-id");
    await reconcileDailyLogPendingPhotos(
      { ownerId: "ana", projectId: "job-1", logDate: "2026-10-01", dailyLogId: "log-9", uploaderUid: "uid-1" },
      upload,
      s,
    );
    expect(upload).toHaveBeenCalledTimes(1);
    const benLeft = await listDailyLogPendingPhotos("ben", "job-1", "2026-10-01", s);
    expect(benLeft.map((p) => p.id)).toEqual(["other-owner"]);
  });
});
