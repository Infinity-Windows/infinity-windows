import {SkeletonList} from "../../components/ui/States";
import {unitDisplay} from "./unitDisplay";
import {TablePage} from "./TablePage";
import {formatHours} from "./formatHours";
import { Columns3 } from "lucide-react";
import { UnitProblemReview } from "./UnitProblemReview";
import { readScatterWorkers, timerWorkers } from "./scatterWorkers";
import { listProfiles } from "../../lib/install/api";
import { reviewedOpeningFlags } from "./documentationEvidence";
import { UnitReviewQueue } from "./UnitReviewQueue";

import { UnitPane } from "./UnitPane";

import { isGroupRowControl } from "./groupRowInteraction";

import { selectedUnitTotals } from "./unitSelection";




import { UnitGroupingControls } from "./UnitGroupingControls";

import { Fragment, useId, useState, useRef, useLayoutEffect, useMemo } from "react";

import { useQuery } from "@tanstack/react-query";

import { readUnitPhases } from "./unitPhaseEvidence";

import { listWorkUnits } from "../../lib/customWork/api";

import type { ActivityRow } from "./activityRows";

import { ActivityAccordion, RecordTable } from "./ActivityAccordion";

import { laborMetricContext } from "./laborMetrics";

import { readComparisonOpenings } from "./comparisonInventory";

import { readOpeningContexts, type ReviewOpening } from "./openingReviewContext";

import { enrichActivityRows, resolveReportingFacts } from "./reportingFacts";

import { reportOwner, reportQueryPolicy } from "./reportQueries";

import { unitOpeningProgress, type UnitPhase } from "./unitOpeningProgress";

function OpeningProgress({ opening, phases }: { opening: ReviewOpening; phases: UnitPhase[] }) {

 const id=useId(); const progress=unitOpeningProgress(opening,phases);

 const description=progress.stages.map(s=>`${s.label}: ${s.state}`).join("; ");

 return <span className="unit-stage-wrap"><button className="unit-stage-bar" type="button" popoverTarget={id} title={description} aria-label={`${progress.completed} of ${progress.expected} known required stages completed. ${description}`}>{progress.stages.map(s=><i key={s.label} data-state={s.state}/>)}</button><span id={id} popover="auto" className="unit-stage-popover">{progress.stages.map(s=><span key={s.label}>{s.label} · {s.state}</span>)}<small>{progress.completed}/{progress.expected} known required stages. Opening and phase evidence; independent of timer filters.</small>{opening.condition === "damaged" && <small>Damage recorded; blocking status is not established.</small>}</span></span>;

}

