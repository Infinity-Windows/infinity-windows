import { describe, it, expect } from "vitest";
import { autoOpenBeforeSlot } from "./beforePhotoGate";

const CHAINED_AT = "2026-09-04T15:00:00.000Z";

describe("autoOpenBeforeSlot", () => {
  it("opens the camera on a chained arrival that owes a before photo", () => {
    expect(
      autoOpenBeforeSlot({
        chainedAt: CHAINED_AT,
        hasBeforePhoto: false,
        autoOpenSpent: false,
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
        autoOpenSpent: false,
      }),
    ).toBeNull();
  });

  it("does not reopen over a photo already taken", () => {
    expect(
      autoOpenBeforeSlot({
        chainedAt: CHAINED_AT,
        hasBeforePhoto: true,
        autoOpenSpent: false,
      }),
    ).toBeNull();
  });

  it("stays shut once it has opened, however many times the step is left and returned to", () => {
    // The card lives inside step 1, so stepping to "2. Install" and back
    // remounts it. Everything else about this state is unchanged from the
    // first line of this file — the chain stamp is still set and there is
    // still no photo — so only the sheet's own memory can keep the camera
    // from taking over the screen a second time.
    expect(
      autoOpenBeforeSlot({
        chainedAt: CHAINED_AT,
        hasBeforePhoto: false,
        autoOpenSpent: true,
      }),
    ).toBeNull();
  });
});
