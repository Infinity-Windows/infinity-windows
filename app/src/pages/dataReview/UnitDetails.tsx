import { workAttribution } from "./workAttribution";
import type { ActivityRow } from "./activityRows";
import type { ReportingFacts } from "./reportingFacts";
import { useEffect, useRef } from "react";
import { factText, FACT_LABELS, type WorkUnit } from "../../lib/customWork/model";

export function UnitDetails({ unit, opening, onClose, facts, record }: { record?: ActivityRow; facts?: ReportingFacts; unit?: WorkUnit; opening?: { id: string; code: string; job: string }; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { dialog.current?.showModal(); }, []);
  return <dialog ref={dialog} className="report-unit-dialog" onCancel={onClose} onClose={onClose}>
    <div className="activity-detail-heading"><h2>Unit {unit?.label ?? opening?.code}</h2><button type="button" onClick={onClose}>Close</button></div>
    {record && <p>{workAttribution(record)} · {record.activity} · {record.person} · {(record.seconds / 60).toFixed(2)} min<br />{record.started} → {record.ended}<br />Source: {record.sourceTable ?? "Unknown"} · {record.id}</p>}
    {facts && <><p>{opening?.job} · {facts.linkConflict ? "Conflicting opening attribution" : opening?.id && opening.id !== "Unlinked" ? `Opening ${opening.code}` : "No physical opening link recorded"}</p><p>{facts.category ?? "Unknown category"} · {facts.subtype ?? "Unknown operation"} · {facts.configuration ?? "Unknown configuration"} · {facts.system ?? "Unknown system"} · {facts.floorLabel} · {facts.materialLabel}</p><p>Area: {facts.dimensionConflict ? "Conflicting dimensions — excluded from rates" : facts.area === null ? "Unknown" : `${facts.area.toFixed(2)} ft²`} · {facts.dimensionSource ?? "No dimension source"}</p>{!!facts.warnings.length && <p role="status">{facts.warnings.join(" · ")}</p>}{facts.context?.spec && <p>Job spec {facts.context.spec.mark_code}: {facts.context.spec.width_in} × {facts.context.spec.height_in} in · {facts.context.spec.style} · Operation: {facts.context.spec.operation ?? "Unknown"} · Product line: {facts.context.spec.product_line ?? "Unknown"}</p>}{facts.review && <p className="unit-fact-source">Drawing review: {facts.review.source} · page {facts.review.page} · {facts.review.reviewedOn}. {facts.review.note} Documentary review only; latest revision and installed condition are not verified.</p>}{facts.classification && <details><summary>Classification sources</summary>{(["category", "subtype", "configuration", "system", "material"] as const).map(field => <div key={field}><strong>{field} · {facts.classification[field].status}</strong>{facts.classification[field].evidence.length ? facts.classification[field].evidence.map((item, index) => <p key={index}>{item.source}: {item.raw} → {item.value ?? "Unmapped"}</p>) : <p>No recorded evidence</p>}</div>)}</details>}<p className="activity-unit-note">Sources: opening signature, job-scoped specification, explicit catalog link and current custom facts. Text mappings are derived; confirmed specs do not establish field verification.</p></>}
    {unit ? <>
    <p>Recorded type: {unit.type_label || "Unknown"}</p>
    <p className="activity-unit-note">Current saved unit details. Recognized type labels contribute derived classification evidence; the original label is retained.</p>
    <dl>{Object.entries(unit.facts).filter(([, value]) => value !== null && value !== undefined && value !== "").map(([key, value]) => <div key={key}><dt>{FACT_LABELS[key] ?? key}</dt><dd>{factText(key, value)}</dd></div>)}</dl>
    {!Object.keys(unit.facts).length && <p>No unit facts recorded.</p>}
    </> : <><p>Job: {opening?.job}</p><p>Opening: {opening?.code}</p><p className="activity-unit-note">Physical opening ID: {opening?.id}</p><p>No linked custom unit facts.{!facts && " Opening/spec context has not been loaded in this view."}</p></>}
  </dialog>;
}
