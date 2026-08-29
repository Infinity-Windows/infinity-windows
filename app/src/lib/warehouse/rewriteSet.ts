// Wave R — Rewrite this set (owner grill 2026-08-28, the Mad Moose story):
// the manifest said mark #8 was 16 packages; the truck actually had 12
// pieces of glass in one crate plus 4 frame packages. "Rewrite this set"
// replaces editing fifteen slot cards by hand with declaring the set as a
// short list of {count, part type, packaging} lines and applying the diff
// in one shot.
//
// This module is the CLIENT's copy of that diff: it drives the "what's
// real right now" preview strip and refuses a bad plan in the browser
// before it ever reaches the server. The server's `rewrite_set` RPC
// (supabase/migrations/20260958000000_rewrite_set.sql) is the ONE
// authoritative gate — it re-derives and re-checks everything itself and
// never trusts this module's verdict. The refusal sentences below are kept
// word-for-word identical to the SQL function's; both double as deploy
// probes, so a wording change here without the matching change there is a
// bug.
import type { StoragePackage } from "../storage";

export type Packaging = "package" | "crate_pool";

export interface RewriteLine {
  /** null = the untyped "what is it?" line. */
  partType: string | null;
  packaging: Packaging;
  count: number;
}

export interface OldGroup {
  partType: string | null;
  packaging: Packaging;
  /** received/stored/checked_out — package packaging counts rows, crate_pool
   *  counts pieces (summed piece_count). */
  arrived: number;
  /** status = 'minted', same units as arrived. */
  expected: number;
}

const ARRIVED_STATUSES = new Set(["received", "stored", "checked_out"]);

const groupKey = (partType: string | null, packaging: Packaging): string =>
  `${packaging}:${partType ?? ""}`;

/** Current reality, grouped exactly the way the RPC groups it server-side —
 *  one line per (part type, packaging), a sealed crate box (part_type
 *  'crate') excluded since it isn't a set line at all. */
export function groupExistingPackages(
  packages: Pick<StoragePackage, "status" | "part_type" | "piece_count">[],
): Map<string, OldGroup> {
  const groups = new Map<string, OldGroup>();
  for (const p of packages) {
    if (p.part_type === "crate") continue;
    const packaging: Packaging = p.piece_count != null ? "crate_pool" : "package";
    const partType = p.part_type ?? null;
    const key = groupKey(partType, packaging);
    const g = groups.get(key) ?? { partType, packaging, arrived: 0, expected: 0 };
    const amount = packaging === "crate_pool" ? (p.piece_count ?? 0) : 1;
    if (ARRIVED_STATUSES.has(p.status)) g.arrived += amount;
    else if (p.status === "minted") g.expected += amount;
    groups.set(key, g);
  }
  return groups;
}

export interface PlanAction {
  key: string;
  partType: string | null;
  packaging: Packaging;
  /** Reality after re-fitting arrived material — never touched by
   *  arithmetic, only counted. */
  arrivedCount: number;
  toCount: number;
  mint: number;
  release: number;
}

export type RewritePlan = { ok: true; actions: PlanAction[] } | { ok: false; reason: string };

const typeLabel = (partType: string | null): string => partType ?? "untyped";

const shrinkRefusal = (arrived: number, partType: string | null, packaging: Packaging, target: number): string => {
  const unit = packaging === "crate_pool" ? ` piece${arrived === 1 ? "" : "s"}` : "";
  return (
    `${arrived} ${typeLabel(partType)}${unit} already arrived — the new plan only holds ${target}. ` +
    `Un-arrive or delete pieces first, so nothing real disappears.`
  );
};

const ambiguityRefusal = (
  removed: { partType: string | null; packaging: Packaging; arrived: number }[],
): string => {
  const parts = removed
    .slice()
    .sort((a, b) => typeLabel(a.partType).localeCompare(typeLabel(b.partType)))
    .map((r) => {
      const unit = r.packaging === "crate_pool" ? "piece" : "package";
      return `${r.arrived} ${typeLabel(r.partType)} ${unit}${r.arrived === 1 ? "" : "s"}`;
    })
    .join(", ");
  return `Some arrived material doesn't clearly fit the new plan: ${parts}. Retype it one at a time first.`;
};

