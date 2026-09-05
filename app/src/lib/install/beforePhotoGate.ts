// The before photo on the unit sheet: why it has no show/hide gate any more,
// and the one thing that is still a decision — whether the camera opens itself
// on arrival.
//
// WHY THIS IS ITS OWN FILE. The card used to render only while the unit had no
// start time. That condition was written when Start was the only way a clock
// began, and it was correct then. Two standing decisions later made it
// unreachable on the path the app is actually built around: Finish never stops
// the clock, it CHAINS — finish_unit starts the next unit's session server-side
// in the same transaction — so a chained unit's sheet opens with
// `work_started_at` already stamped. The card never rendered, the Capture stage
// offered only the after slot, and both photos are filed at Submit from what is
// on screen. So every unit after the first of the day filed with no before
// photo, permanently, on the DEFAULT loop.
//
// Keying the card on the photo instead of the clock fixed that and bought a
// smaller version of the same bug: the card vanished the instant a shot landed,
// taking its Retake button with it, and the Capture stage offers only the after
// slot — so a black frame or a pocket shot, which the camera opening itself
// makes likelier, was filed with no way to replace it. There is no gate at all
// now. The before photo is step 1 of the sheet; it stays on step 1, filled or
// empty, until the unit is filed, exactly as the pre-start path always behaved.
// The unit's own gates, before photo included, stay on its sheet (CONTEXT.md,
// standing decisions), and nothing here touches the clock or adds a Submit
// requirement: a chained unit still files with whatever it has.

export interface BeforeAutoOpenState {
  /** The chain hand-off stamp carried in on arrival, or null. */
  chainedAt: string | null;
  /** Has a before photo been taken for THIS round? (Not yet filed — it lives
   * in the sheet's own state until Submit hands it to the outbox.) */
  hasBeforePhoto: boolean;
}

/**
 * Which slot the camera should open itself to on arrival, or null for none.
 *
 * Only ever the before slot, and only on a chain: the person did not tap
 * anything to get to this window — the previous unit's Finish walked them here
 * — so the one thing owed is a shutter tap, and it should cost no navigation
 * and no decision. Dismissing it is fine and changes nothing else on the sheet.
 */
export function autoOpenBeforeSlot(
  state: BeforeAutoOpenState,
): "before" | null {
  if (!state.chainedAt) return null;
  if (state.hasBeforePhoto) return null;
  return "before";
}
