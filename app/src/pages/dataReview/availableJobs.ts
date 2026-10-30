import { supabase } from "../../lib/supabase";

/** Lightweight job discovery only. Full inventory/labor reads follow the resolved
 * jobs; discovery is independent of the job filter and activity-source toggle. */
export async function readAvailableJobs(from:number, until:number, signal?:AbortSignal):Promise<string[]> {
 if(from>=until)return [];
 const sources=[
  {table:"time_shifts",select:"id,project_id",end:"clock_out_at"},
  {table:"custom_work_sessions",select:"id,project_id,unit:custom_work_units(project_id)",end:"ended_at"},
  {table:"unit_sessions",select:"id,opening:project_openings!inner(project_id)",end:"ended_at"},
  {table:"opening_phases",select:"id,opening:project_openings!inner(project_id)",end:"submitted_at"},
 ];
 const sets=await Promise.all(sources.map(async source=>{
  const jobs=new Set<string>();let expected:number|null=null;const seen=new Set<string>();
  for(let offset=0;offset<1000000;){
   let q=supabase.from(source.table).select(source.select,{count:"exact"}).order("id").range(offset,offset+499);
   const start=source.table==="time_shifts" ? "clock_in_at" : "started_at";
   if(Number.isFinite(until))q=q.lt(start,new Date(until).toISOString());
   if(Number.isFinite(from))q=q.or(`${source.end}.is.null,${source.end}.gt.${new Date(from).toISOString()}`);
   if(source.table==="time_shifts")q=q.is("voided_at",null).neq("status","voided");
   if(signal)q=q.abortSignal(signal);
   const {data,error,count}=await q;if(error)throw error;
   if(count===null || expected!==null && expected!==count)throw new Error("Available jobs changed while loading. Refresh.");expected=count;
   const page=(data??[]) as unknown as {id:string;project_id?:string;opening?:{project_id:string};unit?:{project_id:string}}[];
   for(const row of page){seen.add(row.id);const job=row.project_id ?? row.opening?.project_id ?? row.unit?.project_id;if(job)jobs.add(job);}
   offset+=page.length;if(offset===count){if(seen.size!==count)throw new Error("Repeated discovery records");return [...jobs];}
   if(!page.length)throw new Error("Available jobs did not load completely");
  }
  throw new Error("Choose a shorter date range");
 }));
 return [...new Set(sets.flat())].sort();
}
export function includedJobs(available:readonly string[], selected:readonly string[]|null){
 return [...new Set(available)].filter(id=>selected===null || selected.length===0 || selected.includes(id)).sort();
}