/**
 * Diff a new declaration against reality — the pure heart of "Make it
 * match." Mirrors the SQL function's algorithm exactly:
 *
 *   1. A line missing from the new declaration and carrying arrived
 *      material is "removed" — its arrived pieces need a home.
 *   2. Re-fit is allowed ONLY when there is exactly one removed line and
 *      exactly one brand-new line (same packaging) that can hold its
 *      arrived count; anything less clear-cut refuses.
 *   3. Any line (after re-fit) whose new count is below its arrived count
 *      refuses the WHOLE plan, atomically — a refusal here describes no
 *      partial action; nothing about it is ever applied piecemeal.
 *   4. Otherwise: mint the shortfall, release the surplus of expected
 *      (never-arrived) material.
 */
export function planRewrite(oldGroups: Map<string, OldGroup>, lines: RewriteLine[]): RewritePlan {
  const newMap = new Map<string, { partType: string | null; packaging: Packaging; count: number }>();
  for (const line of lines) {
    if (!Number.isFinite(line.count) || line.count <= 0) continue;
    const key = groupKey(line.partType, line.packaging);
    const existing = newMap.get(key);
    newMap.set(key, {
      partType: line.partType,
      packaging: line.packaging,
      count: (existing?.count ?? 0) + Math.floor(line.count),
    });
  }

  const removedWithArrived = [...oldGroups.entries()]
    .filter(([key, g]) => !newMap.has(key) && g.arrived > 0)
    .map(([key, g]) => ({ key, partType: g.partType, packaging: g.packaging, arrived: g.arrived }));
  const newOnly = [...newMap.entries()]
    .filter(([key]) => !oldGroups.has(key))
    .map(([key, g]) => ({ key, partType: g.partType, packaging: g.packaging, count: g.count }));

  let refitFrom: string | null = null;
  let refitTo: string | null = null;
  if (removedWithArrived.length === 1) {
    const removed = removedWithArrived[0];
    const candidates = newOnly.filter((n) => n.packaging === removed.packaging && n.count >= removed.arrived);
    if (candidates.length === 1) {
      refitFrom = removed.key;
      refitTo = candidates[0].key;
    } else {
      return { ok: false, reason: ambiguityRefusal(removedWithArrived) };
    }
  } else if (removedWithArrived.length > 1) {
    return { ok: false, reason: ambiguityRefusal(removedWithArrived) };
  }

  const allKeys = new Set([...oldGroups.keys(), ...newMap.keys()]);
  const actions: PlanAction[] = [];
  for (const key of allKeys) {
    const nextLine = newMap.get(key);
    let old = oldGroups.get(key) ?? {
      partType: nextLine?.partType ?? null,
      packaging: nextLine?.packaging ?? "package",
      arrived: 0,
      expected: 0,
    };
    old = { ...old };

    if (key === refitFrom) {
      old.arrived = 0; // moved on; only its never-arrived remainder stays, released below
    } else if (key === refitTo) {
      const source = oldGroups.get(refitFrom!)!;
      old = { ...old, arrived: old.arrived + source.arrived };
    }

    const target = nextLine?.count ?? 0;
    if (target < old.arrived) {
      return { ok: false, reason: shrinkRefusal(old.arrived, old.partType, old.packaging, target) };
    }
    if (target === 0 && old.arrived === 0 && old.expected === 0) continue;

    const targetExpected = target - old.arrived;
    const mint = Math.max(0, targetExpected - old.expected);
    const release = Math.max(0, old.expected - targetExpected);
    actions.push({
      key,
      partType: old.partType,
      packaging: old.packaging,
      arrivedCount: old.arrived,
      toCount: target,
      mint,
      release,
    });
  }

  return { ok: true, actions };
}

/** The "what's real right now" strip: one plain line per composition line —
 *  "frame — 2 of 4 arrived." A line with no match in reality yet (a
 *  brand-new type the user just added) reads as 0 arrived, honestly. */
export function realityLine(
  line: RewriteLine,
  oldGroups: Map<string, OldGroup>,
): { label: string; arrived: number; count: number } {
  const g = oldGroups.get(groupKey(line.partType, line.packaging));
  return { label: typeLabel(line.partType), arrived: g?.arrived ?? 0, count: line.count };
}
