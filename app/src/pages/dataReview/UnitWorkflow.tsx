import { Children, isValidElement, useEffect, useId, useState, type ReactElement, type ReactNode } from "react";
import type { ProjectOpening } from "../../lib/install/types";
import type { RecordEvent } from "../../lib/install/record";
import { unitOpeningProgress, type UnitPhase } from "./unitOpeningProgress";
import type { ReviewOpening } from "./openingReviewContext";
import { roVerdicts } from "../../lib/install/roCheck";

export function UnitWorkflow({ opening, phases, events, photos, inventory, width = null, height = null }: { opening: ProjectOpening; phases: UnitPhase[]; events: RecordEvent[]; photos: number; inventory?: {status:string;window_type_id:string} | null; width?:number | null; height?:number | null }) {
  const phaseTimes = phases.filter(phase=>phase.opening_id===opening.id).flatMap(phase=>[phase.started_at,phase.submitted_at]).filter((date):date is string=>!!date).map(Date.parse).filter(Number.isFinite);
  const workTimes = [opening.work_started_at,opening.work_ended_at,...events.filter(event=>!event.voided_at).flatMap(event=>[event.started_at,event.created_at])].filter((date):date is string=>!!date).map(Date.parse).filter(Number.isFinite);
  const latestPhase = Math.max(-Infinity,...phaseTimes),latestInstall=Math.max(-Infinity,...workTimes);
  const suggested = latestPhase>latestInstall ? 2 : latestInstall>-Infinity || opening.status==="installed" ? 3 : opening.ro_check || opening.ro_quick_ok ? 2 : 1;
  const [focus,setFocus]=useState<number|null>(suggested); const groupId=useId();
  useEffect(()=>setFocus(suggested),[opening.id,suggested,latestPhase,latestInstall]);
  const stages = unitOpeningProgress(opening as unknown as ReviewOpening, phases);
  const latest = events.filter(event => !event.voided_at).at(-1);
  const judgment = (key: string) => opening.ro_check?.judgments?.[key];
  const numbers = (values: (string | number | null)[] = []) => values.map(value => { const n = Number(value); return Number.isFinite(n) && n > 0 ? n : null; });
  const verdicts = roVerdicts({ diagonals:numbers(opening.ro_check?.diagonals), widths:numbers(opening.ro_check?.widths), heights:numbers(opening.ro_check?.heights), unitWidthIn:width, unitHeightIn:height });
  const roState = (key:string) => { const measured = verdicts.find(verdict => verdict.check === key)?.measured; return measured === "bad" || judgment(key) === "bad" ? "Needs attention" : measured === "good" ? "Passed measurements" : judgment(key) === "good" ? "Passed judgment" : "Not recorded"; };
  const check = (label: string, value: string) => {
   const absent=value==="--"||["Not recorded","Not established","Not started","Completion not recorded","Requirement unknown"].includes(value);
   const problem=/attention|Damage|Mismatch/.test(value);
   const done=!absent&&!problem&&value!=="In progress";
   const hidden=["Recorded","Assigned","Matches","Passed measurements","Passed judgment","Completed","Filed"].includes(value);
   return <li key={label} data-complete={done||undefined} title={value}><span>{label}</span>{!hidden&&<strong>{absent?"--":value}</strong>}</li>;
 };
 const measurements=(values:(string|number|null)[]|undefined)=>values?.filter(value=>value!==null&&value!==""&&Number(value)>0).map(value=>`${value}″`).join(" / ")||"--";
  const phase=(label:string,list:ReactElement<{children:ReactNode}>)=>{
    const items=Children.toArray(list.props.children).filter(isValidElement);
    const completed=items.filter(item=>(item.props as {"data-complete"?:boolean})["data-complete"]).length;
    return <><summary data-complete={items.length>0&&completed===items.length||undefined}>{label} <small>{completed}/{items.length}</small></summary>{list}</>;
  };
  return <div className="unit-workflow">
    <details name={groupId} open={focus===1} onToggle={event=>{if(event.currentTarget.open)setFocus(1);}}>{phase("1 · Preparation",<ul>{check("Specs checked against plans", opening.confirmed ? "Recorded" : "Not recorded")}{check("Physical unit assigned", opening.assigned_window_id ? "Assigned" : "Not recorded")}{check("Assigned unit type", inventory && opening.window_type_id ? inventory.window_type_id === opening.window_type_id ? "Matches" : "Mismatch · needs attention" : "Not established")}{check("Inventory state", inventory?.status.replace(/_/g," ") ?? "Not recorded")}{check("Condition check", opening.condition === "damaged" ? "Damage recorded" : opening.condition && opening.condition !== "unknown" ? opening.condition.replace(/_/g," ") : "Not recorded")}</ul>)}</details>
    <details name={groupId} open={focus===2} onToggle={event=>{if(event.currentTarget.open)setFocus(2);}}>{phase("2 · Opening preparation",<ul>{check("RO diagonals", measurements(opening.ro_check?.diagonals))}{check("RO width", measurements(opening.ro_check?.widths)+(roState("width")==="Needs attention"?" · Needs attention":""))}{check("RO height", measurements(opening.ro_check?.heights)+(roState("height")==="Needs attention"?" · Needs attention":""))}{opening.ro_quick_ok && check("Quick fit check", "Recorded · no measured checklist implied")}{stages.stages.filter(stage => stage.label.startsWith("Flashing")).map(stage => check(stage.label, stage.state === "open" ? opening.status === "installed" ? "Completion not recorded" : "Not started" : stage.state === "progress" ? "In progress" : stage.state === "unknown" ? "Requirement unknown" : "Completed"))}{opening.needs_flashing === false && check("Flashing", "Not required")}</ul>)}</details>
    <details name={groupId} open={focus===3} onToggle={event=>{if(event.currentTarget.open)setFocus(3);}}>{phase("3 · Installation & closeout",<ul>{check("Installation work", opening.status === "installed" ? "Completed" : opening.work_started_at ? "In progress" : "Not started")}{check("Installation record", latest ? "Filed" : "Not recorded")}{check("Quality grade", latest?.quality_grade != null ? String(latest.quality_grade) : "Not recorded")}{check("Installation photos", photos ? `${photos} recorded · before/after role unverified` : "Not recorded")}</ul>)}</details>

  </div>;
}
