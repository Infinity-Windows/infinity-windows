// Pure helpers for the receiving side of the tracking chain.
//
// Phase 1 pre-issues a `pre_issued` windows row per expected unit. Receiving
// (Phase 2) activates each unit as it physically arrives (status leaves
// pre_issued). The expected-vs-received readout is just a count over the
// project's tracked units, extracted here so it is unit-testable without a DB.

import type { WindowStatus } from "./types";

export interface UnitStatusLike {
  status: WindowStatus;
}

export interface DeliveryProgress {
  /** Total tracked units for the project (pre-issued + already received). */
  expected: number;
  /** Units that have been received (activated — no longer pre_issued). */
  received: number;
  /** Units still awaiting arrival (status pre_issued). */
  preIssuedRemaining: number;
  /** Received units currently flagged damaged / held. */
  damaged: number;
}

/**
 * Roll a project's tracked units into an expected-vs-received readout. A unit
 * still `pre_issued` is awaiting arrival; any other status counts as received.
 * "expected" is every tracked unit so the readout reads "Received X of Y".
 */
export function computeDeliveryProgress(
  units: UnitStatusLike[],
): DeliveryProgress {
  let expected = 0;
  let received = 0;
  let preIssuedRemaining = 0;
  let damaged = 0;
  for (const u of units) {
    expected += 1;
    if (u.status === "pre_issued") {
      preIssuedRemaining += 1;
    } else {
      received += 1;
    }
    if (u.status === "damaged") {
      damaged += 1;
    }
  }
  return { expected, received, preIssuedRemaining, damaged };
}
