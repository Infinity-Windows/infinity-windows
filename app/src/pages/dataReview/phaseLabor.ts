import { supabase } from "../../lib/supabase";
import type { HistoricalSession } from "./historicalLabor";
export async function readPhaseLabor(jobs:string[],from:number,until:number,signal?:AbortSignal):Promise<HistoricalSession[]> {
 const rows:HistoricalSession[]=[]; let expected:number|null=null;
 for(let offset=0;;) {
  let query=supabase.from("opening_phases").select("id,opening_id,kind,status,started_at,submitted_at,started_by,submitted_by,minutes,opening:project_openings!inner(id,project_id,opening_code,label)",{count:"exact"}).in("opening.project_id",jobs).is("opening.removed_at",null).eq("kind","flashing").eq("status","submitted").not("submitted_at","is",null).order("id").range(offset,offset+499);
  if(Number.isFinite(from))query=query.gt("submitted_at",new Date(from).toISOString());
  if(Number.isFinite(until))query=query.lt("started_at",new Date(until).toISOString());
  if(signal)query=query.abortSignal(signal);
  const {data,error,count}=await query; if(error)throw error;
  if(count===null || expected!==null && expected!==count)throw new Error("Phase labor changed while loading");expected=count;
  const page=(data??[]) as unknown as {id:string;opening_id:string;started_at:string;submitted_at:string;started_by:string|null;submitted_by:string|null;minutes:number|null;opening:HistoricalSession["opening"]}[];
  for(const phase of page)rows.push({id:phase.id,sourceTable:"opening_phases",savedMinutes:phase.minutes,reviewReason:!phase.started_by || phase.started_by!==phase.submitted_by ? "Phase worker attribution needs review" : phase.minutes==null || !Number.isFinite(phase.minutes) || phase.minutes<0 || !Number.isFinite(Date.parse(phase.started_at)) || !Number.isFinite(Date.parse(phase.submitted_at)) || Date.parse(phase.submitted_at)<=Date.parse(phase.started_at) || phase.minutes*60000>Date.parse(phase.submitted_at)-Date.parse(phase.started_at)+1000 ? "Phase duration missing or invalid" : undefined,opening_id:phase.opening_id,profile_id:phase.started_by??"",role:"flashing",is_rework:false,started_at:phase.started_at,ended_at:phase.submitted_at,end_reason:"submitted",opening:phase.opening});
  offset+=page.length;if(offset===count)break;if(!page.length)throw new Error("Incomplete phase labor");
 }
 if(new Set(rows.map(row=>row.id)).size!==rows.length)throw new Error("Repeated phase evidence");
 return rows;
}
