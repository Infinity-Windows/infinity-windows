// Pure notify-diff + copy for travel. Publishing/changing a trip pushes the
// assigned crew (reusing the existing web-push system). Bodies are deliberately
// generic — NEVER put wifi/door/confirmation codes in a notification body.

export interface CrewDiff {
  added: string[];
  removed: string[];
  retained: string[];
}

/** Set diff of two crew-id lists (order-independent, de-duplicated). */
export function diffCrew(
  before: readonly string[],
  after: readonly string[],
): CrewDiff {
  const beforeSet = new Set(before);
  const afterSet = new Set(after);
  const added: string[] = [];
  const removed: string[] = [];
  const retained: string[] = [];
  for (const id of afterSet) {
    if (beforeSet.has(id)) retained.push(id);
    else added.push(id);
  }
  for (const id of beforeSet) {
    if (!afterSet.has(id)) removed.push(id);
  }
  return { added, removed, retained };
}

export interface TripEditNotifyInput {
  crewBefore: readonly string[];
  crewAfter: readonly string[];
  /** True when trip dates/details the whole crew cares about changed. */
  detailsChanged: boolean;
}

/**
 * Who to (re)notify after editing an already-published trip: everyone added or
 * removed, plus everyone retained IF the shared details changed. No change →
 * nobody.
 */
export function affectedByTripEdit(input: TripEditNotifyInput): string[] {
  const { added, removed, retained } = diffCrew(input.crewBefore, input.crewAfter);
  const out = new Set<string>([...added, ...removed]);
  if (input.detailsChanged) for (const id of retained) out.add(id);
  return [...out];
}

/** Push copy when a trip is first published to its crew. */
export function tripPublishMessage(tripName: string): { title: string; body: string } {
  return {
    title: "Travel details ready",
    body: `Your trip "${tripName}" is published. Tap to see flights, lodging, and more.`,
  };
}

/** Push copy when a published trip changes. Never includes codes. */
export function tripChangeMessage(tripName: string): { title: string; body: string } {
  return {
    title: "Travel details updated",
    body: `"${tripName}" changed. Tap to check your latest flights and plans.`,
  };
}

/** Push copy for someone removed from a published trip. */
export function tripRemovalMessage(): { title: string; body: string } {
  return {
    title: "Trip updated",
    body: "You were removed from a trip. Tap to check your travel.",
  };
}
