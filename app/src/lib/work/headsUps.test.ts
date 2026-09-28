import { describe, expect, it } from "vitest";
import { headsUps, MAX_HEADS_UPS, PHOTO_UNSENT_AFTER_MS, type HeadsUpsInput } from "./headsUps";

const NOW = new Date("2026-10-06T16:00:00Z").getTime();

function input(over: Partial<HeadsUpsInput>): HeadsUpsInput {
  return {
    now: NOW,
    assignments: [],
    unsentPhotoCount: 0,
    oldestUnsentPhotoAt: null,
    onClock: false,
    talkExists: null,
    signedToday: null,
    qcDueCount: 0,
    ...over,
  };
}

describe("headsUps (K1.9: rule-based, on Work only)", () => {
  it("says nothing when nothing is wrong", () => {
    expect(headsUps(input({}))).toEqual([]);
  });

  it("flags an unsigned toolbox talk only while on the clock and only when positively known", () => {
    expect(headsUps(input({ onClock: true, talkExists: true, signedToday: false })).map((h) => h.id)).toEqual(["toolbox-unsigned"]);
    expect(headsUps(input({ onClock: false, talkExists: true, signedToday: false }))).toEqual([]);
    expect(headsUps(input({ onClock: true, talkExists: null, signedToday: false }))).toEqual([]);
    expect(headsUps(input({ onClock: true, talkExists: true, signedToday: true }))).toEqual([]);
  });

  it("flags photos unsent for over an hour, with the count, pointing at the stuck list", () => {
    const old = NOW - PHOTO_UNSENT_AFTER_MS - 1;
    const one = headsUps(input({ unsentPhotoCount: 1, oldestUnsentPhotoAt: old }));
    expect(one).toEqual([{ id: "photo-unsent", key: "work.headsUp.photo.one", vars: { n: 1 }, to: "/stuck" }]);
    const many = headsUps(input({ unsentPhotoCount: 3, oldestUnsentPhotoAt: old }));
    expect(many[0]).toMatchObject({ key: "work.headsUp.photo.many", vars: { n: 3 } });
    // A photo queued five minutes ago is not news yet.
    expect(headsUps(input({ unsentPhotoCount: 1, oldestUnsentPhotoAt: NOW - 5 * 60_000 }))).toEqual([]);
  });

  it("flags a changed assignment, pointing at the Schedule", () => {
    const changed = { status: "published" as const, published_at: "2026-10-01T12:00:00Z", updated_at: "2026-10-05T20:00:00Z" };
    expect(headsUps(input({ assignments: [changed] }))).toEqual([
      { id: "assignment-changed", key: "work.headsUp.assignment", to: "/my-schedule" },
    ]);
  });

  it("flags units waiting for QC for a lead", () => {
    expect(headsUps(input({ qcDueCount: 2 }))[0]).toMatchObject({ id: "qc-due", key: "work.headsUp.qc.many", vars: { n: 2 }, to: "/qc" });
  });

  it("orders safety first and never shows more than three", () => {
    const all = headsUps(
      input({
        onClock: true,
        talkExists: true,
        signedToday: false,
        unsentPhotoCount: 1,
        oldestUnsentPhotoAt: NOW - 2 * PHOTO_UNSENT_AFTER_MS,
        assignments: [{ status: "published", published_at: "2026-10-01T12:00:00Z", updated_at: "2026-10-05T20:00:00Z" }],
        qcDueCount: 1,
      }),
    );
    expect(all).toHaveLength(MAX_HEADS_UPS);
    expect(all.map((h) => h.id)).toEqual(["toolbox-unsigned", "photo-unsent", "assignment-changed"]);
  });
});
