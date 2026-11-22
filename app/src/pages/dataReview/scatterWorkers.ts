import {supabase} from "../../lib/supabase";
import {reportingActivity} from "./activityLabels";
import type {ActivityRow} from "./activityRows";
export interface Credit {id:string;project_opening_id:string;installer_id:string|null;credited_to:string|null;created_at:string;opening:{project_id:string}}
export interface CrewCredit {id:string;project_id:string;unit_id:string;work_date:string;stage:string;outcome:string;filed_by:string|null;unit:{opening_id:string|null}|null;people:{profile_id:string;voided_at:string|null}[]}
export interface WorkerEvidence {ids:string[];basis:string;refs:string[]}
const instant=(s:string)=>`${Date.parse(s)}:${(s.match(/\.(\d+)/)?.[1]??"").slice(3).padEnd(6,"0")}`;
export function timerWorkers(row:ActivityRow,events:Credit[],crew:CrewCredit[]):WorkerEvidence {
 const credits=row.sourceTable==="unit_sessions"&&reportingActivity(row.activity)==="Install" ? events.filter(e=>e.project_opening_id===row.openingId&&e.opening.project_id===row.jobId&&e.installer_id===row.personId&&instant(e.created_at)===instant(row.ended)) : [];
 if(credits.length){const ids=[...new Set(credits.map(e=>e.credited_to??e.installer_id).filter((id):id is string=>!!id))];return {ids:ids.length===1?ids:[],basis:ids.length===1?"Installation credit at session finish; duration remains owned by the original timer":"Conflicting installation credits",refs:credits.map(e=>`install_events:${e.id}`)};}
 // A late documentation timestamp cannot supply the crew's actual work date.
 if(row.reviewReason?.includes("After-the-fact"))return {ids:[],basis:"Actual work date/worker unconfirmed; recorded after the fact",refs:[]};
 if(!Number.isFinite(Date.parse(row.started)))return {ids:[],basis:"Worker unknown; work date unavailable",refs:[]};
 const date=new Intl.DateTimeFormat("en-CA",{timeZone:"America/Denver",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date(row.started));
 const matching=crew.filter(c=>c.project_id===row.jobId&&(c.unit_id===row.unitId||!!row.openingId&&c.unit?.opening_id===row.openingId)&&c.work_date===date&&reportingActivity(c.stage)===reportingActivity(row.activity)&&(c.outcome==="partial"||c.outcome==="finished"));
 const ids=[...new Set(matching.flatMap(c=>c.people.filter(p=>!p.voided_at).map(p=>p.profile_id)))];
 return {ids,basis:ids.length?"Reported crew on this unit, activity and work date; timer hours are not split among contributors":"Worker unknown; timer account alone does not establish who performed the work",refs:matching.map(c=>`crew_work_records:${c.id}`)};
}
interface PageRead {abortSignal(signal:AbortSignal):PromiseLike<{data:unknown[]|null;error:{message:string}|null;count:number|null}>}
async function pages<T>(make:(offset:number)=>PageRead,signal:AbortSignal):Promise<T[]> {
 const rows:T[]=[];let expected:number|null=null;
 for(let offset=0;offset<100000;){signal.throwIfAborted();const {data,error,count}=await make(offset).abortSignal(signal);if(error)throw error;if(count===null||(expected!==null&&count!==expected))throw new Error("Worker evidence changed while loading");expected=count;const page=(data??[]) as T[];rows.push(...page);offset+=page.length;if(offset===count){if(new Set(rows.map(r=>(r as {id:string}).id)).size!==count)throw new Error("Incomplete worker evidence");return rows;}if(!page.length)break;}
 throw new Error("Narrow worker evidence date range");
}
export async function readScatterWorkers(jobs:string[],timers:ActivityRow[],from:number,until:number,signal:AbortSignal){
 const events:Credit[]=[],crew:CrewCredit[]=[];
 if(!jobs.length||!timers.length)return {events,crew};
 const openings=[...new Set(timers.filter(t=>t.sourceTable==="unit_sessions"&&t.openingId).map(t=>t.openingId!))];
 const ends=timers.map(t=>Date.parse(t.ended)).filter(Number.isFinite);
 for(let i=0;i<openings.length&&ends.length;i+=100)events.push(...await pages<Credit>(offset=>supabase.from("install_events").select("id,project_opening_id,installer_id,credited_to,created_at,opening:project_openings!inner(project_id)",{count:"exact"}).in("project_opening_id",openings.slice(i,i+100)).in("opening.project_id",jobs).is("voided_at",null).gte("created_at",new Date(Math.min(...ends)).toISOString()).lte("created_at",new Date(Math.max(...ends)+1).toISOString()).order("id").range(offset,offset+499),signal));
 const local=(n:number)=>new Intl.DateTimeFormat("en-CA",{timeZone:"America/Denver",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date(n));
 for(let i=0;i<jobs.length;i+=100)crew.push(...await pages<CrewCredit>(offset=>{let q=supabase.from("crew_work_records").select("id,project_id,unit_id,work_date,stage,outcome,filed_by,unit:custom_work_units(opening_id),people:crew_work_record_people(profile_id,voided_at)",{count:"exact"}).in("project_id",jobs.slice(i,i+100)).order("id").range(offset,offset+499);if(Number.isFinite(from))q=q.gte("work_date",local(from));if(Number.isFinite(until))q=q.lte("work_date",local(until-1));return q;},signal));
 return {events,crew};
}
