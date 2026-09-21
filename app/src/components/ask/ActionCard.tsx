import { refreshWorkflow } from "../../lib/workflow/refresh";
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { BriefcaseBusiness, CalendarCheck, Check } from 'lucide-react';
import type { ActionArtifact } from '../../../../supabase/functions/_shared/askActions.ts';
import { supabase } from '../../lib/supabase';
import { formatApiError } from '../../lib/errors';
import { queryClient } from '../../lib/queryClient';
import { useT } from '../../lib/i18n';
import { useEffectiveRole } from '../../lib/useEffectiveRole';
import './reports.css';
interface ScheduleReview {requestId:string;reviewToken:string;published:boolean;issues:string[];assignments:Array<{id:string;job:string;startDate:string;endDate:string;status:string;startTime?:string|null;endTime?:string|null;note?:string|null;crew:Array<{id:string;name:string;role:string}>}>}
export function ActionCard({artifact}:{artifact:ActionArtifact}) {
 const t=useT();const {effectiveRole}=useEffectiveRole();
 const manager=['supervisor','owner','admin','big_boss'].includes(effectiveRole??'');
 const lead=manager||['foreman','lead'].includes(effectiveRole??'');
 const [busy,setBusy]=useState(false),[error,setError]=useState('');
 const [saved,setSaved]=useState<{projectId:string}|null>(null),[review,setReview]=useState<ScheduleReview|null>(null),[published,setPublished]=useState(false);
 async function run(fn:()=>Promise<void>){setBusy(true);setError('');try{await fn();}catch(e){setError(formatApiError(e));}finally{setBusy(false);}}
 async function create(){
  if(artifact.kind!=='job_proposal')return;
  const {data,error}=await supabase.rpc('ai_create_job',{p_request:artifact.id,p_details:artifact.details});if(error)throw error;
  if(!data?.projectId)throw new Error(t('ask.action.unverified'));
  setSaved(data);await queryClient.invalidateQueries({queryKey:['projects']});
 }
 async function refresh(){const {data,error}=await supabase.rpc('ai_review_schedule',{p_request:artifact.id});if(error)throw error;if(!data?.reviewToken)throw new Error(t('ask.action.unverified'));setReview(data);setPublished(data.published);}
 async function publish(){
  if(!review)return;
  const {data,error}=await supabase.rpc('ai_publish_schedule',{p_request:artifact.id,p_review_token:review.reviewToken});if(error)throw error;
  if(!data?.published)throw new Error(t('ask.action.unverified'));
  setPublished(true);refreshWorkflow(queryClient);
 }
 return <section className="ask-report" aria-label={t(artifact.kind==='job_proposal'?'ask.action.job':'ask.action.schedule')}>
  <div className="ask-report-heading">{artifact.kind==='job_proposal'?<BriefcaseBusiness/>:<CalendarCheck/>}<h2>{t(artifact.kind==='job_proposal'?'ask.action.job':'ask.action.schedule')}</h2></div>
  {artifact.kind==='job_proposal'?<>
   <h3>{artifact.details.jobCode} · {artifact.details.name}</h3>
   {saved?<p role="status"><Check size={18}/>{t('ask.action.saved')} <Link to={`/projects/${saved.projectId}`}>{t('ask.report.openJob')}</Link></p>:<>
    <dl className="ask-action-details">{Object.entries(artifact.details).filter(([key,value])=>!['name','jobCode'].includes(key)&&value!==null).map(([key,value])=><div key={key}><dt>{t(`ask.action.field.${key}` as Parameters<typeof t>[0])}</dt><dd>{String(value)}</dd></div>)}</dl>
    {artifact.similarJobs.length>0&&<div className="ask-report-warning"><strong>{t('ask.action.similar')}</strong>{artifact.similarJobs.map(j=><p key={j.id}><Link to={`/projects/${j.id}`}>{j.job_code} · {j.name}</Link></p>)}</div>}
    <p className="muted">{t('ask.action.notReady')}</p>
    <button disabled={busy||!lead} onClick={()=>void run(create)}>{busy?t('ask.report.preparing'):t('ask.action.create')}</button>
   </>}
  </>:<>
   <p>{t('ask.action.draftCount',{n:artifact.assignmentCount})}</p>
   <p className="muted">{t('ask.action.reviewHelp')}</p>
   {review?.assignments.map(a=><div className="ask-report-log" key={a.id}><strong>{a.job}</strong><p>{a.startDate} — {a.endDate}{a.startTime&&` · ${a.startTime}${a.endTime?` – ${a.endTime}`:""}`}</p>{a.note&&<p>{a.note}</p>}<p>{a.crew.map(p=>`${p.name} (${p.role})`).join(', ')}</p></div>)}
   {review?.issues.map((issue,i)=><p className="ask-report-warning" key={i}>{issue}</p>)}
   {published?<p role="status"><Check size={18}/>{t('ask.action.published')}</p>:<div className="ask-report-actions"><button disabled={busy||!manager} onClick={()=>void run(refresh)}>{t('ask.action.review')}</button>{review&&<button className="primary" disabled={busy||!manager||review.issues.length>0} onClick={()=>void run(publish)}>{t('ask.action.publish')}</button>}</div>}
   <p><Link to="/scheduling">{t('ask.action.openSchedule')}</Link></p>
  </>}
  {error&&<p role="alert">{error}</p>}
 </section>;
}
