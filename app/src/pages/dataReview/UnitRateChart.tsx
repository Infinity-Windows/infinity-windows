import { useState } from "react";
import type { WorkUnit } from "../../lib/customWork/model";
import type { ActivityRow } from "./activityRows";
import { unitRatePoints } from "./unitRatePoints";

const colors = ["#69b5cf", "#d9aa72", "#a99bd1", "#83b49b", "#cf91aa", "#bbc76c"];

export function UnitRateChart({ rows, units, onInspect }: { rows: ActivityRow[]; units: WorkUnit[]; onInspect: (ids: string[]) => void }) {
  const [hiddenJobs, setHiddenJobs] = useState<string[]>([]);
  const [sort, setSort] = useState("unit");
  const [hidden, setHidden] = useState<string[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const specific = rows.filter(row => row.scope === "Specific");
  const activities = [...new Set(specific.map(row => row.activity))].sort();
  const jobs = [...new Map(specific.map(row => [row.jobId ?? "", row.job ?? "Unknown job"])).entries()].sort((a, b) => a[1].localeCompare(b[1]));
  const result = unitRatePoints(specific.filter(row => !hidden.includes(row.activity) && !hiddenJobs.includes(row.jobId ?? "")), units);
  const { excluded, unlinked } = result;
  const points = [...result.points].sort((a, b) => sort === "unit" ? 0 : (sort === "low" ? 1 : -1) * (a.value! - b.value!));
  const current = points.find(point => point.key === selected);
  const max = Math.max(1, ...points.map(point => point.value!)) * 1.1;
  const x = (index: number) => points.length < 2 ? 388 : 60 + index / (points.length - 1) * 650;
  const y = (value: number) => 260 - value / max * 220;
  const color = (job: string) => colors[Math.max(0, jobs.findIndex(([id]) => id === job)) % colors.length];
  return <section className="unit-rate-chart" aria-label="Unit activity rates">
    <div className="unit-rate-activities" role="group" aria-label="Included activities">{activities.map(activity => <button type="button" key={activity} aria-pressed={!hidden.includes(activity)} onClick={() => { setHidden(old => old.includes(activity) ? old.filter(value => value !== activity) : [...old, activity]); setSelected(null); }}>{activity}</button>)}</div>
    <div className="unit-rate-toolbar"><div className="unit-rate-legend" role="group" aria-label="Included jobs">{jobs.map(([id, name]) => <button type="button" key={id} aria-pressed={!hiddenJobs.includes(id)} onClick={() => { setHiddenJobs(old => old.includes(id) ? old.filter(value => value !== id) : [...old, id]); setSelected(null); }}><i style={{ background: color(id) }} />{name}</button>)}</div><label>Sort<select aria-label="Sort units" value={sort} onChange={event => setSort(event.target.value)}><option value="unit">Job / unit</option><option value="low">Rate: low to high</option><option value="high">Rate: high to low</option></select></label></div>
    <p className="unit-rate-coverage">{points.length} plotted units · {excluded} missing/conflicting area · {unlinked} unlinked records. Selected activity minutes ÷ stored opening ft²; dimensions may be unverified. Partial activity capture, not total clocked labor.</p>
    {points.length ? <svg viewBox="0 0 740 310" aria-label="Recorded minutes per square foot by unit" className="unit-rate-plot">
      <text x="60" y="18">min/ft²</text>
      {[0, 1, 2, 3, 4].map(tick => <g key={tick}><line x1="60" x2="710" y1={y(max * tick / 4)} y2={y(max * tick / 4)} /><text x="51" y={y(max * tick / 4) + 4} textAnchor="end">{(max * tick / 4).toFixed(2)}</text></g>)}
      {points.map((point, index) => <g key={point.key}><circle role="button" tabIndex={0} aria-label={`${point.job} · Unit ${point.unit} · ${point.value!.toFixed(3)} min/ft²`} aria-pressed={selected === point.key} cx={x(index)} cy={y(point.value!)} r={selected === point.key ? 7 : 5} fill={color(point.jobId)} onClick={() => setSelected(point.key)} onKeyDown={event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setSelected(point.key); } }}><title>{point.job} · {point.unit}: {point.value!.toFixed(3)} min/ft²</title></circle>{(points.length <= 8 || index % Math.ceil(points.length / 6) === 0 || index === points.length - 1) && <text x={x(index)} y="280" textAnchor="middle">{point.unit}</text>}</g>)}
      <text x="385" y="303" textAnchor="middle">{sort === "unit" ? "Units · ordered by job and unit identifier" : `Units · rate ${sort === "low" ? "low to high" : "high to low"}`}</text>
    </svg> : <p role="status">No units with usable area for the included activities.</p>}
    {current && <div className="unit-rate-detail"><strong>{current.job} · Unit {current.unit}</strong><span>{(current.seconds / 60).toFixed(2)} min ÷ {current.area.toFixed(2)} ft² = {current.value!.toFixed(3)} min/ft²</span><button type="button" onClick={() => onInspect(current.records.map(row => row.id))}>Inspect records</button><button type="button" onClick={() => setSelected(null)}>Clear</button></div>}
  </section>;
}
