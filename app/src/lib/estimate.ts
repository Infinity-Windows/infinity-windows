// Forward-looking prediction from persisted per-type rollups. Pure + testable.
// Turns descriptive history (median/P90 per type) into job duration, crew-mix,
// and bid-accuracy signals.

export interface TypeStat {
  window_type_id: string;
  median_minutes: number | null;
  p90_minutes: number | null;
  difficulty: number | null;
}

export interface EstimateOpening {
  window_type_id: string | null;
  /** Already installed openings don't count toward remaining work. */
  installed: boolean;
}

export interface JobEstimate {
  openings: number;
  remaining: number;
  /** Expected total install minutes (sum of per-type medians). */
  expectedMinutes: number;
  /** Risk band: sum of per-type P90 (slow case). */
  p90Minutes: number;
  /** How many openings had no learned data (used a fallback). */
  unknownTypes: number;
}

/** Fallback minutes when a type has no history yet (difficulty-scaled). */
export function fallbackMinutes(difficulty: number | null): number {
  const d = difficulty ?? 2;
  // 1 -> 25m ... 5 -> 75m, linear.
  return Math.round(25 + (d - 1) * 12.5);
}

function statMap(stats: TypeStat[]): Map<string, TypeStat> {
  return new Map(stats.map((s) => [s.window_type_id, s]));
}

export function estimateJob(
  openings: EstimateOpening[],
  stats: TypeStat[],
): JobEstimate {
  const byType = statMap(stats);
  let expected = 0;
  let p90 = 0;
  let unknown = 0;
  const remaining = openings.filter((o) => !o.installed);

  for (const o of remaining) {
    const s = o.window_type_id ? byType.get(o.window_type_id) : undefined;
    if (s?.median_minutes != null) {
      expected += s.median_minutes;
      p90 += s.p90_minutes ?? s.median_minutes * 1.3;
    } else {
      const fb = fallbackMinutes(s?.difficulty ?? null);
      expected += fb;
      p90 += Math.round(fb * 1.4);
      unknown += 1;
    }
  }

  return {
    openings: openings.length,
    remaining: remaining.length,
    expectedMinutes: Math.round(expected),
    p90Minutes: Math.round(p90),
    unknownTypes: unknown,
  };
}

export interface CrewRecommendation {
  /** Crew size to hit the target window (whole installers). */
  recommendedCrew: number;
  /** Expected crew-hours of work remaining. */
  crewHours: number;
  /** Hours to finish at the recommended crew size. */
  hoursToFinish: number;
}

/**
 * Recommend how many installers to finish the remaining work within
 * `targetHours` (default a single 8h day), assuming parallel work.
 */
export function recommendCrew(
  estimate: JobEstimate,
  targetHours = 8,
): CrewRecommendation {
  const crewHours = Math.round((estimate.expectedMinutes / 60) * 10) / 10;
  const recommended = Math.max(1, Math.ceil(crewHours / Math.max(1, targetHours)));
  const hoursToFinish = Math.round((crewHours / recommended) * 10) / 10;
  return { recommendedCrew: recommended, crewHours, hoursToFinish };
}

export interface Variance {
  estimateMinutes: number;
  actualMinutes: number;
  deltaMinutes: number;
  /** Positive = over estimate (slower), negative = under (faster). */
  pctOver: number;
}

/** Estimate-vs-actual for closing the bid-accuracy loop. */
export function variance(estimateMinutes: number, actualMinutes: number): Variance {
  const delta = actualMinutes - estimateMinutes;
  const pct = estimateMinutes > 0 ? Math.round((delta / estimateMinutes) * 1000) / 10 : 0;
  return {
    estimateMinutes,
    actualMinutes,
    deltaMinutes: delta,
    pctOver: pct,
  };
}

export function formatHours(minutes: number): string {
  const h = minutes / 60;
  if (h < 1) return `${Math.round(minutes)}m`;
  return `${Math.round(h * 10) / 10}h`;
}
