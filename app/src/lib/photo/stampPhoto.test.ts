import { describe, it, expect } from "vitest";
import {
  capturePhotoMeta,
  composeStampLines,
  formatCoords,
  formatStampTime,
  shrinkPhoto,
  shrinkPhotoFile,
  stampPhoto,
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

describe("capturePhotoMeta", () => {
  // The time-only path, unchanged by the warm-fix work: on a device with no
  // geolocation at all (this test runner, and a browser with the API missing),
  // the stamp still goes out with a real timestamp and the label, and the geo
  // fields are null rather than absent. This is the shape the watermark and the
  // attachments row both read, and it must never come back half-filled.
  it("stamps time-only when the device has no fix to give", async () => {
    const before = Date.now();
    const meta = await capturePhotoMeta("BLACK22 · 1-1");
    expect(meta.lat).toBeNull();
    expect(meta.lng).toBeNull();
    expect(meta.accuracyM).toBeNull();
    expect(meta.label).toBe("BLACK22 · 1-1");
    expect(meta.takenAt.getTime()).toBeGreaterThanOrEqual(before);
    expect(toPhotoMetaFields(meta)).toMatchObject({
      lat: null,
      lng: null,
      accuracyM: null,
    });
  });

  it("keeps a missing label as null rather than undefined", async () => {
    const meta = await capturePhotoMeta();
    expect(meta.label).toBeNull();
  });
});

describe("stampPhoto and shrinkPhoto share one render, and both degrade", () => {
  // The two differ by an overlay and nothing else. shrinkPhoto exists so an
  // unstamped capture — a photo of a card, where a GPS fix says nothing true —
  // still gets the shrink and re-encode every upload in this app counts on;
  // "no watermark" must not quietly mean "no processing".
  const blob = new Blob(["not a decodable image"], { type: "image/jpeg" });
  const meta: StampMeta = { takenAt: new Date("2026-07-21T13:16:00Z") };

  it("hands the ORIGINAL back when there is no canvas or the bytes will not decode", async () => {
    // Capture must never break because a browser could not draw. Both paths
    // return the input untouched rather than a null or a throw.
    await expect(shrinkPhoto(blob)).resolves.toBe(blob);
    await expect(stampPhoto(blob, meta)).resolves.toBe(blob);
  });

  it("keeps a sensible .jpg name and type on the File wrappers", async () => {
    const picked = new File([blob], "IMG_4821.HEIC", { type: "image/heic" });
    const out = await shrinkPhotoFile(picked);
    expect(out.name).toBe("IMG_4821.jpg");
    expect(out.type).toBe("image/jpeg");
  });

  it("does not leave a file with no name at all", async () => {
    const out = await shrinkPhotoFile(new File([blob], "", { type: "image/jpeg" }));
    expect(out.name).toBe("photo.jpg");
  });
});
