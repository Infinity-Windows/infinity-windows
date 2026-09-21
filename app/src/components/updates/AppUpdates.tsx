import { useQuery } from '@tanstack/react-query';
import { useState, useSyncExternalStore } from 'react';
import { Link } from 'react-router-dom';
import { Sparkles, Wrench, ArrowUpRight, Check } from 'lucide-react';
import { getRealProfile } from '../../lib/install/api';
import { useEffectiveRole } from '../../lib/useEffectiveRole';
import { useLanguage, useT } from '../../lib/i18n';
import { listAppUpdates, markUpdatesRead, readUpdateReceipt, receiptIds, safeUpdateLink, subscribeUpdateReceipts, visibleUpdates } from '../../lib/appUpdates';
import './updates.css';

/** In-flow, never modal: updates must not block clocking in or interrupt capture. */
export function AppUpdates({history=false}:{history?:boolean}) {
  const t=useT();const {lang}=useLanguage();
  const {effectiveRole,realRole,isLoading,isPreviewing}=useEffectiveRole();
  const me=useQuery({queryKey:['myRealProfile'],queryFn:getRealProfile});
  const userId=me.data?.id ?? '';
  const notes=useQuery({queryKey:['appUpdates',userId,realRole],queryFn:listAppUpdates,
    enabled:Boolean(userId)&&!isLoading,staleTime:0,refetchOnMount:'always',refetchOnWindowFocus:'always',retry:1});
  const raw=useSyncExternalStore(subscribeUpdateReceipts,()=>readUpdateReceipt(userId),()=> '[]');
  const [previewDismissed,setPreviewDismissed]=useState('');
  if (isLoading||!userId) return null;
  const seen=new Set(receiptIds(raw));
  const eligible=visibleUpdates(notes.data??[],effectiveRole);
  const updates=history?eligible:eligible.filter(n=>!seen.has(n.id));
  const signature=`${userId}:${effectiveRole}:${updates.map(n=>n.id).join(',')}`;
  if (!history&&(!updates.length||previewDismissed===signature)) return null;
  const dismiss=()=>{if(isPreviewing)setPreviewDismissed(signature);else markUpdatesRead(userId,updates.map(n=>n.id));};
  return <section className={`app-updates ${history?'app-updates-history':''}`} aria-label={t(history?'updates.history':'updates.title')}>
    <header className="app-updates-heading"><span className="app-updates-emblem"><Sparkles size={22} aria-hidden/></span><div><h2>{t(history?'updates.history':'updates.title')}</h2><p>{t('updates.subtitle')}</p></div></header>
    {notes.isError?<p role="status">{t('updates.unavailable')}</p>:notes.isPending?<p>{t('updates.loading')}</p>:updates.length===0?<p>{t('updates.empty')}</p>:<>
      <ul className="app-updates-list">{updates.map(note=>{const href=safeUpdateLink(note.href);return <li key={note.id}>
        <div className="app-update-meta">{note.kind==='fix'?<Wrench size={14} aria-hidden/>:<Sparkles size={14} aria-hidden/>}<span>{t(note.kind==='fix'?'updates.fix':'updates.improvement')}</span><time dateTime={note.published_on}>{new Intl.DateTimeFormat(lang==='es'?'es-US':'en-US',{month:'short',day:'numeric',year:'numeric',timeZone:'UTC'}).format(new Date(`${note.published_on}T12:00:00Z`))}</time></div>
        <details open={history || undefined}><summary><h3>{lang==='es'?note.title_es:note.title_en}</h3></summary><p>{lang==='es'?note.body_es:note.body_en}</p>
        {href&&<Link className="app-update-link" to={href}>{t('updates.open')}<ArrowUpRight size={16} aria-hidden/></Link>}</details>
      </li>;})}</ul>
      {!history&&<footer><button className="primary" onClick={dismiss}><Check size={18} aria-hidden/>{t('updates.dismiss')}</button><Link to="/settings">{t('updates.historyLink')}</Link></footer>}
    </>}
  </section>;
}
