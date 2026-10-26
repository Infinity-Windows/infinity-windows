import { useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { midnight, weeklyScale, type GeneralBucket } from "./generalLabor";

type Bucket = GeneralBucket & { percent: number | null; seriesKey?: string; seriesLabel?: string; groupKey?: string; groupLabel?: string; unavailable?: boolean; future?: boolean };
export function WeeklyLaborPlot({ buckets, metric, color, from, until, onInspect, laborLabel = "Job-level work", scaleMax, period = "week" }: {
  period?: "day" | "week";
  scaleMax?: number;
  laborLabel?: string;
  buckets: Bucket[]; metric: string; color: (activity: string) => string; from: number; until: number;
  onInspect: (ids: string[], interval?: [number, number]) => void;
}) {
  const [detailWeek, setDetailWeek] = useState("");
  const scroll = useRef<HTMLDivElement>(null);
  const atLatest = useRef(true);
  const windowKey = JSON.stringify([from, until, period, buckets.map(bucket => [bucket.key, bucket.seriesKey, bucket.groupKey])]);
  useLayoutEffect(() => {
    const element = scroll.current;
    if (!element) return;
    atLatest.current = true;
    element.scrollLeft = element.scrollWidth;
    // Reset only for a different time/job window, never for polling updates,
    // metric switches or legend toggles while someone inspects earlier work.
  }, [windowKey]);
  useLayoutEffect(() => {
    const element = scroll.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => { if (atLatest.current) element.scrollLeft = element.scrollWidth; });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const top = metric === "percent" ? 100 : scaleMax ?? weeklyScale(Math.max(0, ...buckets.map(bucket => bucket.seconds / 3600)));
  const interval = (key: string): [number, number] => [Math.max(from, midnight(key)), Math.min(until, midnight(new Date(Date.parse(`${key}T12:00:00Z`) + (period === "day" ? 1 : 7) * 86400000).toISOString().slice(0, 10)))];
  const label = (key: string) => new Date(`${key}T12:00:00Z`).toLocaleDateString("en-US", { ...(period === "day" ? { weekday: "short" as const } : {}), month: "short", day: "numeric", timeZone: "UTC" });
  const valueText = (value: number) => `${value > 0 && value < .01 ? "<0.01" : Number(value.toFixed(2))}${metric === "percent" ? "%" : " h"}`;
  const segmentText = (seconds: number, total: number) => `${(seconds / 60).toFixed(1)} min · ${(total ? seconds / total * 100 : 0).toFixed(1)}%`;
  const bucketId = (bucket: Bucket) => `${bucket.key}/${bucket.seriesKey ?? ""}`;
  const detail = buckets.find(bucket => bucketId(bucket) === detailWeek) ?? buckets.at(-1);
  const grouped = buckets.some(bucket => bucket.seriesKey);
  const relative = buckets.some(bucket => bucket.groupLabel);
  const groups = [...new Set(buckets.map(bucket => bucket.groupKey ?? bucket.key))].map(key => ({ key, members: buckets.filter(bucket => (bucket.groupKey ?? bucket.key) === key) }));
  return <div className="weekly-labor-plot">
    <div className="weekly-axis-caption"><strong>{metric === "percent" ? `% of ${laborLabel}` : "Person-hours"}</strong><span>← Earlier {period === "day" ? "days" : "weeks"} · latest at right</span></div>
    <div className="weekly-axis-layout">
      <div className="weekly-y-axis" aria-label={`${metric === "percent" ? "Percent" : "Hours"} axis`}>
        {[4, 3, 2, 1, 0].map(tick => <span key={tick} style={{ top: `${(4 - tick) * 25}%` }}>{valueText(top * tick / 4)}</span>)}
      </div>
      <div ref={scroll} onScroll={event => { const element = event.currentTarget; atLatest.current = element.scrollWidth - element.clientWidth - element.scrollLeft < 4; }} className="weekly-scroll" tabIndex={0} role="region" aria-label={`${period === "day" ? "Daily" : "Weekly"} stacked labor chart; scroll horizontally for more ${period === "day" ? "days" : "weeks"}`}>
        <div className={`weekly-columns${grouped ? " weekly-grouped-columns" : ""}`} style={{ "--week-count": buckets.length, "--group-count": groups.length } as CSSProperties}>
          <div className="weekly-grid" aria-hidden="true">{[0, 25, 50, 75, 100].map(position => <i key={position} style={{ top: `${position}%` }} />)}</div>
          {groups.map(group => <div className="weekly-group" key={group.key} role={grouped ? "group" : undefined} aria-label={grouped ? group.members[0].groupLabel ?? `${period === "day" ? "Day" : "Week of"} ${group.key}` : undefined} style={{ "--job-count": group.members.length } as CSSProperties}>
          <div className="weekly-group-bars">{group.members.map(bucket => {
            const value = bucket.unavailable ? null : metric === "percent" ? bucket.percent : bucket.seconds / 3600;
            const title = `${bucket.groupLabel ? `${bucket.groupLabel} (from ${bucket.key})` : `${period === "day" ? "Day" : "Week of"} ${bucket.key}`}${bucket.seriesLabel ? ` · ${bucket.seriesLabel}` : ""}${bucket.partial ? ` · partial ${period}` : ""}`;
            return <div className={`weekly-column${bucket.seriesKey ? " weekly-job-column" : ""}`} key={bucketId(bucket)}>
              <div className="weekly-column-plot" aria-label={`${title} activity mix`}>
                {bucket.segments.map(segment => {
                  const amount = metric === "percent" ? segment.seconds / bucket.totalSeconds * 100 : segment.seconds / 3600;
                  return <button type="button" key={segment.activity} className="general-week-segment" style={{ height: `${amount / top * 100}%`, background: color(segment.activity) }}
                    aria-label={`${title}, ${segment.activity}: ${segmentText(segment.seconds, bucket.totalSeconds)}; inspect ${segment.ids.length} records`}
                    title={`${segment.activity}: ${segmentText(segment.seconds, bucket.totalSeconds)}`} onClick={() => onInspect(segment.ids, interval(bucket.key))} />;
                })}
                <span className="weekly-column-total" style={{ bottom: `${(value ?? 0) / top * 100}%` }}>{value === null ? "—" : valueText(value)}</span>
              </div>
              <button type="button" className="general-chart-bar general-week-heading weekly-x-label" disabled={!bucket.ids.length} aria-label={`${title}: ${value === null ? "—" : valueText(value)}; inspect ${bucket.ids.length} records`} onClick={() => onInspect(bucket.ids, interval(bucket.key))}>
                {bucket.seriesLabel && <strong>{bucket.seriesLabel}</strong>}{!grouped && <span>{label(bucket.key)}</span>}{relative && <small>{label(bucket.key)}</small>}{(bucket.unavailable || !grouped || (relative && bucket.partial)) && <small>{bucket.unavailable ? bucket.future ? "Not reached" : "No records" : `${!grouped ? bucket.key.slice(0, 4) : ""}${bucket.partial ? " · partial" : ""}`}</small>}
              </button>
            </div>;
          })}</div>
          {grouped && <div className="weekly-group-label"><span>{group.members[0].groupLabel ?? label(group.members[0].key)}</span>{!relative && group.members.some(bucket => bucket.partial) && <small>partial {period}</small>}</div>}
          </div>)}
        </div>
      </div>
    </div>
    <p className="weekly-x-title">{period === "day" ? "Day · Denver" : relative ? "Job week · 7 days from first recorded work · Denver" : "Week starting · Monday · Denver"}</p>
    {detail && <details className="general-week-details weekly-segment-picker"><summary>Inspect small segments</summary>
      <label>{period === "day" ? "Day" : "Week"}<select value={bucketId(detail)} onChange={event => setDetailWeek(event.target.value)}>{buckets.map(bucket => <option key={bucketId(bucket)} value={bucketId(bucket)}>{bucket.groupLabel ? `${bucket.groupLabel} · ` : ""}{bucket.key}{bucket.seriesLabel ? ` · ${bucket.seriesLabel}` : ""}{bucket.partial ? ` · partial ${period}` : ""}</option>)}</select></label>
      {detail.segments.map(segment => <button type="button" key={segment.activity} onClick={() => onInspect(segment.ids, interval(detail.key))}><span><i style={{ background: color(segment.activity) }} />{segment.activity}</span><strong>{segmentText(segment.seconds, detail.totalSeconds)}</strong></button>)}
      {!detail.segments.length && <p>No recorded labor this {period}.</p>}
    </details>}
  </div>;
}
