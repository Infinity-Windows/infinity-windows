// When the before-photo card is on the unit sheet, and when the camera opens
// straight to it.
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
// The gate is keyed on the photo instead of the clock. The unit's own gates,
// before photo included, stay on its sheet (CONTEXT.md, standing decisions) —
// nothing here touches the clock, and nothing here is a new Submit
// requirement: a chained unit still files with whatever it has.

export interface BeforePhotoState {
  /** When work began, as the sheet resolved it. A chained arrival always has one. */
  startedAt: string | null;
  /** Has a before photo been taken for THIS round? (Not yet filed — it lives
   * in the sheet's own state until Submit hands it to the outbox.) */
  hasBeforePhoto: boolean;
}

/**
 * Should the before-photo card be on screen?
 *
 * Two reasons for yes, and they are different reasons:
 *  - this round has no before photo yet — the chained case, and the whole point
 *    of the change;
 *  - the clock has not started — where the card is ALSO the start gate, so it
 *    stays put with its filled slot and its Retake button once a shot is taken.
 */
export function showBeforePhotoCard(state: BeforePhotoState): boolean {
  return !state.startedAt || !state.hasBeforePhoto;
}

/**
 * True when the card is hidden ONLY because the photo is already in hand. The
 * sheet says so in one line, so a shutter tap that makes the card disappear
 * never reads as a photo that went nowhere.
 */
export function beforePhotoIsInHand(state: BeforePhotoState): boolean {
  return !showBeforePhotoCard(state);
}

export interface BeforeAutoOpenState extends BeforePhotoState {
  /** The chain hand-off stamp carried in on arrival, or null. */
  chainedAt: string | null;
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
