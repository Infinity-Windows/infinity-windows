import {ClockStatusFlags} from "./ClockStatusFlags";
import {TablePage, ListPage} from "./TablePage";
import {formatHours} from "./formatHours";
import { createPortal } from "react-dom";
import { UserRound, UsersRound, Eye, EyeOff, ArrowLeftRight } from "lucide-react";
import type { JobScope } from "./useJobScope";
import { Fragment, useState, useRef, useLayoutEffect, useEffect } from "react";
import type { TimeShift } from "../../lib/timeclock";
import { jobTimeReport } from "../../lib/jobTimeReport";
import { clockCodeLabel, ClockRecordTable } from "./ClockRecordTable";
import { TableSelection } from "./TableSelection";
import { isGroupRowControl } from "./groupRowInteraction";

export function JobsTable({ scope, includeUnassigned = false, jobs, records, names, statuses, selected, onSelect, excludedCodes=[], onExcludedCodes }: {
 excludedCodes?:string[]; onExcludedCodes?:(codes:string[])=>void;
 scope?: {scopes:Map<string,JobScope>;loading:boolean;error:unknown}; includeUnassigned?: boolean; jobs: string[]; records: TimeShift[]; names: Map<string,string>; statuses: Map<string,string>;
 selected: string[]; onSelect: (ids:string[])=>void; onCompare?: ()=>void;
}) {
 const root=useRef<HTMLElement>(null);
 const [jobLimit,setJobLimit]=useState(15);
 const returnPosition=useRef<{job:string;code:string;top:number;parents:{node:HTMLElement;top:number;left:number}[]}|null>(null);
 const captureReturn=(button:HTMLButtonElement,job:string,code:string)=>{
  const parents:{node:HTMLElement;top:number;left:number}[]=[];
  for(let node=button.parentElement;node;node=node.parentElement)if(node.scrollHeight>node.clientHeight||node.scrollWidth>node.clientWidth)parents.push({node,top:node.scrollTop,left:node.scrollLeft});
  returnPosition.current={job,code,top:button.getBoundingClientRect().top,parents};
 };
 const [tableView,setTableView]=useState<"jobs"|"activities">("activities");
 const [expandedActivities,setExpandedActivities]=useState<string[]>([]);
 const [comparisonMeasure,setComparisonMeasure]=useState<"rate"|"hours">("rate");
 const [compareCode,setCompareCode]=useState<{id:string;label:string}|null>(null);
 const [areaJob,setAreaJob]=useState<string|null>(null);
 const [expanded,setExpanded]=useState<string[]>([]);
 const [sort,setSort]=useState({key:"latest",descending:true});
 useEffect(()=>{
  if(!compareCode)return;
  const previous=document.body.style.overflow;document.body.style.overflow="hidden";
  root.current?.querySelector<HTMLButtonElement>("button")?.focus({preventScroll:true});
  return ()=>{document.body.style.overflow=previous;};
 },[compareCode]);
 useLayoutEffect(()=>{
  if(compareCode||!returnPosition.current)return;
  const position=returnPosition.current;returnPosition.current=null;
  const restore=()=>{
  for(const item of position.parents)if(item.node.isConnected){item.node.scrollTop=item.top;item.node.scrollLeft=item.left;}
  const button=[...(root.current?.querySelectorAll<HTMLButtonElement>("[data-compare-job]")??[])].find(node=>node.dataset.compareJob===position.job&&node.dataset.compareCode===position.code);
  if(button){button.focus({preventScroll:true});const delta=button.getBoundingClientRect().top-position.top;const parent=position.parents.find(item=>item.node.isConnected&&item.node.scrollHeight>item.node.clientHeight);if(parent)parent.node.scrollTop+=delta;}
  };
  restore();
  // Repeat after the overlay scroll lock is released and browser anchoring settles.
  const frame=requestAnimationFrame(restore);
  return ()=>cancelAnimationFrame(frame);
 },[compareCode]);
 useLayoutEffect(()=>{
  if(tableView!=="activities"||compareCode)return;
  const section=root.current;
  if(!section)return;
  let frame=0;
  const update=()=>{
   const header=section.querySelector<HTMLElement>("thead th");
   if(!header)return;
   const height=0;
   section.style.setProperty("--activity-header-height",`${height}px`);
   const edge=0;
   for(const body of section.querySelectorAll<HTMLElement>("tbody[data-activity-open]")){
    const bounds=body.getBoundingClientRect();
    body.dataset.pinned=String(body.dataset.activityOpen==="true"&&bounds.top<=edge&&bounds.bottom>edge);
   }
  };
  const schedule=()=>{cancelAnimationFrame(frame);frame=requestAnimationFrame(update);};
  const observer=new ResizeObserver(schedule);observer.observe(section);
  document.addEventListener("scroll",schedule,true);window.addEventListener("resize",schedule);update();
  return ()=>{cancelAnimationFrame(frame);observer.disconnect();document.removeEventListener("scroll",schedule,true);window.removeEventListener("resize",schedule);};
 });
 const changeSort=(key:string)=>setSort(old=>{
  const firstDescending=!["job","status"].includes(key);
  if(old.key!==key)return {key,descending:firstDescending};
  return old.descending===firstDescending?{key,descending:!firstDescending}:{key:"latest",descending:true};
 });
 const heading=(key:string,label:string,title?:string)=><th scope="col" title={title} aria-sort={sort.key===key?(sort.descending?"descending":"ascending"):"none"}><button type="button" onClick={()=>changeSort(key)}>{label}{sort.key===key?(sort.descending?" ↓":" ↑"):""}</button></th>;
 const unique=[...new Map(records.filter(s=>s.status!=="voided"&&(!compareCode||(s.cost_code_id??"no-code")===compareCode.id)).map(s=>[s.id,s])).values()];
 const rows=[...new Set([...jobs.filter(Boolean), ...(includeUnassigned || unique.some(s=>!s.project_id)?[""]:[])])].map(id=>{
  const shifts=unique.filter(s=>(s.project_id??"")===id);
  const totals=jobTimeReport(compareCode?shifts:shifts.filter(shift=>!excludedCodes.includes(shift.cost_code_id??"no-code")),Date.now());
  const facts=scope?.scopes.get(id);
  const rate=facts&&facts.area>0&&totals.recordedCount>0?totals.recordedHours*60/facts.area:null;
  const latest=shifts.length ? Math.max(...shifts.map(s=>Date.parse(s.clock_in_at)).filter(Number.isFinite)) : null;
  return {id,shifts,totals,facts,rate,latest,label:id ? names.get(id)??shifts[0]?.projects?.job_code??id : "Unassigned work"};
 }).filter(row=>!compareCode||row.shifts.length>0).sort((a,b)=>{
  const value=(row:typeof a):string|number|null=>sort.key==="job"?row.label:sort.key==="status"?(row.id?statuses.get(row.id)??null:null):sort.key==="installed"?(row.facts&&row.facts.openings>0?row.facts.installed/row.facts.openings:null):sort.key==="area"?(row.facts?.known?row.facts.area:null):sort.key==="rate"?row.rate:sort.key==="people"?row.totals.peopleCount:sort.key==="hours"?row.totals.recordedHours:row.latest;
  const av=value(a),bv=value(b);
  if(av===null&&bv!==null)return 1;if(bv===null&&av!==null)return -1;
  const order=typeof av==="string"&&typeof bv==="string"?av.localeCompare(bv,undefined,{numeric:true}):Number(av)-Number(bv);
  return (sort.descending?-order:order)||a.label.localeCompare(b.label,undefined,{numeric:true});
 });
 const rateRows=rows.filter(row=>row.rate!==null);
 const rateArea=rateRows.reduce((sum,row)=>sum+(row.facts?.area??0),0);
 const rateMinutes=rateRows.reduce((sum,row)=>sum+row.totals.recordedHours*60,0);
 const weightedRate=rateArea>0?rateMinutes/rateArea:null;
 const selectable=rows.filter(r=>!!r.id);
 const chosen=selectable.filter(r=>selected.includes(r.id));
 const toggle=(id:string)=>setExpanded(old=>old.includes(id)?old.filter(v=>v!==id):[...old,id]);
 if(compareCode){
  const measure=(row:typeof rows[number])=>comparisonMeasure==="rate"?row.rate:row.totals.recordedHours;
  const largest=Math.max(0,...rows.map(row=>measure(row)??0));
  const compared=[...rows].sort((a,b)=>{const av=measure(a),bv=measure(b);return av===null?1:bv===null?-1:bv-av||a.label.localeCompare(b.label);});
  return createPortal(<div className="job-code-overlay"><button type="button" tabIndex={-1} className="job-code-backdrop" aria-label="Close cost-code comparison" onClick={()=>setCompareCode(null)}/><section ref={root} role="dialog" aria-modal="true" className="report-jobs-table job-code-focus" aria-label="Cost-code comparison" onKeyDown={event=>{if(event.key==="Escape")setCompareCode(null);if(event.key==="Tab"){const buttons=[...event.currentTarget.querySelectorAll<HTMLElement>("button,summary,a[href],input,select,[tabindex='0']")].filter(node=>!node.hasAttribute("disabled"));const first=buttons[0],last=buttons[buttons.length-1];if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus();}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}}}}>
   <div className="job-code-comparison"><button type="button" onClick={()=>setCompareCode(null)}>{tableView==="activities"?"Back to activities":"Back to jobs"}</button><strong>{compareCode.label}</strong><span className="job-comparison-measures">{(["rate","hours"] as const).map(value=><button key={value} type="button" aria-pressed={comparisonMeasure===value} onClick={()=>setComparisonMeasure(value)}>{value==="rate"?"Rate":"Hours"}</button>)}</span></div>
   <div className="job-cost-breakdown"><ListPage>{compared.map(row=>{const value=measure(row),share=value!==null&&largest>0?value/largest*100:0;const areaNote=`${row.facts?.known??0}/${row.facts?.openings??0} openings with usable area; ${row.facts?.unconfirmed??0} catalog-linked measurements. Page-date clocked minutes divided by whole known job area; not completed-job productivity.`;
    return <details key={row.id}><summary><span><strong className="job-code-job-label">{row.label}</strong>{(row.facts?.exclusions?.length??0)>0&&<small className="job-comparison-coverage" title={areaNote}> · {row.facts!.exclusions!.length}*</small>}</span><span className="job-cost-bar" role="meter" aria-label={`${row.label} relative ${comparisonMeasure}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={value===null?undefined:share} aria-valuetext={value===null?"--":`${share.toFixed(1)}% of largest ${comparisonMeasure} among matching jobs`}><i style={{width:`${share}%`}}/></span><span className="job-cost-values" title={areaNote}>{comparisonMeasure==="rate"?<><span className="job-cost-rate">{row.rate===null?"--":`${row.rate.toFixed(2)} m/ft\u00b2`}</span><strong>{formatHours(row.totals.recordedHours)} h</strong></>:<><span className="job-cost-rate">{formatHours(row.totals.recordedHours)} h</span><strong>{row.rate===null?"--":`${row.rate.toFixed(2)} m/ft\u00b2`}</strong></>}</span></summary><ClockRecordTable records={row.shifts} groups={[]} hidden={["job","code"]} compact/></details>;
   })}</ListPage></div><div className="job-code-total">Total · {weightedRate===null?"--":`${weightedRate.toFixed(2)} m/ft\u00b2`} in {formatHours(jobTimeReport(unique,Date.now()).recordedHours)} h</div>
  </section></div>,document.body);
 }
 const switchView=(label:string)=><button type="button" className="job-table-view-toggle" title={tableView==="jobs"?"Switch to activities":"Switch to jobs"} onClick={()=>setTableView(tableView==="jobs"?"activities":"jobs")}><span>{label}</span><ArrowLeftRight size={12} aria-hidden="true"/><small>{tableView==="jobs"?"Activities":"Jobs"}</small></button>;
 if(tableView==="activities"){
  const activities=[...new Set(unique.map(shift=>shift.cost_code_id??"no-code"))].map(id=>{const shifts=unique.filter(shift=>(shift.cost_code_id??"no-code")===id);return {id,shifts,label:clockCodeLabel(shifts[0]),totals:jobTimeReport(shifts,Date.now())};}).sort((a,b)=>b.totals.recordedHours-a.totals.recordedHours||a.label.localeCompare(b.label));
  const max=Math.max(...activities.map(code=>code.totals.recordedHours),0);
  return <section ref={root} className="report-jobs-table report-activities-table" aria-label="Clocked activities"><div className="activity-table report-standard-table"><table><caption className="activity-sr-only">Clocked labor by cost code</caption><thead><tr><th scope="col">{switchView("ACTIVITIES")}</th><th scope="col">Hours</th></tr></thead>{activities.map(code=>{
   const open=expandedActivities.includes(code.id);
   return <tbody key={code.id} data-activity-open={open} data-excluded={excludedCodes.includes(code.id)||undefined}><tr className="report-group-row" onClick={event=>{if(!isGroupRowControl(event.target))setExpandedActivities(old=>old.includes(code.id)?old.filter(id=>id!==code.id):[...old,code.id]);}}><th scope="row"><div className="job-code-label"><button type="button" className="activity-visibility" aria-label={`${excludedCodes.includes(code.id)?"Include":"Exclude"} ${code.label} in clocked totals`} aria-pressed={!excludedCodes.includes(code.id)} onClick={()=>onExcludedCodes?.(excludedCodes.includes(code.id)?excludedCodes.filter(id=>id!==code.id):[...excludedCodes,code.id])}>{excludedCodes.includes(code.id)?<EyeOff size={15}/>:<Eye size={15}/>}</button><button type="button" className="report-expand" aria-label={`Clock records for ${code.label}`} aria-expanded={open} onClick={()=>setExpandedActivities(old=>old.includes(code.id)?old.filter(id=>id!==code.id):[...old,code.id])}>{open?"▾":"▸"} {code.label}</button><button type="button" className="job-code-compare" data-compare-job="activities" data-compare-code={code.id} aria-label={`Compare ${code.label} by jobs`} onClick={event=>{event.stopPropagation();captureReturn(event.currentTarget,"activities",code.id);setComparisonMeasure("rate");setCompareCode({id:code.id,label:code.label});}}>Compare by jobs</button></div><span className="job-cost-bar" role="meter" aria-label={`${code.label} share relative to largest activity`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={max?code.totals.recordedHours/max*100:0}><i style={{width:`${max?code.totals.recordedHours/max*100:0}%`}}/></span></th><td><strong>{formatHours(code.totals.recordedHours)} h</strong><small className="job-people-count">{code.totals.peopleCount} <UsersRound size={14} aria-hidden="true"/></small><ClockStatusFlags running={code.totals.runningCount} unresolved={code.totals.unresolvedCount}/></td></tr>{open&&<tr className="report-leaf-row"><td colSpan={2}><ClockRecordTable records={code.shifts.map(shift=>({...shift,projects:shift.project_id?{...shift.projects,job_code:shift.projects?.job_code??names.get(shift.project_id)??shift.project_id}:null} as TimeShift))} groups={[]} hidden={["code"]} compact/></td></tr>}</tbody>;
  })}</table></div></section>;
 }
 return <section ref={root} className="report-jobs-table" aria-label="Recent jobs">
  {!rows.length ? <p>No jobs with recorded work in this date range.</p> : <div className="activity-table report-standard-table"><table><caption className="activity-sr-only">Recent jobs and clocked labor</caption><thead><tr><th><TableSelection label="Select all jobs to compare" checked={chosen.length===selectable.length && selectable.length>0} mixed={chosen.length>0} onChange={()=>onSelect(chosen.length===selectable.length && selectable.length>0?[]:selectable.map(r=>r.id))}/></th><th scope="col">{switchView(`JOBS ${selectable.length}`)}</th>{heading("status","Status")}{heading("installed","Installed")}{heading("area","Area","Resolved opening area; missing/conflicting dimensions excluded. Coverage is not field verification.")}<th scope="col" className="job-labor-heading" aria-sort={["hours","rate"].includes(sort.key)?(sort.descending?"descending":"ascending"):"none"}><button type="button" className="job-rate-sort" aria-label="Sort by minutes per square foot" aria-pressed={sort.key==="rate"} onClick={()=>changeSort("rate")}>Rate{sort.key==="rate"?(sort.descending?" \u2193":" \u2191"):""}</button></th></tr></thead><tbody><TablePage columns={6} limit={jobLimit} onMore={()=>setJobLimit(n=>n+15)}>{rows.map(row=>{
   const open=expanded.includes(row.id);
   const facts=scope?.scopes.get(row.id);
   const unavailable=scope?.error ? "Unavailable" : scope?.loading ? "Loading…" : "Unknown";
   const codes=[...new Set(row.shifts.map(s=>s.cost_code_id??"no-code"))].map(id=>{
    const shifts=row.shifts.filter(s=>(s.cost_code_id??"no-code")===id);
    return {id,shifts,label:clockCodeLabel(shifts[0]),totals:jobTimeReport(shifts,Date.now())};
   }).sort((a,b)=>b.totals.recordedHours-a.totals.recordedHours || a.label.localeCompare(b.label));
   return <Fragment key={row.id}><tr className="report-group-row" data-selected={selected.includes(row.id)||undefined} onClick={e=>{if(!isGroupRowControl(e.target))toggle(row.id);}}><td>{row.id && <TableSelection label={`Compare job ${row.label}`} checked={selected.includes(row.id)} onChange={()=>onSelect(selected.includes(row.id)?selected.filter(id=>id!==row.id):[...selected,row.id])}/>}</td><th scope="row"><button type="button" className="report-expand job-name-expand" aria-label={`Cost codes for ${row.label}`} aria-expanded={open} onClick={()=>toggle(row.id)}>{row.label}</button></th><td>{row.id ? (!statuses.get(row.id)||statuses.get(row.id)?.toLowerCase()==="unknown"?"--":statuses.get(row.id)) : "—"}<small className="job-people-count" aria-label={`${row.totals.peopleCount} ${row.totals.peopleCount===1?"person":"people"} with clock records`}>{row.totals.peopleCount}{row.totals.peopleCount>1?<UsersRound size={14} aria-hidden="true"/>:<UserRound size={14} aria-hidden="true"/>}</small></td><td>{!row.id?"—":facts&&facts.openings>0?<span className="job-install-progress" title="Recorded installed openings; does not establish job closeout"><progress aria-label={`${row.label} installed openings`} max={facts.openings} value={facts.installed}/><small>{facts.installed}/{facts.openings}{facts.unknownStatus?` · ${facts.unknownStatus} status unknown`:""}</small></span>:facts?"--":unavailable}</td><td>{!row.id?"—":facts?<><span className="job-opening-area">{facts.known?<>{`${facts.area.toLocaleString("en-US",{maximumFractionDigits:0})} ft\u00b2`}</>:"--"}</span>{(facts.exclusions?.length??facts.openings-facts.known)>0&&<button type="button" className="job-area-coverage" aria-label={`Review area coverage for ${row.label}`} onClick={()=>setAreaJob(row.id)} title={`${facts.openings-facts.known} missing measurements; ${facts.exclusions?.filter(item=>item.unconfirmed).length??0} unconfirmed measurements; ${facts.known}/${facts.openings} have usable area`}>{facts.exclusions?.length??facts.openings-facts.known}*</button>}</>:unavailable}</td><td><small className="job-hours-rate" title={row.rate===null?"Requires known opening area and finished clock records":`${(row.totals.recordedHours*60).toFixed(1)} finished clocked min ÷ ${facts!.area.toFixed(2)} known ft². Visible cost codes; page dates, whole known inventory. ${facts!.unconfirmed??0} openings use unconfirmed catalog measurements. ${facts!.complete?"Complete recorded area coverage; not verified completed-job productivity.":"Incomplete area denominator; not a complete-job rate."}`}>{row.rate===null?"—":`${row.rate.toFixed(2)} m/ft\u00b2`}</small><span className="job-total-hours">{formatHours(row.totals.recordedHours)} h</span><ClockStatusFlags running={row.totals.runningCount} unresolved={row.totals.unresolvedCount}/></td></tr>{open&&<tr className="report-leaf-row"><td colSpan={6}><div className="job-cost-breakdown" aria-label={`${row.label} cost-code allocations`}>{codes.map(code=>{
 const largest=Math.max(0,...codes.map(code=>code.totals.recordedHours));
 const relative=largest>0?code.totals.recordedHours/largest*100:0;
 const rate=facts&&facts.area>0&&code.totals.recordedCount>0?code.totals.recordedHours*60/facts.area:null;
 return <details key={code.id} data-excluded={excludedCodes.includes(code.id)||undefined}><summary><span className="job-code-label"><span>{code.label}</span>{!compareCode&&<button type="button" className="job-code-compare" data-compare-job={row.id} data-compare-code={code.id} aria-label={`Compare ${code.label} across jobs`} onClick={event=>{event.preventDefault();event.stopPropagation();captureReturn(event.currentTarget,row.id,code.id);setComparisonMeasure("rate");setCompareCode({id:code.id,label:code.label});}}>Compare</button>}</span><span className="job-cost-bar" role="meter" aria-label={`${code.label} relative to largest cost-code allocation`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={relative} aria-valuetext={`${relative.toFixed(1)}% of largest cost-code hours in ${row.label}`} title="Bars scale to this job's largest cost-code allocation, not total job hours"><i style={{width:`${relative}%`}}/></span><span className="job-cost-values"><span className="job-cost-rate">{rate===null?"\u2014":`${rate.toFixed(2)} m/ft\u00b2`}</span><strong>{formatHours(code.totals.recordedHours)} h</strong></span></summary><ClockRecordTable records={code.shifts} groups={[]} hidden={["job","code"]} compact/></details>;
 })}</div>{!codes.length&&<p>{row.id ? "No clock records. This job is available because activity work was recorded." : "No unassigned clock records in this date range."}</p>}</td></tr>}</Fragment>;
  })}</TablePage></tbody></table></div>}
 {areaJob!==null && <section role="dialog" aria-modal="false" aria-label={`Area coverage for ${names.get(areaJob)??areaJob}`} className="job-area-review" onKeyDown={event=>{if(event.key==="Escape"){event.stopPropagation();setAreaJob(null);}}}>
  <header><h3>{names.get(areaJob)??areaJob} · Measurement sources</h3><button autoFocus type="button" aria-label="Close area coverage" onClick={()=>setAreaJob(null)}>✕</button></header>
  {(()=>{const facts=scope?.scopes.get(areaJob);return !facts?<p>Opening evidence unavailable.</p>:!facts.exclusions?.length?<p>No unconfirmed measurements.</p>:<ul className="job-unconfirmed-openings">{[...facts.exclusions].sort((a,b)=>a.code.localeCompare(b.code,undefined,{numeric:true})).map(opening=><li key={opening.id}><a href={`/projects/${areaJob}?tab=maps-interactive&mapview=sheets`} title={[...opening.reasons,...opening.dimensions].join("; ")}>{opening.code} <small>{opening.conflict?"Sources disagree":opening.reasons.some(reason=>/disagree|conflict/i.test(reason))?"Sources disagree":opening.unconfirmed?"Catalog-linked":"Missing measurement"}</small></a></li>)}</ul>})()}

 </section>}
 </section>;
}
