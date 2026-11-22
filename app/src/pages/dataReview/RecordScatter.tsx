import {formatHours} from "./formatHours";
import {useQuery} from "@tanstack/react-query";
import {readScatterWorkers,timerWorkers} from "./scatterWorkers";
import {reportQueryPolicy} from "./reportQueries";
import {TimecardCoverage} from "./TimecardCoveragePanel";

import {useState} from "react";

import {shiftHours,elapsedWorkSeconds,type TimeShift} from "../../lib/timeclock";

import {useReportShifts} from "./useReportShifts";

import {reportOwner} from "./reportQueries";

import type {ActivityRow} from "./activityRows";

export interface RecordDot {id:string;source:"clock"|"timer";at:number;hours:number;job:string;person:string;personId:string;activity:string;detail:string;held:boolean}

export function recordDots(shifts:TimeShift[],timers:ActivityRow[],jobs:Map<string,string>,from:number,until:number,now=Date.now()):RecordDot[]{

 const clock=shifts.filter(s=>s.status!=="voided" && s.status!=="needs_finish").map(s=>({id:`time_shifts:${s.id}`,source:"clock" as const,at:Date.parse(s.clock_in_at),hours:s.clock_out_at ? shiftHours(s) : elapsedWorkSeconds(s,now)/3600,job:jobs.get(s.project_id??"")??s.project_id??"No job",person:s.profiles?.display_name??s.profile_id,personId:s.profile_id,activity:s.cost_codes ? `${s.cost_codes.code} / ${s.cost_codes.label}` : s.cost_code_id??"No cost code",detail:`${s.clock_in_at} → ${s.clock_out_at??"Running"}${s.note ? ` / ${s.note}` : ""}`,held:false}));

 const activity=timers.map(r=>({id:r.id,source:"timer" as const,at:Date.parse(r.started),hours:r.seconds/3600,job:jobs.get(r.jobId??"")??r.job??"No job",person:r.person,personId:r.personId,activity:r.originalActivity??r.activity,detail:`Unit ${r.unit || "None"} / ${r.sourceTable} / ${r.started} → ${r.ended}${r.reviewReason ? ` / ${r.reviewReason}` : ""}`,held:!!r.reviewReason}));

 return [...clock,...activity].filter(r=>Number.isFinite(r.at)&&Number.isFinite(r.hours)&&r.hours>=0&&r.at>=from&&r.at<until);

}

