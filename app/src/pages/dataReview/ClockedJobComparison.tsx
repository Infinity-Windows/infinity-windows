import {ClockStatusFlags} from "./ClockStatusFlags";
import {formatHours} from "./formatHours";
import {useEffect,useState} from "react";
import {jobTimeReport} from "../../lib/jobTimeReport";
import type {TimeShift} from "../../lib/timeclock";
import type {JobScope} from "./useJobScope";
import {clockCodeLabel,ClockRecordTable} from "./ClockRecordTable";
export type ClockMeasure="hours"|"rate";
export function clockComparisonRows(records:TimeShift[],scopes:Map<string,JobScope>,names:Map<string,string>) {
 const unique=[...new Map(records.filter(row=>row.status!=="voided").map(row=>[row.id,row])).values()];
 return [...new Set(unique.map(row=>row.project_id??""))].map(id=>{
  const rows=unique.filter(row=>(row.project_id??"")===id), report=jobTimeReport(rows,Date.now()), scope=scopes.get(id);
  const segments=[...new Set(rows.map(row=>row.cost_code_id??"no-code"))].map(key=>{const matching=rows.filter(row=>(row.cost_code_id??"no-code")===key);const hours=jobTimeReport(matching,Date.now()).recordedHours;return {key,label:clockCodeLabel(matching[0]),hours,records:matching.filter(row=>!!row.clock_out_at)};}).filter(segment=>segment.hours>0);
  return {id,label:names.get(id)??rows[0]?.projects?.job_code??(id?"Unknown job":"Unassigned work"),hours:report.recordedHours,scope,segments,running:report.runningCount,unresolved:report.unresolvedCount};
 }).sort((a,b)=>b.hours-a.hours||a.label.localeCompare(b.label));
}
const colors=["#83b4ba","#a99ac4","#91b399","#c2aa7c","#869fca","#bd9f91","#a7b687"];
export function ClockedJobComparison({records,scopes,names,loading=false,error=false}:{records:TimeShift[];scopes:Map<string,JobScope>;names:Map<string,string>;loading?:boolean;error?:boolean}) {
 const [measure,setMeasure]=useState<ClockMeasure>("hours"),[hidden,setHidden]=useState<string[]>([]),[selection,setSelection]=useState<{job:string;code:string}|null>(null);
 useEffect(()=>setSelection(null),[records]);
 const rows=clockComparisonRows(records,scopes,names);
 const codes=[...new Map(rows.flatMap(row=>row.segments.map(segment=>[segment.key,segment.label] as const))).entries()].sort((a,b)=>a[1].localeCompare(b[1]));
 const value=(hours:number,row:typeof rows[number])=>measure==="hours"?hours:!error&&row.scope&&row.scope.area>0?hours*60/row.scope.area:null;
 const max=Math.max(...rows.map(row=>row.segments.filter(segment=>!hidden.includes(segment.key)).reduce((sum,segment)=>sum+(value(segment.hours,row)??0),0)),.001);
 const display=(value:number)=>measure==="hours"?formatHours(value):value.toFixed(2);
 const unit=measure==="hours"?"h":"min/sq ft";
 const inspected=rows.find(row=>row.id===selection?.job)?.segments.find(segment=>segment.key===selection?.code);
 return <section aria-label="Clocked labor comparison">
 <div className="clocked-code-legend" role="group" aria-label="Comparison cost codes">{codes.map(([key,label],index)=><button key={key} type="button" aria-pressed={!hidden.includes(key)} onClick={()=>setHidden(old=>old.includes(key)?old.filter(id=>id!==key):[...old,key])}><i style={{background:colors[index%colors.length]}}/>{label}</button>)}<div className="clock-compare-toolbar" role="group" aria-label="Clocked comparison measure">{(["hours","rate"] as const).map(value=><button key={value} type="button" aria-pressed={measure===value} onClick={()=>setMeasure(value)}>{value==="hours"?"Hours":"Rate"}</button>)}</div></div>
 {measure==="rate"&&loading&&<p role="status">Loading opening areas…</p>}{measure==="rate"&&error&&<p role="alert">Opening area unavailable; rates are hidden.</p>}
 <div className="clock-compare-rows">{rows.map(row=>{const shown=row.segments.filter(segment=>!hidden.includes(segment.key));const total=shown.reduce((sum,segment)=>sum+(value(segment.hours,row)??0),0);const missing=measure==="rate"&&(loading||value(row.hours,row)===null);return <div key={row.id} className="clock-compare-row"><div><strong>{row.label}</strong>{measure==="rate"&&row.scope&&<small>{row.scope.area.toLocaleString("en-US",{maximumFractionDigits:0})} ft² · {row.scope.known}/{row.scope.openings} measured{!row.scope.complete?" · incomplete":""}{row.scope.unconfirmed?` · ${row.scope.unconfirmed} unconfirmed`:""}</small>}<ClockStatusFlags running={row.running} unresolved={row.unresolved}/></div><div className="clock-compare-track">{!missing&&shown.map(segment=><button key={segment.key} type="button" style={{width:`${(value(segment.hours,row)??0)/max*100}%`,background:colors[codes.findIndex(([key])=>key===segment.key)%colors.length]}} aria-label={`${row.label} · ${segment.label} · ${display(value(segment.hours,row)??0)} ${unit}`} title={`${segment.label}: ${display(value(segment.hours,row)??0)} ${unit}`} onClick={()=>setSelection({job:row.id,code:segment.key})}/>)}</div><strong className="clock-compare-number">{missing?"--":`${display(total)} ${unit}`}</strong></div>;})}</div>
 {!rows.length&&<p>No clocked records in this scope.</p>}{selection&&inspected&&<section aria-label="Comparison timecards"><h4>{rows.find(row=>row.id===selection.job)?.label} · {inspected.label}</h4><button type="button" onClick={()=>setSelection(null)}>Clear selection</button><ClockRecordTable records={inspected.records} groups={[]} hidden={["job","code"]}/></section>}
 </section>;
}