export function UnitFirstTable({ jobs, jobNames, rows, reviewRows, active }: { reviewRows?: ActivityRow[]; jobs: string[] | null; jobNames: Map<string,string>; rows: ActivityRow[]; active: boolean }) {


 const owner=reportOwner(); const selected=[...new Set(jobs ?? [])].sort(); const enabled=active && selected.length>0;

 const tableViewport=useRef<HTMLDivElement>(null);
 useLayoutEffect(()=>{
  const viewport=tableViewport.current,head=viewport?.querySelector("thead");if(!viewport||!head)return;
  let frame=0;
  const update=()=>{
   frame=0;
   const viewportRect=viewport.getBoundingClientRect();
   if(viewportRect.bottom<0 || viewportRect.top>window.innerHeight)return;
   const headRect=head.getBoundingClientRect();
   const headerHeight=headRect.height;
   const headerShift=Math.max(0,Math.min(-headRect.top,viewportRect.bottom-headerHeight-headRect.top));
   const headerBottom=headRect.top+headerShift+headerHeight;
   const changes:{row:HTMLElement;shift:number}[]=[];
   const bodies=[...viewport.querySelectorAll<HTMLTableSectionElement>(":scope > table > tbody")];
   const body=bodies.find(body=>{const rect=body.getBoundingClientRect();return rect.top<=headerBottom&&rect.bottom>headerBottom;});
   if(body){
    const rows=[...body.children] as HTMLElement[];
    const rects=rows.map(row=>row.getBoundingClientRect());
    let offset=headerBottom;
    rows.forEach((row,index)=>{
     if(row.dataset.open!=="true")return;
     const group=row.classList.contains("report-group-row"),depth=Number(row.dataset.depth??999);
     const boundary=rows.findIndex((next,i)=>i>index&&(next.classList.contains("report-group-row")&&Number(next.dataset.depth)<=depth||!group&&next.classList.contains("unit-inventory-row")));
     const end=boundary<0?body.getBoundingClientRect().bottom:rects[boundary].top;
     if(rects[index].top<=offset&&end>offset){
      changes.push({row,shift:Math.max(0,Math.min(offset-rects[index].top,end-rects[index].bottom))});
      offset+=rects[index].height;
     }
    });
   }
   // Read layout first, then apply offsets; horizontal scrolling stays native.
   viewport.style.setProperty("--unit-header-shift",`${headerShift}px`);
   for(const row of viewport.querySelectorAll<HTMLElement>("tr[data-pinned=true]")){
    if(!changes.some(change=>change.row===row)){delete row.dataset.pinned;row.style.removeProperty("--unit-pin-shift");}
   }
   for(const {row,shift} of changes){row.dataset.pinned="true";row.style.setProperty("--unit-pin-shift",`${shift}px`);}

  };
  const schedule=(event?:Event)=>{if(event?.target===viewport)return;if(!frame)frame=requestAnimationFrame(update);};
  update();const observer=new ResizeObserver(()=>schedule());observer.observe(head);
  document.addEventListener("scroll",schedule,true);window.addEventListener("resize",schedule);
  return()=>{observer.disconnect();document.removeEventListener("scroll",schedule,true);window.removeEventListener("resize",schedule);cancelAnimationFrame(frame);};
 });

 const [moreUnitColumns,setMoreUnitColumns]=useState(false);
 const [dimensionOrder,setDimensionOrder]=useState(["job","category","subtype","material","floor","person"]);
 const [sort,setSort]=useState<{key:string;descending:boolean}>({key:"recent",descending:true});
 const changeSort=(key:string)=>setSort(old=>{const descending=!["unit","job","type","operation"].includes(key);return old.key!==key?{key,descending}:old.descending===descending?{key,descending:!descending}:{key:"recent",descending:true};});
 const heading=(key:string,text:import("react").ReactNode)=><th scope="col" aria-sort={sort.key===key?(sort.descending?"descending":"ascending"):"none"}><button type="button" onClick={()=>changeSort(key)}>{key==="type"&&text==="Type / operation"?<span className="unit-type-heading"><span>Type</span><span>Operation</span></span>:text}{sort.key===key?(sort.descending?" \u2193":" \u2191"):""}</button></th>;
 const [problemReview,setProblemReview]=useState<{id:string;problems:string[];records:ActivityRow[]}|null>(null);
 const [detailId,setDetailId]=useState<string | null>(null);

 const [expanded,setExpanded]=useState<Set<string>>(new Set());

 const [groups,setGroups]=useState<string[]>(["job"]);

 const [filters,setFilters]=useState<Record<string,string[] | null>>({});

 const [closedGroups,setClosedGroups]=useState<Set<string>>(new Set());

 const inventory=useQuery({...reportQueryPolicy,queryKey:["dataReview",owner,"comparisonInventory",selected,"progress-v3-installed-dates"],queryFn:({signal})=>readComparisonOpenings(selected,signal),enabled});

 const units=useQuery({...reportQueryPolicy,queryKey:["dataReview",owner,"units",selected],queryFn:({signal})=>listWorkUnits(undefined,signal,selected),enabled});

 const ids=(inventory.data ?? []).map(o=>o.id).sort();

 const contexts=useQuery({...reportQueryPolicy,queryKey:["dataReview",owner,"openingReview",ids.join(","),"taxonomy-v4-catalog-dimensions"],queryFn:({signal})=>readOpeningContexts(ids,signal),enabled:enabled && ids.length>0});

 const phases=useQuery({...reportQueryPolicy,queryKey:["dataReview",owner,"unitPhases-v2",selected],queryFn:({signal})=>readUnitPhases(selected,signal),enabled});

 const workerActive=enabled&&(groups.includes("person")||!!filters.person?.length);
 const starts=rows.map(row=>Date.parse(row.started)).filter(Number.isFinite),ends=rows.map(row=>Date.parse(row.ended)).filter(Number.isFinite);
 const workerFrom=starts.length?Math.min(...starts):0,workerUntil=ends.length?Math.max(...ends)+1:0;
 const workers=useQuery({...reportQueryPolicy,queryKey:["dataReview",owner,"scatterWorkers",selected,workerFrom,workerUntil,rows.map(row=>[row.id,row.ended])],queryFn:({signal})=>readScatterWorkers(selected,rows,workerFrom,workerUntil,signal),enabled:workerActive&&rows.length>0});
 const people=useQuery({...reportQueryPolicy,queryKey:["dataReview",owner,"people"],queryFn:listProfiles,enabled:workerActive});
 const enriched=useMemo(()=>enrichActivityRows(rows,units.data ?? [],contexts.data ?? new Map()),[rows,units.data,contexts.data]);
 const reviewEnriched=useMemo(()=>reviewRows ? enrichActivityRows(reviewRows,units.data ?? [],contexts.data ?? new Map()) : enriched,[reviewRows,enriched,units.data,contexts.data]);

 const openings=useMemo(()=>[...(inventory.data ?? [])].sort((a,b)=>(jobNames.get(a.project_id) ?? "").localeCompare(jobNames.get(b.project_id) ?? "") || a.opening_code.localeCompare(b.opening_code,undefined,{numeric:true})),[inventory.data,jobNames]);

 const recordsByOpening=useMemo(()=>{
  const index=new Map<string,ActivityRow[]>();
  for(const row of enriched){
   if(row.scope!=="Specific" || !row.openingId || row.unitFacts?.linkConflict)continue;
   const key=JSON.stringify([row.jobId,row.openingId]);
   const bucket=index.get(key);if(bucket)bucket.push(row);else index.set(key,[row]);
  }
  return index;
 },[enriched]);
 const matching=(o: ReviewOpening)=>recordsByOpening.get(JSON.stringify([o.project_id,o.id])) ?? [];
 const phasesByOpening=useMemo(()=>{
  const index=new Map<string,UnitPhase[]>();
  for(const phase of phases.data ?? []){const bucket=index.get(phase.opening_id);if(bucket)bucket.push(phase);else index.set(phase.opening_id,[phase]);}
  return index;
 },[phases.data]);

 const matched=new Set(openings.flatMap(o=>matching(o).map(r=>r.id)));

 const unmatched=enriched.filter(r=>r.scope === "Specific" && !matched.has(r.id)); const jobLevel=enriched.filter(r=>r.scope !== "Specific");

 const records=(records: ActivityRow[], nested = false)=>records.length ? nested ? <RecordTable rows={records} unitOnly/> : <ActivityAccordion showTotal={!nested} recordGrouped={nested ? ["unit","job"] : []} rows={records} units={units.data} order={[]} metric="hours" context={laborMetricContext(records,units.data ?? [],"hours")}/> : <p>— No records —</p>;

 const factsByOpening=useMemo(()=>{
 const unitIndex=new Map<string,NonNullable<typeof units.data>>();
 for(const unit of units.data ?? []){const key=JSON.stringify([unit.project_id,unit.opening_id]);const bucket=unitIndex.get(key);if(bucket)bucket.push(unit);else unitIndex.set(key,[unit]);}
 return new Map(openings.map(o=>{

 const siblings=unitIndex.get(JSON.stringify([o.project_id,o.id])) ?? [];

 const facts=(siblings.length ? siblings : [undefined]).map(u=>resolveReportingFacts(u,contexts.data?.get(o.id),o.project_id));

 return [o.id,{fact:facts[0],areaDiscrepancy:facts.some(f=>f.dimensionConflict || f.sourceDimensionConflict || f.linkConflict) || new Set(facts.map(f=>f.area)).size>1,conflict:facts.some(f=>f.dimensionConflict || f.linkConflict) || new Set(facts.map(f=>f.area)).size>1}];

 }));
 },[openings,units.data,contexts.data]);

 const dimensions=dimensionOrder.map(key=>({key,label:({job:"Job",category:"Category",subtype:"Subtype",floor:"Floor",person:"Person",material:"Material",area:"Area"} as Record<string,string>)[key]}));

 const value=(o: ReviewOpening,key:string)=>{const f=factsByOpening.get(o.id)!.fact;return key === "material" ? f.materialLabel : key === "area" ? factsByOpening.get(o.id)!.conflict ? "Conflicting area" : f.area===null ? "Unknown area" : f.area<10 ? "Under 10 ft²" : f.area<25 ? "10–25 ft²" : f.area<50 ? "25–50 ft²" : f.area<100 ? "50–100 ft²" : "100+ ft²" : key === "job" ? o.project_id : key === "floor" ? f.floorLabel : key === "category" ? f.category ?? "Unknown category" : f.subtype ?? "Unknown subtype";};

 const personNames=new Map((people.data??[]).map(person=>[person.id,person.display_name]));
 const personValues=(o:ReviewOpening)=>{
  const records=matching(o);if(!records.length)return ["No attributed work"];
  if(workers.error)return ["Worker evidence unavailable"];
  if(workerActive&&workers.isPending)return ["Loading worker links"];
  return [...new Set(records.flatMap(row=>{const evidence=timerWorkers(row,workers.data?.events??[],workers.data?.crew??[]);return evidence.ids.length?evidence.ids:["Unknown worker"];}))];
 };
 const values=(o:ReviewOpening,key:string)=>key==="person"?personValues(o):[value(o,key)];
 const label=(key:string,v:string)=>v==="Conflicting category"?"Conflict":key === "job" ? jobNames.get(v) ?? v : key==="person" ? personNames.get(v)??v : v;

 const visible=openings.filter(o=>dimensions.every(d=>!filters[d.key]?.length || values(o,d.key).some(v=>filters[d.key]!.includes(v))));



 const snapshot=(o: ReviewOpening)=>{const children=matching(o); const f=factsByOpening.get(o.id)!;return {id:o.id,jobId:o.project_id,label:`${jobNames.get(o.project_id)} · ${o.opening_code}`,jobLabel:jobNames.get(o.project_id),category:f.fact.category,subtype:f.fact.subtype,floor:f.fact.floorLabel,area:f.conflict ? null : f.fact.area,seconds:children.reduce((s,r)=>s+r.seconds,0),people:[...new Set(children.map(r=>r.personId).filter(Boolean))],records:children.length};};

 const totals=(members: ReviewOpening[])=>selectedUnitTotals(members.map(snapshot));

 const showJob=!groups.includes("job");

 const showCategory=!groups.includes("category"),showSubtype=!groups.includes("subtype");



 const extraColumns=[...(moreUnitColumns ? ["configuration","material","system"] : [])].filter(key=>!groups.includes(key));
 const columnCount=5+Number(showJob)+Number(showCategory)+Number(showSubtype)+extraColumns.length;

 const toggleOpening=(id:string)=>setExpanded(old=>{const next=new Set(old);if(next.has(id))next.delete(id);else next.add(id);return next;});

 const toggleGroup=(id:string)=>setClosedGroups(old=>{const next=new Set(old);if(next.has(id))next.delete(id);else next.add(id);return next;});

 const renderUnit=(o: ReviewOpening)=>{

 const children=matching(o); const held=[...new Map((reviewRows??[]).filter(row=>row.openingId===o.id&&row.jobId===o.project_id&&row.reviewReason&&row.reviewKind!=="duplicate").map(row=>[row.id,row])).values()]; const {fact,conflict}=factsByOpening.get(o.id)!; const open=expanded.has(o.id);
 const problems=[...held.map(row=>`${row.activity}: ${row.reviewReason}`),...(!held.length?reviewedOpeningFlags(o.id):[]),...(conflict?["Conflicting unit measurements"]:fact.area===null?["Missing unit measurements"]:fact.dimensionsStatus==="unconfirmed catalog"?["Catalog-linked measurements need confirmation"]:[]),...(["category","subtype","configuration","system","material"] as const).filter(key=>fact.classification[key].status==="conflict").map(key=>`Conflicting ${key}: ${fact.classification[key].evidence.map(item=>[item.source,item.value,item.raw].filter(Boolean).join(" - ")).join("; ")}`)];

 return <Fragment key={o.id}><tr className="unit-inventory-row" data-open={open||undefined} style={{"--unit-pin-depth":groups.length} as import("react").CSSProperties} onClick={event=>{if(!isGroupRowControl(event.target))toggleOpening(o.id);}}><th scope="row"><span className="unit-row-identity"><button className="report-expand" type="button" aria-expanded={open} aria-label={`${open ? "Collapse" : "Expand"} unit ${o.opening_code} ${jobNames.get(o.project_id)}`} onClick={()=>toggleOpening(o.id)}>{open ? "▾" : "▸"}</button><button type="button" className="unit-reference-link" title={o.opening_code} aria-label={`View unit ${o.opening_code} ${jobNames.get(o.project_id)}`} onClick={()=>setDetailId(o.id)}>{o.opening_code.replace(/\s+/g," ").trim()}</button>{!groups.includes("floor")&&fact.floor!=="unknown"&&<small className="unit-inline-floor" title={fact.floorLabel}>{/^\d+$/.test(fact.floor)?`F${fact.floor}`:/^(?:floor|f)\s*\d+$/i.test(fact.floorLabel)?`F${fact.floorLabel.replace(/\D/g,"")}`:fact.floorLabel}</small>}</span></th><td className="unit-hours-value">{children.length ? formatHours(children.reduce((sum,r)=>sum+r.seconds,0)/3600) : "—"}<small className="unit-fact-source">{children.length}</small></td><td className="unit-area-value" title={[fact.dimensionSource,...fact.warnings].filter(Boolean).join(" · ")}>{conflict ? "Conflict" : fact.area==null?"--":`${fact.area.toLocaleString("en-US",{maximumFractionDigits:0})} ft²`}{problems.length>0&&<button type="button" className="unit-problem-count" aria-label={`Review ${problems.length} problems for unit ${o.opening_code} ${jobNames.get(o.project_id)}`} title={problems.join(" / ")} onClick={()=>setProblemReview({id:o.id,problems,records:[...held,...children.filter(row=>!held.some(record=>record.id===row.id))]})}>{problems.length}</button>}</td><td><OpeningProgress opening={o} phases={phasesByOpening.get(o.id) ?? []}/></td>{showJob && <td>{jobNames.get(o.project_id) ?? o.project_id}</td>}{showCategory&&<td>{unitDisplay(fact.category === "Conflicting category" ? "Conflict" : fact.category)}</td>}{showSubtype&&<td>{unitDisplay(fact.subtype)}</td>}{extraColumns.map(key=><td key={key} className="unit-extra-value"><span>{unitDisplay(key==="material"?fact.materialLabel:key==="configuration"?fact.configuration:fact.system)}</span></td>)}<td className="activity-column-action"/></tr>{open && <tr className="unit-inventory-details"><td colSpan={columnCount}>{records(children,true)}</td></tr>}</Fragment>;

 };

 const stats=useMemo(()=>new Map(openings.map(o=>{
  const fact=factsByOpening.get(o.id)!;
  const times=[...matching(o).flatMap(row=>[row.started,row.ended]),o.work_started_at,o.work_ended_at,...(phasesByOpening.get(o.id)??[]).flatMap(phase=>[phase.started_at,phase.submitted_at])].filter((date):date is string=>!!date).map(Date.parse).filter(Number.isFinite);
  return [o.id,{area:fact.conflict?null:fact.fact.area,seconds:matching(o).reduce((sum,row)=>sum+row.seconds,0),recent:times.length?Math.max(...times):null}];
 })),[openings,factsByOpening,recordsByOpening,phasesByOpening]);
 if(!selected.length) return <p>No jobs with recorded work in this date range.</p>;

 const error = [inventory, units, contexts, phases].find(query => query.isLoadingError)?.error;

 if(error) return <p role="alert">Unit inventory or progress could not load completely: {String(error)}</p>;

 if(inventory.isPending || units.isPending || phases.isPending || (ids.length>0 && contexts.isPending)) return <div role="status"><p>Loading units and activity records…</p><SkeletonList rows={4} /></div>;

 const sortValue=(members:ReviewOpening[],groupLabel:string):string|number|null=>{
  if(sort.key==="unit")return groupLabel;
  if(sort.key==="job")return jobNames.get(members[0]?.project_id)??"";
  if(sort.key==="type"||sort.key==="operation"){const f=factsByOpening.get(members[0]?.id)?.fact;return unitDisplay(sort.key==="type"?f?.category:f?.subtype);}
  if(sort.key==="progress")return members.filter(o=>o.status==="installed").length/members.length;
  if(sort.key==="hours")return members.reduce((sum,o)=>sum+stats.get(o.id)!.seconds,0);
  if(sort.key==="area"){const known=members.map(o=>stats.get(o.id)!.area).filter((v):v is number=>v!==null);return known.length?known.reduce((sum,v)=>sum+v,0):null;}
  const times=members.map(o=>stats.get(o.id)!.recent).filter((v):v is number=>v!==null);return times.length?Math.max(...times):null;
 };
 const compare=(a:ReviewOpening[],b:ReviewOpening[],aLabel:string,bLabel:string)=>{
  const av=sortValue(a,aLabel),bv=sortValue(b,bLabel);if(av===null&&bv!==null)return 1;if(bv===null&&av!==null)return -1;
  const order=typeof av==="string"&&typeof bv==="string"?av.localeCompare(bv,undefined,{numeric:true}):Number(av)-Number(bv);
  return (sort.descending?-order:order)||aLabel.localeCompare(bLabel,undefined,{numeric:true});
 };
 const renderGroups=(items: ReviewOpening[],depth=0,path=""): import("react").ReactNode=>{

 if(depth>=groups.length) {const leaves=[...items].sort((a,b)=>compare([a],[b],a.opening_code,b.opening_code)).map(renderUnit);return depth===0?<tbody>{leaves}</tbody>:leaves;}

 const key=groups[depth];const buckets=new Map<string,ReviewOpening[]>();

 for(const o of items)for(const v of values(o,key)){buckets.set(v,[...(buckets.get(v) ?? []),o]);}

 const Page=depth===0?TablePage:Fragment;
 return <Page key={path} {...(depth===0?{columns:columnCount,bodies:true}:{})}>{[...buckets].sort(([a,am],[b,bm])=>compare(am,bm,label(key,a),label(key,b))).map(([v,members])=>{

 const id=JSON.stringify([path,key,v]);const open=closedGroups.has(id);const total=totals(members);const areaDiscrepancy=members.some(o=>factsByOpening.get(o.id)!.areaDiscrepancy);

 const GroupContainer=depth===0?"tbody":Fragment;
 return <GroupContainer key={id}><tr data-open={open||undefined} style={{"--unit-pin-depth":depth} as import("react").CSSProperties} className="report-group-row" title={key==="person"?"Credited worker / reported contributor, not record author. Units can appear under multiple workers. Linked hours are unit timer totals, not this person’s payroll hours.":undefined} data-depth={depth} onClick={event=>{if(!isGroupRowControl(event.target))toggleGroup(id);}}><th colSpan={1} style={{paddingLeft:8+depth*12}}><button type="button" className="report-expand" aria-expanded={open} onClick={()=>toggleGroup(id)}>{open ? "▾" : "▸"} {label(key,v)} <small>{members.length}</small></button></th><td className="unit-hours-value">{formatHours(total.seconds/3600)}</td><td><span className={areaDiscrepancy?"unit-group-area-discrepancy":undefined} title={areaDiscrepancy?"One or more units have conflicting measurement sources":undefined}>{total.area.toLocaleString("en-US",{maximumFractionDigits:0})} ft²</span><span className="unit-area-issues" title="Openings with missing or conflicting measurements">{members.length>total.known ? ` ${members.length-total.known}*` : ""}</span></td><td title="Openings recorded installed; current inventory, independent of timer dates">{members.filter(o=>o.status==="installed").length}/{members.length}</td>{Array.from({length:Number(showJob)+Number(showCategory)+Number(showSubtype)+extraColumns.length},(_,i)=><td key={i}/>)}<td className="activity-column-action"/></tr>{open && renderGroups(members,depth+1,id)}</GroupContainer>;

 })}</Page>;

 };

 const detailOpening=openings.find(o=>o.id===detailId);

 return <section className="unit-inventory" aria-label="Unit inventory">{problemReview&&<UnitProblemReview job={jobNames.get(openings.find(o=>o.id===problemReview.id)?.project_id??"")??"Unknown job"} opening={openings.find(o=>o.id===problemReview.id)?.opening_code??problemReview.id} problems={problemReview.problems} records={problemReview.records} onClose={()=>setProblemReview(null)}/>}{detailOpening && <UnitPane opening={detailOpening} job={jobNames.get(detailOpening.project_id) ?? detailOpening.project_id} facts={factsByOpening.get(detailOpening.id)!.fact} conflict={factsByOpening.get(detailOpening.id)!.conflict} phases={phases.data ?? []} rows={matching(detailOpening)} onClose={()=>setDetailId(null)}>{records(matching(detailOpening),true)}</UnitPane>}<UnitGroupingControls dimensions={dimensions.map(d=>({...d,options:[...new Set(openings.flatMap(o=>values(o,d.key)))].sort((a,b)=>label(d.key,a).localeCompare(label(d.key,b),undefined,{numeric:true})).map(v=>({key:v,label:label(d.key,v)}))}))} groups={groups} filters={filters} onGroups={setGroups} onFilters={(key,next)=>setFilters(old=>({...old,[key]:next}))} onOrder={keys=>{setDimensionOrder(keys);setGroups(old=>keys.filter(key=>old.includes(key)));setClosedGroups(new Set());}}/><div ref={tableViewport} className="activity-table unit-inventory-scroll"><table><thead><tr>{heading("unit",<span className="unit-column-title">UNITS <small>{visible.length.toLocaleString("en-US")}</small></span>)}{heading("hours","Hours")}{heading("area","Area")}{heading("progress","Progress")}{showJob && heading("job","Job")}{showCategory&&heading("type","Type")}{showSubtype&&heading("operation","Operation")}{extraColumns.map(key=><th key={key}>{({size:"Size",configuration:"Configuration",material:"Material",system:"System"} as Record<string,string>)[key]}</th>)}<th className="activity-column-action"><button type="button" className="activity-table-columns" aria-label={moreUnitColumns?"Show fewer unit columns":"Show more unit columns"} aria-pressed={moreUnitColumns} onClick={()=>setMoreUnitColumns(value=>!value)}><Columns3 size={15}/></button></th></tr></thead>{renderGroups(visible)}{!visible.length && <tbody><tr><td colSpan={columnCount}>No units match these inventory filters.</td></tr></tbody>}</table></div><UnitReviewQueue rows={reviewEnriched} openings={openings.map(o=>{const f=factsByOpening.get(o.id)!.fact;return {id:o.id,jobId:o.project_id,label:o.opening_code,category:f.category,material:f.materialLabel,floor:f.floorLabel,width:factsByOpening.get(o.id)!.conflict ? null : f.width,height:factsByOpening.get(o.id)!.conflict ? null : f.height};})} jobNames={jobNames} onInspect={setDetailId}/><details><summary>Unmatched unit work · {unmatched.length} records</summary>{records(unmatched)}</details><p className="activity-unit-note">Job-level timers: {formatHours(jobLevel.reduce((s,r)=>s+r.seconds,0)/3600)} h across {jobLevel.length} records. Inspect through the job-level chart.</p></section>;

}
