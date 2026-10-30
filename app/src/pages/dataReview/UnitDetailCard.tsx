import {unitDisplay} from "./unitDisplay";
import {formatHours} from "./formatHours";
import { RecordTable } from "./ActivityAccordion";
import type { ProjectOpening } from "../../lib/install/types";
import { reviewedOpeningFlags } from "./documentationEvidence";
import type { ReactNode } from "react";
import type { ActivityRow } from "./activityRows";
import type { ReportingFacts } from "./reportingFacts";
import type { ReviewOpening } from "./openingReviewContext";
import { unitOpeningProgress, type UnitPhase } from "./unitOpeningProgress";

export function UnitDetailCard({ opening, job, facts, conflict, phases, rows, workflow, dbOpening }: {
  dbOpening?: ProjectOpening; opening: ReviewOpening; job: string; facts: ReportingFacts; conflict: boolean;
  phases: UnitPhase[]; rows: ActivityRow[]; children: ReactNode; workflow?: ReactNode; documents?: ReactNode;
}) {
  const catalog = dbOpening?.window_types ?? facts.context?.catalogType;
  const width = catalog?.width_in ?? facts.width, height = catalog?.height_in ?? facts.height;
  const seconds=rows.reduce((sum,row)=>sum+row.seconds,0);
  const rate=!conflict&&facts.area!=null&&facts.area>0?seconds/60/facts.area:null;
  const installed=(dbOpening?.status??opening.status)==="installed";
  const progress = unitOpeningProgress(opening, phases);
  return <section className="unit-detail-card" aria-label={`Unit ${opening.opening_code} details`}>
    <header><div><h3 title={opening.opening_code}><a href={`/projects/${opening.project_id}?tab=maps-interactive&mapview=sheets&opening=${encodeURIComponent(opening.id)}`} target="_blank" rel="noreferrer">Unit {opening.opening_code.replace(/\s+/g," ").trim()}</a> <small>{job} · {catalog?.name ?? facts.context?.spec?.mark_code ?? "--"}</small></h3></div><div className="unit-card-size" title={["Size follows the linked catalog shown on the job",facts.dimensionSource,...facts.warnings].filter(Boolean).join(" · ")}><strong>{width!=null&&height!=null ? `${width}″ × ${height}″` : "--"}</strong><span>{conflict ? "Area unresolved" : facts.area==null ? "--" : `${facts.area.toLocaleString("en-US",{maximumFractionDigits:0})} ft²`}</span></div></header>
    <dl className="unit-identity-details">
      <div title={facts.classification.category.evidence.map(item=>`${item.source}: ${item.raw}`).join("; ")}><dt>Category</dt><dd>{unitDisplay(facts.category ?? "Unknown")}</dd></div>
      <div title={facts.classification.subtype.evidence.map(item=>`${item.source}: ${item.raw}`).join("; ")}><dt>Subtype / operation</dt><dd>{unitDisplay(facts.subtype ?? "Unknown")}</dd></div>
      <div><dt>Configuration</dt><dd>{unitDisplay(facts.configuration ?? "Unknown")}</dd></div>
      <div><dt>Material</dt><dd>{unitDisplay(facts.materialLabel)}</dd></div>
      <div><dt>Location</dt><dd>{unitDisplay(dbOpening?.label ?? facts.floorLabel ?? "Unknown")}</dd></div>
      <div><dt>Status</dt><dd>{unitDisplay(dbOpening?.status ?? opening.status)}</dd></div>
      {facts.context?.spec && <div title={facts.context.spec.style??undefined}><dt>Job spec</dt><dd>{facts.context.spec.mark_code}{facts.context.spec.operation ? ` · ${facts.context.spec.operation}` : ""}</dd></div>}
    </dl>
    {reviewedOpeningFlags(opening.id).length>0 && <p className="unit-fact-warning" title="Reviewed Supabase phase, storage metadata and timecard notes on 2026-10-28. Completion evidence retained; flashing time excluded from measured labor.">{reviewedOpeningFlags(opening.id).join(" / ")}</p>}

    {workflow ?? <div className="unit-card-progress"><strong>{progress.completed}/{progress.expected} known required stages</strong>{progress.stages.map(stage => <span key={stage.label} data-state={stage.state}>{stage.label} · {stage.state === "progress" ? "In progress" : stage.state === "open" ? "Not started" : stage.state}</span>)}</div>}
    {opening.condition === "damaged" && <p className="unit-fact-warning">Damage recorded · blocking status not established</p>}
    {!workflow && opening.ro_check?.judgments && <section className="unit-card-checklist"><h4>Rough-opening checklist</h4>{Object.entries(opening.ro_check.judgments).map(([key, result]) => <div key={key}>{key.replace(/_/g," ")} · {result === "good" ? "Passed" : result === "bad" ? "Needs attention" : "Not recorded"}</div>)}</section>}

    <section className="unit-card-records" aria-label="Activity records">{rows.length ? <RecordTable rows={rows} unitOnly footer={<div className="unit-timer-footer"><span data-installed={installed} title={`Included unit timer minutes divided by ${facts.area??"unknown"} ft². Partial timer coverage, not total installation labor.${installed?"":" Unit not installed."}`}>{rate===null?"--":`${rate.toFixed(2)} min/sq ft`}{!installed&&rate!==null?" · in progress":""}</span><small>{formatHours(seconds/3600)} h</small></div>}/> : <p className="unit-no-records">— No records —</p>}</section>


  </section>;
}
