import { describe, it, expect } from "vitest";
import {
  autoOpenBeforeSlot,
  beforePhotoIsInHand,
  showBeforePhotoCard,
} from "./beforePhotoGate";

const CHAINED_AT = "2026-09-04T15:00:00.000Z";
const STARTED_AT = "2026-09-04T15:00:01.000Z";

describe("showBeforePhotoCard", () => {
  it("shows the card on a fresh unit, before or after the shot is taken", () => {
    // The unchanged non-chained path: the card is the start gate, so it stays
    // put with its Retake button once a bad first shot has been taken.
    expect(
      showBeforePhotoCard({ startedAt: null, hasBeforePhoto: false }),
    ).toBe(true);
    expect(showBeforePhotoCard({ startedAt: null, hasBeforePhoto: true })).toBe(
      true,
    );
  });

  it("shows the card on a chained unit — the case the old clock gate missed", () => {
    // A chained arrival has work_started_at stamped server-side before the
    // sheet ever renders, so "no start time" was never true and the card never
    // appeared. This is the whole bug.
    expect(
      showBeforePhotoCard({ startedAt: STARTED_AT, hasBeforePhoto: false }),
    ).toBe(true);
  });

  it("drops the card once the running unit has its before photo", () => {
    expect(
      showBeforePhotoCard({ startedAt: STARTED_AT, hasBeforePhoto: true }),
    ).toBe(false);
  });
});

describe("beforePhotoIsInHand", () => {
  it("is true only when the card is hidden because the shot exists", () => {
    expect(
      beforePhotoIsInHand({ startedAt: STARTED_AT, hasBeforePhoto: true }),
    ).toBe(true);
    // Nothing to reassure anybody about in any other state.
    expect(
      beforePhotoIsInHand({ startedAt: STARTED_AT, hasBeforePhoto: false }),
    ).toBe(false);
    expect(
      beforePhotoIsInHand({ startedAt: null, hasBeforePhoto: true }),
    ).toBe(false);
  });
});

describe("autoOpenBeforeSlot", () => {
  it("opens the camera on a chained arrival that owes a before photo", () => {
    expect(
      autoOpenBeforeSlot({
        chainedAt: CHAINED_AT,
        startedAt: STARTED_AT,
        hasBeforePhoto: false,
      }),
    ).toBe("before");
  });

  it("never opens a camera the person did not ask for on a normal arrival", () => {
    // Walking to a window and tapping Start is a deliberate act with the card
    // already in front of them; a camera opening itself there would be rude.
    expect(
      autoOpenBeforeSlot({
        chainedAt: null,
        startedAt: null,
        hasBeforePhoto: false,
      }),
    ).toBeNull();
  });

  it("does not reopen over a photo already taken", () => {
    expect(
      autoOpenBeforeSlot({
        chainedAt: CHAINED_AT,
        startedAt: STARTED_AT,
        hasBeforePhoto: true,
      }),
    ).toBeNull();
  });
});
