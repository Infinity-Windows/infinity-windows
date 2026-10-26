import { useState } from "react";
import type { ActivityRow } from "./activityRows";
import { visitStats } from "./visitStats";

const minutes = (seconds: number) => seconds > 0 && seconds < .6 ? "<0.01" : (seconds / 60).toFixed(2);

export function VisitDistribution({ rows, onInspect }: { rows: ActivityRow[]; onInspect: (ids: string[]) => void }) {
  const [logScale, setLogScale] = useState(true);
  const stats = visitStats(rows);
  const max = Math.max(1, ...rows.map(r => r.seconds));
  const position = (seconds: number) => (logScale ? Math.log1p(seconds / 60) / Math.log1p(max / 60) : seconds / max) * 100;
  return <section className="visit-distribution" aria-label="Visit duration spread">
    <div className="visit-heading"><h2>Visit duration</h2><button type="button" aria-pressed={logScale} onClick={() => setLogScale(v => !v)}>{logScale ? "Log scale" : "Linear scale"}</button></div>
    <p className="activity-unit-note">Minutes per recorded visit · median and spread</p>
    <div className="visit-axis"><span>0 min</span><span>{minutes(max)} min</span></div>
    {stats.map(stat => <article className="visit-row" key={stat.label}>
      <div className="visit-label"><strong>{stat.label}</strong><span>{stat.records.length} visits</span></div>
      <svg className="visit-plot" viewBox="-2 0 104 24" preserveAspectRatio="none" role="img" aria-label={`${stat.label}: median ${minutes(stat.median)}, mean ${minutes(stat.mean)}, minimum ${minutes(stat.min)}, maximum ${minutes(stat.max)} minutes; ${stat.flaggedIds.length} unusual visits`}>
        <line x1={position(stat.min)} x2={position(stat.max)} y1="12" y2="12" className="visit-range" />
        <rect x={position(stat.q1)} y="6" width={Math.max(position(stat.q3) - position(stat.q1), .2)} height="12" className="visit-iqr" />
        {stat.records.map(record => <circle key={record.id} cx={position(record.seconds)} cy="12" r="1.2" className={stat.flaggedIds.includes(record.id) ? "visit-dot visit-dot-flagged" : "visit-dot"}><title>{minutes(record.seconds)} min{stat.flaggedIds.includes(record.id) ? " · unusual duration" : ""}</title></circle>)}
        <line x1={position(stat.median)} x2={position(stat.median)} y1="3" y2="21" className="visit-median" />
      </svg>
      <p className="visit-values"><strong>Median {minutes(stat.median)}</strong><span>Mean {minutes(stat.mean)}</span><span>{minutes(stat.min)}–{minutes(stat.max)} min</span></p>
      <div className="visit-actions">
        <button type="button" onClick={() => onInspect(stat.records.map(r => r.id))}>Inspect visits</button>
        {!!stat.shortIds.length && <button type="button" onClick={() => onInspect(stat.shortIds)}>{stat.shortIds.length} under 1 min</button>}
        {!!stat.flaggedIds.length && <button type="button" className="visit-flag-action" onClick={() => onInspect(stat.flaggedIds)}>{stat.flaggedIds.length} unusual</button>}
        {stat.records.length < 5 && <span className="visit-small-sample">Small sample</span>}
      </div>
    </article>)}
    {!stats.length && <p className="activity-unit-note">No visits match these filters.</p>}
    <details className="activity-quality"><summary>How to read this</summary><p>Dots are individual visits; the band is the middle 50%; the line marks the median. All rows share one scale. Log scale expands short durations without hiding long ones.</p><p>Unusual means outside 1.5 × the interquartile range within the same activity and scope, with at least five visits. Flags do not prove errors. Nothing is discarded. Short visits may be completion taps; long visits may be valid work or forgotten timers. These are visit durations, not full unit installation times or productivity scores.</p></details>
  </section>;
}
