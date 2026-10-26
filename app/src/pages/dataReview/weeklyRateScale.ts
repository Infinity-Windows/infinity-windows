/** A linear main range, with a separately marked compressed linear upper
 * range only when a large tail would flatten the central distribution.
 * This is a display rule, not a statistical outlier classification. */
export function weeklyRateScale(values: number[]) {
  const sorted = values.filter(value => Number.isFinite(value) && value >= 0).sort((a, b) => a - b);
  const quantile = (p: number) => {
    const i = (sorted.length - 1) * p, lo = Math.floor(i);
    return sorted[lo] + (sorted[Math.ceil(i)] - sorted[lo]) * (i - lo);
  };
  const highest = sorted.at(-1) ?? 0;
  const max = (highest > 0 ? highest : 1) * 1.08;
  const q1 = sorted.length ? quantile(.25) : 0, q3 = sorted.length ? quantile(.75) : 0;
  const bound = Math.max(q3 + 1.5 * (q3 - q1), q3 * 1.5);
  const power = bound > 0 ? 10 ** Math.floor(Math.log10(bound)) : 1;
  const cutoff = Math.ceil(bound / power) * power;
  const compressed = sorted.length >= 5 && cutoff > 0 && max > cutoff * 2;
  if (!compressed) return { ticks: [0, 1, 2, 3, 4].map(tick => max * tick / 4), position: (value: number) => value / max, cutoff: null };
  return { ticks: [0, cutoff / 3, cutoff * 2 / 3, cutoff, max], cutoff,
    position: (value: number) => value <= cutoff ? value / cutoff * .75 : .75 + (value - cutoff) / (max - cutoff) * .25 };
}
