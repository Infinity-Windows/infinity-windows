import {useEffect,useRef} from "react";
import {createPortal} from "react-dom";
import type {ActivityRow} from "./activityRows";
const readable=(value:string)=>value.replace(/�/g," - ");
export function UnitProblemReview({job,opening,problems,records,onClose}:{job:string;opening:string;problems:string[];records:ActivityRow[];onClose:()=>void}){
 const pane=useRef<HTMLElement>(null);
 useEffect(()=>{const previous=document.activeElement as HTMLElement|null;const overflow=document.body.style.overflow;document.body.style.overflow="hidden";pane.current?.querySelector<HTMLButtonElement>("button")?.focus();return()=>{document.body.style.overflow=overflow;previous?.focus({preventScroll:true});};},[]);
 return createPortal(<div className="job-code-overlay"><button className="job-code-backdrop" type="button" tabIndex={-1} aria-label="Close unit problem review" onClick={onClose}/><section ref={pane} className="unit-problem-review" role="dialog" aria-modal="true" aria-label={`${job} unit ${opening} problems`} onKeyDown={event=>{if(event.key==="Escape")onClose();if(event.key==="Tab"){const controls=[...event.currentTarget.querySelectorAll<HTMLElement>("button,a[href],summary")];const first=controls[0],last=controls[controls.length-1];if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus();}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}}}}>
 <header><h3>{job} · {opening} · Review</h3><button type="button" onClick={onClose}>Close</button></header>
 <div className="unit-problem-list">{problems.map((problem,index)=>{
 const sources=records.filter(row=>row.reviewReason&&problem===`${row.activity}: ${row.reviewReason}`);
 const label=problem.includes("After-the-fact documentation")?`${sources[0]?.originalActivity??sources[0]?.activity??"Timer"} · Documentation timing`:problem.includes("Uncertain overlap")?`${sources[0]?.originalActivity??sources[0]?.activity??"Timer"} · Uncertain overlap`:problem.startsWith("Conflicting ")?problem.split(":")[0]:problem.split(" - ")[0];
 return <details key={index} className="unit-problem-item"><summary>{label}</summary><p>{readable(problem)}</p>{sources.map(row=><article className="review-source" key={row.id}><span>Recorded account: {row.person||"Unknown"} · worker not confirmed by this account</span><span>{row.started} → {row.ended}</span><span>Saved duration: {Number.isFinite(row.seconds)?`${(row.seconds/60).toFixed(2)} min`:"Unknown"} · Held from measured labor · {row.outcome||"Unknown outcome"}</span><code>{row.sourceTable??"Unknown source"} · {row.id}</code><small>Opening: {row.openingId??"Missing"} · Unit reference: {row.unitId??"Missing"}</small>{!!row.reviewRelatedIds?.length&&<small>Related records: {row.reviewRelatedIds.join(", ")}</small>}</article>)}</details>;
 })}</div>
 <p className="activity-unit-note">Read-only. Completion evidence is separate from measured labor. No timer, payroll or opening values can be changed here.</p>
 </section></div>,document.body);
}
