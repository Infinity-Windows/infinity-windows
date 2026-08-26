// The warehouse day recap (owner pick 26): "Today — 63 checked in, 41
// stored, 3 checked out, 2 still missing from Tech Ridge truck." Computed
// from the movement log the warehouse already keeps, so the day's story
// costs nothing beyond a read.
//
// Pure: the caller resolves what "today" means (local midnight — see
// localMidnightIso) and hands over already-filtered movement rows; this
// module only tallies and shapes them. "Still missing" is deliberately NOT
// scoped to today — a package minted last week and never arrived is exactly
// as missing today as one minted this morning, so it reads from every
// currently-expected package, not just today's activity.

export interface DayRecapMovement {
  event: string;
}

export interface DayRecapPackage {
  status: string;
  delivery_id: string | null;
}

export interface DayRecapDelivery {
  id: string;
  label: string;
}

export interface MissingLine {
  label: string;
  count: number;
}

export interface DayRecap {
  checkedIn: number;
  stored: number;
  checkedOut: number;
  missingByDelivery: MissingLine[];
}

/** Local midnight for `now`, as an ISO string — the cutoff a movements query
 *  reads from. Local, not UTC: "today" is whatever the device's own clock
 *  says, the same rule the timeclock already uses. */
export function localMidnightIso(now: Date): string {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
}

/** Whether the card has nothing to say — every count zero and no backlog —
 *  the one case it shows quiet-state copy instead of numbers. */
export function isRecapQuiet(recap: DayRecap): boolean {
  return (
    recap.checkedIn === 0 &&
    recap.stored === 0 &&
    recap.checkedOut === 0 &&
    recap.missingByDelivery.length === 0
  );
}

/**
 * Tally today's movements into the three counts the artifact names, and
 * group every still-"minted" (expected, never arrived) package by its
 * delivery's label. A minted package with no delivery at all (a window
 * declared ahead of any truck, e.g. mintMarkPackages) has nothing to be
 * "missing FROM" and is left out of the backlog rather than invented a
 * bucket to sit in.
 */
export function dayRecap(
  movements: DayRecapMovement[],
  packages: DayRecapPackage[],
  deliveries: DayRecapDelivery[],
): DayRecap {
  let checkedIn = 0;
  let stored = 0;
  let checkedOut = 0;
  for (const m of movements) {
    if (m.event === "received") checkedIn += 1;
    else if (m.event === "stored") stored += 1;
    else if (m.event === "checked_out") checkedOut += 1;
  }

  const labelById = new Map(deliveries.map((d) => [d.id, d.label]));
  const countByLabel = new Map<string, number>();
  for (const p of packages) {
    if (p.status !== "minted" || !p.delivery_id) continue;
    const label = labelById.get(p.delivery_id);
    if (!label) continue;
    countByLabel.set(label, (countByLabel.get(label) ?? 0) + 1);
  }
  const missingByDelivery = [...countByLabel.entries()]
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));

  return { checkedIn, stored, checkedOut, missingByDelivery };
}
