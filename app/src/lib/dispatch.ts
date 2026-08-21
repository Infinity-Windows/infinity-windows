// Foreman-push dispatch engine (pure + testable).
// autoDistribute proposes opening -> installer assignments the lead can accept
// or tweak. orderMyWork sequences one installer's list into a clear "next".

export interface DispatchCrew {
  id: string;
  skill_level: number;
  /** "installer" = plain installer; anything else is lead-level. */
  role: string;
  active: boolean;
  display_name?: string;
}

/** Proven performance for one installer on one window type (from outcomes). */
export interface InstallerTypePerf {
  installer_id: string;
  window_type_id: string;
  n: number;
  median_minutes: number | null;
  avg_grade: number | null;
  fail_rate: number | null;
}

/** Types an installer is explicitly cleared to install (training path). */
export type ClearanceSet = Set<string>; // `${installer_id}:${window_type_id}`

/** The five badges (owner decision 2026-08-21): what somebody MAY touch. */
export const CAPABILITIES = [
  "nail_fin",
  "retrofit",
  "doors",
  "wet_glazing",
  "curtain_wall",
] as const;
export type Capability = (typeof CAPABILITIES)[number];
export const CAPABILITY_LABELS: Record<Capability, string> = {
  nail_fin: "Nail fin",
  retrofit: "Retrofit",
  doors: "Doors",
  wet_glazing: "Wet glazing",
  curtain_wall: "Curtain wall",
};

export interface DispatchContext {
  /** perf[installerId][windowTypeId] -> proven stats */
  perf?: Record<string, Record<string, InstallerTypePerf>>;
  cleared?: ClearanceSet;
  /** "installerId:capability" pairs the installer holds. */
  badges?: Set<string>;
}

export interface DispatchOpening {
  id: string;
  opening_code: string;
  window_type_id: string | null;
  /** Badge this type demands, or null when open to any eligible installer. */
  required_capability?: string | null;
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

function perfOf(
  ctx: DispatchContext | undefined,
  crewId: string,
  typeId: string | null,
): InstallerTypePerf | null {
  if (!ctx?.perf || !typeId) return null;
  return ctx.perf[crewId]?.[typeId] ?? null;
}

function isCleared(
  ctx: DispatchContext | undefined,
  crewId: string,
  typeId: string | null,
): boolean {
  if (!ctx?.cleared || !typeId) return false;
  return ctx.cleared.has(`${crewId}:${typeId}`);
}

/**
 * Eligibility now blends declared skill with LEARNED signals:
 * - leads take anything;
 * - proven history on the type (any successful installs) qualifies;
 * - explicit training clearance qualifies (a cleared apprentice can go up);
 * - otherwise fall back to the static skill tier (cold start).
 */
function eligible(
  crew: DispatchCrew,
  o: DispatchOpening,
  ctx?: DispatchContext,
): boolean {
  if (!crew.active) return false;
  if (crew.role !== "installer") return true; // any lead-level takes anything
  // A required badge is a hard family gate: skill, history, and per-type
  // clearance say how GOOD you are; the badge says whether this family of
  // work is yours at all (wet glazing, curtain wall...).
  if (
    o.required_capability &&
    !ctx?.badges?.has(`${crew.id}:${o.required_capability}`)
  ) {
    return false;
  }
  const perf = perfOf(ctx, crew.id, o.window_type_id);
  if (perf && perf.n > 0 && (perf.fail_rate ?? 0) < 0.5) return true;
  if (isCleared(ctx, crew.id, o.window_type_id)) return true;
  return crew.skill_level >= diffOf(o);
}

/** Proven avg grade on this type, or null when no history (cold start). */
function provenQuality(
  crew: DispatchCrew,
  o: DispatchOpening,
  ctx?: DispatchContext,
): number | null {
  return perfOf(ctx, crew.id, o.window_type_id)?.avg_grade ?? null;
}

/** Proven median minutes on this type, or null when no history. */
function provenSpeed(
  crew: DispatchCrew,
  o: DispatchOpening,
  ctx?: DispatchContext,
): number | null {
  return perfOf(ctx, crew.id, o.window_type_id)?.median_minutes ?? null;
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
  ctx?: DispatchContext,
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
    const candidates = active.filter((c) => eligible(c, o, ctx));
    if (candidates.length === 0) continue; // no one qualified — leave for the lead

    const hard = d >= 4;
    const best = candidates
      .map((c) => ({
        c,
        load: load.get(c.id) ?? 0,
        sameArea: areasByCrew.get(c.id)!.has(o.area),
        speed: provenSpeed(c, o, ctx),
        quality: provenQuality(c, o, ctx),
      }))
      .sort((x, y) => {
        // Prefer someone already working this area (fewer trips).
        if (x.sameArea !== y.sameArea) return x.sameArea ? -1 : 1;
        // Then least loaded.
        if (x.load !== y.load) return x.load - y.load;
        // Proven fastest on this type wins (known speed beats unknown).
        if (x.speed != null && y.speed != null && x.speed !== y.speed) {
          return x.speed - y.speed;
        }
        if ((x.speed == null) !== (y.speed == null)) return x.speed == null ? 1 : -1;
        // Proven quality (only when we actually have it, higher better).
        if (x.quality != null && y.quality != null && x.quality !== y.quality) {
          return y.quality - x.quality;
        }
        // Cold-start tie-break by skill: hard -> highest, easy -> lowest.
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
