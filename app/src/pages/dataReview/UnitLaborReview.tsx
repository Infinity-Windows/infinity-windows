import type { OpeningContext } from "./openingReviewContext";
import { useEffect, useRef, useState } from "react";
import type { WorkUnit } from "../../lib/customWork/model";
import { factText, FACT_LABELS } from "../../lib/customWork/model";
import type { ActivityRow } from "./activityRows";
import { unitLaborReview, type ReviewMetric } from "./unitLaborPeers";

export function UnitLaborReview({ rows, units, onInspect, contexts = new Map() }: { contexts?: Map<string, OpeningContext>; rows: ActivityRow[]; units: WorkUnit[]; onInspect: (ids: string[]) => void }) {
  const inspection = useRef<HTMLElement>(null);
  const [metric, setMetric] = useState<ReviewMetric>("minutes");
  const [selected, setSelected] = useState<string | null>(null);
  useEffect(() => { inspection.current?.scrollIntoView?.({ behavior: "smooth", block: "start" }); }, [selected]);
  const [activity, setActivity] = useState("");
  const activityKey = (row: ActivityRow) => `${row.sourceTable ?? "unknown"}::${row.activity}`;
  const options = [...new Set(rows.filter(row => row.scope === "Specific").map(activityKey))].sort();
  const selectedActivity = options.includes(activity) ? activity : options.find(value => value === "unit_sessions::Install") ?? options[0] ?? "";
  const reviews = unitLaborReview(rows.filter(row => activityKey(row) === selectedActivity), units, metric, contexts);
  const current = reviews.find(review => review.key === selected);
  const unitName = (review: typeof reviews[number]) => `${review.records[0].job} · Unit ${review.records[0].unit}`;
  const valueText = (value: number | null) => value === null ? "—" : `${value.toFixed(2)} ${metric === "area" ? "min/ft²" : "min"}`;
  const breakdown = (key: "activity" | "personId") => {
    const groups = new Map<string, { label: string; seconds: number; records: number }>();
    for (const row of current?.records ?? []) { const id = row[key]; const group = groups.get(id) ?? { label: key === "personId" ? row.person : row.activity, seconds: 0, records: 0 }; group.seconds += row.seconds; group.records++; groups.set(id, group); }
    return [...groups.values()].sort((a, b) => b.seconds - a.seconds);
  };
  return <section className="unit-labor-review" aria-label="Unit labor review"><div className="activity-unit-heading"><h2>Unit labor review</h2><span>{reviews.filter(review => review.unusual).length} unusual · {reviews.filter(review => review.comparable).length} comparable</span></div>
    <label className="report-range">Activity source<select value={selectedActivity} onChange={event => { setActivity(event.target.value); setSelected(null); }}>{options.map(option => <option key={option} value={option}>{option.split("::")[1]} · {option.startsWith("unit_sessions::") ? "historical" : "custom"}</option>)}</select></label>
    <label className="report-range">Compare recorded labor<select value={metric} onChange={event => setMetric(event.target.value as ReviewMetric)}><option value="minutes">Recorded minutes per unit</option><option value="area">Minutes per ft²</option></select></label>
    <p className="activity-unit-note">Selected jobs and dates · activity evidence, not allocated clock hours. Compare the same recorded activity/source using stored structural signatures across jobs, or a job-specific mark. Raw minutes do not require dimensions or material. Small groups are descriptive; automatic flags require 5 eligible peers. No complete-install or efficiency claim.</p>
    <details><summary>Review {reviews.length} units · {reviews.filter(review => !review.comparable).length} need more evidence</summary><div className="unit-review-list">{reviews.map(review => <button type="button" key={review.key} aria-expanded={selected === review.key} className={`unit-review-row ${review.unusual ? "unit-review-flag" : ""}`} onClick={() => setSelected(old => old === review.key ? null : review.key)}><span>{unitName(review)}<small>{review.unusual ? "Unusual recorded labor" : review.comparable ? "Descriptive peer comparison" : "Insufficient evidence to compare"}</small></span><strong>{valueText(review.value)}</strong></button>)}</div></details>
    {!reviews.length && <p>No unit-linked labor for these jobs and dates.</p>}
    {current && <section ref={inspection} className="activity-segment-detail" aria-label="Unit labor inspection"><div className="activity-detail-heading"><h3>{unitName(current)}</h3><button type="button" onClick={() => setSelected(null)}>Close</button></div>
      <p><strong>{valueText(current.value)}</strong> · {current.records.length} records · {current.peers} eligible peers</p>
      {current.comparable ? <p>Peer median {valueText(current.median)}. {current.flagReady ? `Upper comparison fence ${valueText(current.upper)}. ${current.unusual ? "Above the peer fence and 1.5× median." : "No high-labor flag."}` : "Not enough eligible evidence for an automatic flag."} This is a descriptive comparison, not an agreed estimate or a performance judgment.</p> : <p role="status">Insufficient evidence to compare. {current.problems.join(" · ")}{!current.problems.length && "No other matching openings for this activity/source."}</p>}
      <p className="activity-unit-note">Custom type label: {current.unit?.type_label || "No custom-work-unit facts"}. Current facts; totals may be partial. Conflicting saved/spec dimensions are excluded from area comparisons. A missing high-labor flag does not establish complete or accurate capture.</p>
      {!!current.warnings.length && <p role="status">{current.warnings.join(" · ")}</p>}
      <p className="activity-unit-note">Match: {current.identity?.startsWith("signature:") ? "stored structural signature (size/material not part of signature)" : current.identity ? "same job-specific mark" : "unavailable"}. Dimensions: {current.area === null ? "unavailable/conflicting" : `${current.area.toFixed(2)} ft²`} · {current.context?.spec ? `job spec ${current.context.spec.mark_code} (${current.context.spec.confirmed ? "confirmed spec; not field verification" : "unconfirmed"})` : "no job spec"}.</p>
      {current.context && <details open><summary>Opening &amp; job spec</summary><dl>
        <div><dt>Physical opening</dt><dd>{current.context.opening.opening_code} · {current.records[0].job}</dd></div>
        <div><dt>Status</dt><dd>{current.context.opening.status}</dd></div>
        <div><dt>Stored shape</dt><dd>{current.context.opening.signature ? `${current.context.opening.signature.kind} · ${current.context.opening.signature.panelCount} panels · ${current.context.opening.signature.movingCount} moving` : "Not recorded"}</dd></div>
        {current.context.spec && <><div><dt>Job specification</dt><dd>Mark {current.context.spec.mark_code} · {current.context.spec.style || "Description not recorded"}</dd></div><div><dt>Spec dimensions</dt><dd>{current.context.spec.width_in ?? "?"} × {current.context.spec.height_in ?? "?"} in · {current.context.spec.confirmed ? "Confirmed spec" : "Unconfirmed"} · {current.context.spec.source}</dd></div></>}
      </dl></details>}
      {current.comparable && <section aria-label="Shape peer comparison"><h4>Matching openings · {reviews.filter(review => review.cohort === current.cohort && !review.problems.length).length}</h4>{reviews.filter(review => review.cohort === current.cohort && !review.problems.length).map(review => <button type="button" className="unit-review-row" key={review.key} aria-pressed={review.key === current.key} onClick={() => setSelected(review.key)}><span>{unitName(review)}</span><strong>{valueText(review.value)}</strong></button>)}</section>}

      {current.unit && <details><summary>Unit details</summary><dl>{Object.entries(current.unit.facts).map(([key, value]) => <div key={key}><dt>{FACT_LABELS[key] ?? key}</dt><dd>{factText(key, value)}</dd></div>)}</dl></details>}
      <h4>Contributors</h4>{breakdown("personId").map(group => <p key={group.label}>{group.label} · {(group.seconds / 60).toFixed(2)} min · {group.records} records</p>)}
      <h4>Activity allocation</h4>{breakdown("activity").map(group => <div className="activity-mix-row" key={group.label}><div className="activity-mix-label"><span>{group.label}</span><strong>{(group.seconds / 60).toFixed(2)} min · {(group.seconds / (current.minutes * 60) * 100).toFixed(1)}%</strong></div><div className="activity-mix-track"><i style={{ width: `${group.seconds / (current.minutes * 60) * 100}%` }} /></div></div>)}
      <details><summary>Original time intervals</summary><p className="activity-unit-note">Original timestamps; minutes are clipped to the page date range.</p>{[...current.records].sort((a, b) => a.started.localeCompare(b.started)).map(row => <p key={row.id}>{row.person} · {row.activity} · {new Date(row.started).toLocaleString("en-US", { timeZone: "America/Denver" })} → {new Date(row.ended).toLocaleString("en-US", { timeZone: "America/Denver" })} Denver · {(row.seconds / 60).toFixed(2)} min</p>)}</details>
      <button type="button" className="activity-inspect-records" onClick={() => onInspect(current.records.map(row => row.id))}>Inspect contributing records</button>
    </section>}
  </section>;
}
