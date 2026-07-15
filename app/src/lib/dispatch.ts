// Foreman-push dispatch engine (pure + testable).
// autoDistribute proposes opening -> installer assignments the lead can accept
// or tweak. orderMyWork sequences one installer's list into a clear "next".

export interface DispatchCrew {
  id: string;
  skill_level: number;
  role: "installer" | "lead";
  active: boolean;
  display_name?: string;
}

export interface DispatchOpening {
  id: string;
  opening_code: string;
  /** Outcome/catalog difficulty 1-5; null treated as 2. */
  difficulty: number | null;
  /** Grouping key (e.g. page number or room) to cut walking. */
  area: string;
  /** Ready = fits + undamaged + unit on hand + confirmed + not installed. */
  ready: boolean;
  /** Hard stop (too small / damaged / wrong type) — never auto-assigned. */
  blocked: boolean;
  assigned_to: string | null;
  sequence: number | null;
}

export interface Suggestion {
  openingId: string;
  profileId: string;
}

const diffOf = (o: DispatchOpening) => o.difficulty ?? 2;

function eligible(crew: DispatchCrew, difficulty: number): boolean {
  if (!crew.active) return false;
  if (crew.role === "lead") return true;
  return crew.skill_level >= difficulty;
}

/**
 * Propose assignments for ready, unassigned openings.
 * - Hard windows go to the highest-skill available (keep leads on the critical path).
 * - Easy windows prefer the lowest-skill eligible person (free up skilled labor).
 * - Balance load (least-loaded eligible), and keep same-area openings together
 *   with one person to cut walking.
 * Blocked or already-assigned openings are skipped.
 */
export function autoDistribute(
  openings: DispatchOpening[],
  crew: DispatchCrew[],
): Suggestion[] {
  const active = crew.filter((c) => c.active);
  if (active.length === 0) return [];

  const load = new Map<string, number>();
  const areasByCrew = new Map<string, Set<string>>();
  for (const c of active) {
    load.set(c.id, 0);
    areasByCrew.set(c.id, new Set());
  }
  // Seed load/areas from openings already assigned so re-runs stay balanced.
  for (const o of openings) {
    if (o.assigned_to && load.has(o.assigned_to)) {
      load.set(o.assigned_to, (load.get(o.assigned_to) ?? 0) + 1);
      if (o.ready || o.blocked) areasByCrew.get(o.assigned_to)!.add(o.area);
    }
  }

  const queue = openings
    .filter((o) => o.ready && !o.blocked && !o.assigned_to)
    .sort((a, b) => diffOf(b) - diffOf(a) || a.opening_code.localeCompare(b.opening_code));

  const suggestions: Suggestion[] = [];
  for (const o of queue) {
    const d = diffOf(o);
    const candidates = active.filter((c) => eligible(c, d));
    if (candidates.length === 0) continue; // no one qualified — leave for the lead

    const hard = d >= 4;
    const best = candidates
      .map((c) => ({
        c,
        load: load.get(c.id) ?? 0,
        sameArea: areasByCrew.get(c.id)!.has(o.area),
      }))
      .sort((x, y) => {
        // Prefer someone already working this area (fewer trips).
        if (x.sameArea !== y.sameArea) return x.sameArea ? -1 : 1;
        // Then least loaded.
        if (x.load !== y.load) return x.load - y.load;
        // Tie-break by skill: hard -> highest skill; easy -> lowest skill.
        return hard
          ? y.c.skill_level - x.c.skill_level
          : x.c.skill_level - y.c.skill_level;
      })[0];

    suggestions.push({ openingId: o.id, profileId: best.c.id });
    load.set(best.c.id, (load.get(best.c.id) ?? 0) + 1);
    areasByCrew.get(best.c.id)!.add(o.area);
  }

  return suggestions;
}

/**
 * Order one installer's assigned openings into a clear worklist:
 * ready first, then lead-set sequence, then grouped by area, then code.
 */
export function orderMyWork(openings: DispatchOpening[]): DispatchOpening[] {
  return [...openings].sort((a, b) => {
    // Installed/done sink to the bottom is the caller's job; here rank the rest.
    if (a.ready !== b.ready) return a.ready ? -1 : 1;
    const sa = a.sequence ?? Number.MAX_SAFE_INTEGER;
    const sb = b.sequence ?? Number.MAX_SAFE_INTEGER;
    if (sa !== sb) return sa - sb;
    if (a.area !== b.area) return a.area.localeCompare(b.area);
    return a.opening_code.localeCompare(b.opening_code);
  });
}

/** The single next opening an installer should start (ready, earliest ordered). */
export function nextForInstaller(
  openings: DispatchOpening[],
): DispatchOpening | null {
  const ordered = orderMyWork(openings.filter((o) => !o.blocked));
  return ordered.find((o) => o.ready) ?? ordered[0] ?? null;
}