export function RecordScatter({jobs,jobNames,from,until,timers,active,roles,people}:{jobs:string[];jobNames:Map<string,string>;from:number;until:number;timers:ActivityRow[];active:boolean;roles?:Map<string,string>;people?:Map<string,string>}){

 const query=useReportShifts(reportOwner(),jobs,from,until,active);

 const [hidden,setHidden]=useState<string[]>([]),[selected,setSelected]=useState<string|null>(null);

 const [installersOnly,setInstallersOnly]=useState(false),[showUnknown,setShowUnknown]=useState(true);
 const workerQuery=useQuery({...reportQueryPolicy,queryKey:["dataReview",reportOwner(),"scatterWorkers",[...jobs].sort(),from,until,timers.map(t=>[t.id,t.ended])],enabled:active&&jobs.length>0&&timers.length>0,queryFn:({signal})=>readScatterWorkers(jobs,timers,from,until,signal)});
 const raw=recordDots(query.data??[],timers,jobNames,from,until).map(d=>{
  const row=d.source==="timer"?timers.find(t=>t.id===d.id):undefined;
  const evidence=row?timerWorkers(row,workerQuery.data?.events??[],workerQuery.data?.crew??[]):{ids:d.personId?[d.personId]:[],basis:"Timecard worker",refs:[]};
  const unknown=!evidence.ids.length||evidence.ids.some(id=>!roles?.has(id));
  const installer=evidence.ids.some(id=>roles?.get(id)==="installer");
  return {...d,evidence,unknown,installer};
 });
 const all=raw.filter(d=>(!installersOnly||d.installer||d.unknown)&&(!d.unknown||showUnknown)),dots=all.filter(d=>!hidden.includes(d.source));

 const chosen=dots.find(d=>d.id===selected);

 const min=Number.isFinite(from)?from:Math.min(...all.map(d=>d.at),Date.now());

 const max=Number.isFinite(until)?until:Math.max(...all.map(d=>d.at),min+86400000);

 const peak=Math.max(1,...dots.map(d=>d.hours));

 const unresolved=(query.data??[]).filter(s=>s.status==="needs_finish"&&(!installersOnly||roles?.get(s.profile_id)==="installer"||!roles?.has(s.profile_id))&&(showUnknown||roles?.has(s.profile_id)));

 if(query.error)return <p role="alert">Clock records could not load: {String(query.error)}</p>;

 return <section className="record-scatter" aria-label="Individual clock records and activity timers"><div className="record-scatter-toolbar"><div className="record-scatter-controls" role="group" aria-label="Record sources">{(["clock","timer"] as const).map(source=><button type="button" key={source} data-source={source} aria-pressed={!hidden.includes(source)} onClick={()=>setHidden(old=>old.includes(source)?old.filter(s=>s!==source):[...old,source])}><i aria-hidden="true"/>{source==="clock"?"Clock records":"Activity timers"} · {all.filter(d=>d.source===source).length}</button>)}</div>

 <div className="record-scatter-controls" role="group" aria-label="Scatter worker filters"><button type="button" aria-pressed={installersOnly} onClick={()=>setInstallersOnly(v=>!v)}>Installers only</button><button type="button" aria-pressed={showUnknown} onClick={()=>setShowUnknown(v=>!v)}>Unknown worker · {raw.filter(d=>d.unknown).length}</button></div></div>

 {workerQuery.isFetching&&<small role="status">Checking worker credits...</small>}{workerQuery.error&&<p role="alert">Worker credits unavailable; affected timers remain unknown.</p>}
 {query.isPending?<p role="status">Loading clock records…</p>:<svg className="record-scatter-plot" viewBox="0 0 900 460" role="group" aria-label="Each dot is one record: start date and recorded hours"><text x="12" y="17" fill="currentColor" fontSize="12">Recorded hours</text>{[0,1,2,3,4].map(i=>{const value=peak*i/4,y=405-i*92;return <g key={i}><line x1="60" x2="875" y1={y} y2={y} stroke="#87929d30"/><text x="52" y={y+4} textAnchor="end" fill="currentColor" fontSize="11">{formatHours(value,1)}</text></g>})}{[0,1,2,3,4].map(i=><text key={i} x={60+i*203.75} y="432" textAnchor={i===0?"start":i===4?"end":"middle"} fill="currentColor" fontSize="11">{new Date(min+(max-min)*i/4).toLocaleDateString(undefined,{month:"short",day:"numeric",timeZone:"America/Denver"})}</text>)}{dots.map(d=><circle key={d.id} cx={60+(d.at-min)/Math.max(1,max-min)*815} cy={405-d.hours/peak*368} r={selected===d.id?6:4} fill={d.held?"none":d.source==="clock"?"#7fabc6":"#c9a774"} stroke={d.source==="clock"?"#7fabc6":"#c9a774"} strokeWidth="1.5" opacity=".8" tabIndex={0} role="button" aria-label={`${d.source==="clock"?"Clock record":"Activity timer"}, ${d.job}, ${d.person}, ${formatHours(d.hours)} hours${d.held?", held":""}`} onClick={()=>setSelected(d.id)} onKeyDown={e=>{if(e.key==="Enter" || e.key===" "){e.preventDefault();setSelected(d.id);}}}><title>{d.job} / {d.person} / {d.activity} / {formatHours(d.hours)} h / {d.id}</title></circle>)}</svg>}



 {chosen&&<div className="record-scatter-detail"><button type="button" onClick={()=>setSelected(null)}>Clear selection</button><strong>{chosen.job} · {chosen.source==="timer"?`Timer account: ${chosen.person}`:chosen.person} · {formatHours(chosen.hours)} h</strong><span>{chosen.source==="clock"?"Clock record":"Activity timer"} · {chosen.activity}{chosen.held?" · Held from totals":""}</span><p>Worker evidence: {chosen.evidence.ids.length?chosen.evidence.ids.map(id=>people?.get(id)??id).join(", "):"Unknown"}<br/>{chosen.evidence.basis}</p><small>{chosen.evidence.refs.join(" / ")}</small><p>{chosen.source==="timer"?`Original timer account: ${chosen.person}. `:""}{chosen.detail}</p><code>{chosen.id}</code></div>}

 {!!unresolved.length&&<details><summary>{unresolved.length} clock records need a finish time · duration unavailable</summary>{unresolved.map(s=><p key={s.id}>{jobNames.get(s.project_id??"")} · {s.clock_in_at} · {s.id}</p>)}</details>}

 {!query.isPending&&!dots.length&&<p>No records match these sources, roles and dates.</p>}{!query.isPending&&<TimecardCoverage shifts={query.data??[]} timers={timers} from={from} until={until} jobs={jobNames} roles={roles} people={people} workers={new Map(raw.map(d=>[d.id,d.evidence]))}/>}</section>;

}
