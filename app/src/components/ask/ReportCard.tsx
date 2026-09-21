import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Download, FileText, Clock3 } from 'lucide-react';
import type { AskArtifact, TimeReportArtifact } from '../../../../supabase/functions/_shared/askReporting.ts';
import { askReportCsv, askReportPdf } from '../../lib/askReportExports';
import { JOB_STAGES } from '../../lib/jobExecution';
import { useT } from '../../lib/i18n';
import './reports.css';
function download(bytes: BlobPart, mime: string, name: string) {
  const url=URL.createObjectURL(new Blob([bytes],{type:mime}));
  const a=document.createElement('a');a.href=url;a.download=name;a.click();
  setTimeout(()=>URL.revokeObjectURL(url),10000);
}
export function ReportCard({artifact}:{artifact:AskArtifact}) {
  const t=useT();
  const [busy,setBusy]=useState(false);const [error,setError]=useState('');
  if(artifact.kind==='job_summary') {
    const done=artifact.stages.filter(s=>s.completed).length;
    return <section className="ask-report" aria-label={t('ask.report.jobSummary')}>
      <div className="ask-report-heading"><FileText size={20}/><div><span className="ask-report-kicker">{t('ask.report.jobSummary')}</span><h2>{artifact.project.job_code} · {artifact.project.name}</h2></div></div>
      <div className="ask-report-metrics"><div><strong>{artifact.labor.recordedHours.toFixed(2)}h</strong><span>{t('ask.report.recorded')}</span></div><div><strong>{artifact.targets?.projected_hours != null ? `${artifact.targets.projected_hours}h` : '—'}</strong><span>{t('ask.report.projected')}</span></div><div><strong>{artifact.targets?.goal_hours != null ? `${artifact.targets.goal_hours}h` : '—'}</strong><span>{t('ask.report.goal')}</span></div></div>
      <p>{artifact.project.status} · {done} / {JOB_STAGES.length} {t('ask.report.stages')}</p>
      <div className="ask-report-stages">{JOB_STAGES.map(([key,label])=><span key={key} data-complete={artifact.stages.some(s=>s.stage_key===key&&s.completed)}>{artifact.stages.some(s=>s.stage_key===key&&s.completed)?'✓ ':''}{label}</span>)}</div>
      {artifact.logs.length>0&&<details><summary>{t('ask.report.recentLogs')}</summary>{artifact.logs.map(log=><div className="ask-report-log" key={log.id}><strong>{log.log_date} · {log.headline}</strong><p>{log.notes}</p></div>)}</details>}
      {artifact.unavailable.map(note=><p className="muted" key={note}>{note}</p>)}
      <Link className="btn" to={`/projects/${artifact.project.id}`}>{t('ask.report.openJob')}</Link>
      <p className="ask-report-stamp">{t('ask.report.snapshot')} {new Date(artifact.generatedAt).toLocaleString()}</p>
    </section>;
  }
  const r:TimeReportArtifact=artifact;
  const file=`Forge-Hours-${r.scope.from??'all-time'}-${r.scope.through??''}-${r.id.slice(0,8)}`;
  async function pdf() {
    setBusy(true);setError('');
    try{const bytes=await askReportPdf(r);download(new Uint8Array(bytes).buffer,'application/pdf',file+'.pdf');}
    catch{setError(t('ask.report.exportError'));}finally{setBusy(false);}
  }
  const available=r.totals.recordedCount>0;
  return <section className="ask-report" aria-label={t('ask.report.title')}>
    <div className="ask-report-heading"><Clock3 size={20}/><div><span className="ask-report-kicker">{t('ask.report.title')}</span><h2>{r.scope.from?`${r.scope.from} — ${r.scope.through}`:t('timereport.allTime')}</h2></div></div>
    <p className="muted">{r.scope.timeZone} · {r.accessScope==='self'?t('ask.report.self'):t('ask.report.team')}</p>
    <div className="ask-report-metrics"><div><strong>{r.totals.recordedHours.toFixed(2)}h</strong><span>{t('ask.report.recorded')}</span></div><div><strong>{r.totals.runningHours.toFixed(2)}h</strong><span>{t('ask.report.running')}</span></div><div><strong>{r.totals.unassignedHours.toFixed(2)}h</strong><span>{t('ask.report.unassigned')}</span></div></div>
    <p>{t('ask.report.counts',{people:r.people.length,entries:r.totals.recordedCount})}</p>
    <p className="muted">{t('ask.report.scopePeople')} {r.scope.profileIds?r.people.map(p=>p.name).join(', ')||t('ask.report.noRows'):t('ask.report.allPeople')}</p>
    <p className="muted">{t('ask.report.scopeJobs')} {r.scope.projectIds?r.jobs.map(j=>j.name).join(', ')||t('ask.report.noRows'):t('ask.report.allJobs')}</p>
    {(r.totals.unresolvedCount>0||r.totals.unapprovedCount>0||r.totals.suspectCount>0)&&<p className="ask-report-warning">{t('ask.report.review',{unresolved:r.totals.unresolvedCount,unapproved:r.totals.unapprovedCount,suspect:r.totals.suspectCount})}</p>}
    <details open={r.groups.length<=12}><summary>{t('ask.report.breakdown')} ({r.groups.length})</summary><div className="ask-report-groups">{r.groups.map(g=><div key={g.id}><span>{g.label}</span><strong>{g.recordedHours.toFixed(2)}h{g.runningHours>0&&<small> + {g.runningHours.toFixed(2)}h {t('ask.report.running')}</small>}</strong></div>)}</div></details>
    <p className="muted">{t('ask.report.exportHelp')}</p>
    <div className="ask-report-actions"><button className="primary" disabled={!available||busy} onClick={()=>download(askReportCsv(r),'text/csv;charset=utf-8',file+'.csv')}><Download size={16}/>{t('ask.report.csv')}</button><button disabled={!available||busy} onClick={()=>void pdf()}><FileText size={16}/>{busy?t('ask.report.preparing'):t('ask.report.pdf')}</button></div>
    {error&&<p role="alert">{error}</p>}
    <p className="ask-report-stamp">{t('ask.report.snapshot')} {new Date(r.generatedAt).toLocaleString()} · {r.id.slice(0,8)}</p>
  </section>;
}
