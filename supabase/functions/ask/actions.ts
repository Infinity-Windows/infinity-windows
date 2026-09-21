import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1';
import { parseNewJob, type ActionArtifact } from '../_shared/askActions.ts';
import { completeReportRows } from '../_shared/askReporting.ts';
export function actionExecutor(client:SupabaseClient, rank:number, artifacts:{length:number;push(...items:ActionArtifact[]):number}) {
 return async (name:string,input:unknown):Promise<{content:string;is_error?:boolean}>=>{
  try {
   if(name!=='prepare_new_job')throw new Error('This action is not available.');
   if(artifacts.length>=4)throw new Error('Finish the existing proposals before creating more.');
   const details=parseNewJob(input,rank);
   const jobs=await completeReportRows<{id:string;name:string;job_code:string}>(offset=>client.from('projects').select('id,name,job_code',{count:'exact'}).is('deleted_at',null).order('id').range(offset,offset+499));
   const words=details.name.toLocaleLowerCase().split(/\s+/).filter(x=>x.length>2);
   const similarJobs=jobs.filter(j=>j.job_code.toUpperCase()===details.jobCode||j.name.toLocaleLowerCase()===details.name.toLocaleLowerCase()||words.filter(w=>j.name.toLocaleLowerCase().includes(w)).length>=Math.min(2,words.length||99)).slice(0,10);
   const artifact:ActionArtifact={kind:'job_proposal',id:crypto.randomUUID(),details,similarJobs};artifacts.push(artifact);
   return{content:JSON.stringify({...artifact,instruction:'This is a preview, not a saved job. The user can review similar jobs and press Create job.'})};
  }catch(e){return{content:e instanceof Error?e.message:'Could not prepare this action.',is_error:true};}
 };
}
