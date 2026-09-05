import { describe, it, expect } from "vitest";
import { autoOpenBeforeSlot } from "./beforePhotoGate";

const CHAINED_AT = "2026-09-04T15:00:00.000Z";

describe("autoOpenBeforeSlot", () => {
  it("opens the camera on a chained arrival that owes a before photo", () => {
    expect(
      autoOpenBeforeSlot({
        chainedAt: CHAINED_AT,
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
        hasBeforePhoto: false,
      }),
    ).toBeNull();
  });

  it("does not reopen over a photo already taken", () => {
    expect(
      autoOpenBeforeSlot({
        chainedAt: CHAINED_AT,
        hasBeforePhoto: true,
      }),
    ).toBeNull();
  });
});
