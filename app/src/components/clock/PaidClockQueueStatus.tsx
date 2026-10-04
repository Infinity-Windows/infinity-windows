import { useEffect, useRef, useState } from "react";
import { useT } from "../../lib/i18n";
import "../../lib/i18n/paidClockCatalog";
import { recoverPaidClockRequest } from "../../lib/paidClock/coordinator";
import { usePaidClockRecords } from "../../lib/paidClock/usePaidClockRecords";
import { signInMark, stillSignedInAs } from "../../lib/signedIn";
import { useConnection } from "../../lib/offline/useWeakSignal";
import { tapTimeLabel } from "../../lib/clockQueueView";
import { ClockQueueStatus } from "./ClockQueueStatus";
import type { QueuedClockAction, RefusedClockAction } from "../../lib/clockQueueView";
import "./PaidClockQueueStatus.css";

/** Both queues are shown together, but isolated punches never become legacy
 * pending TimeShift references or payroll state. Mount only at cutover. */
export function PaidClockQueueStatus({ profileId, legacyPending=null, legacyRefused=[], includeHistory=false }: {
  profileId:string|null; legacyPending?:QueuedClockAction|null; legacyRefused?:readonly RefusedClockAction[]; includeHistory?:boolean;
}) {
  const t=useT(), {online}=useConnection(), records=usePaidClockRecords(profileId);
  const [busy,setBusy]=useState<string|null>(null), [feedback,setFeedback]=useState<"held"|"failed"|null>(null);
  const lifetime=useRef(0), active=useRef(false), serial=useRef(false);
  const mark=signInMark(), identity=`${profileId ?? "none"}:${mark.userId ?? "none"}:${mark.generation}`;
  const liveIdentity=useRef(identity); liveIdentity.current=identity;
  useEffect(()=>{const activeRef=active, lifetimeRef=lifetime;
    activeRef.current=true;lifetimeRef.current++;setBusy(null);setFeedback(null);serial.current=false;
    return ()=>{activeRef.current=false;lifetimeRef.current++;};},[identity]);
  async function recover(clientId:string, action:"check"|"retry_original") {
    if (serial.current || !profileId || !online || records.state!=="ready") return;
    const login=signInMark(), epoch=lifetime.current, authoredIdentity=identity;
    if (!stillSignedInAs(login,profileId)) return;
    const current=()=>active.current && lifetime.current===epoch && liveIdentity.current===authoredIdentity && stillSignedInAs(login,profileId);
    serial.current=true;setBusy(clientId);setFeedback(null);
    try {
      const result=await recoverPaidClockRequest(clientId,login,action);
      if (!current()) return;
      setFeedback(result.kind==="held"?"held":null);
      await records.refresh();
    } catch { if (current()) setFeedback("failed"); }
    finally { if (current()) {serial.current=false;setBusy(null);} }
  }
  const ownVisible=records.state==="ready"?records.rows.filter(row=>includeHistory || row.delivery.status!=="acknowledged")
    .sort((a,b)=>Date.parse(a.intent.tappedAt)-Date.parse(b.intent.tappedAt) || a.clientId.localeCompare(b.clientId)):[];
  if(records.state==="blocked") return null;
  return <div className="paid-clock-queue">
    <ClockQueueStatus pending={legacyPending} refused={legacyRefused}/>
    {records.state!=="ready" || ownVisible.length>0 ? <section aria-label={t("paidClock.title")}>
      <h3>{t("paidClock.title")}</h3>
      {records.state==="loading" && <p role="status">{t("paidClock.loading")}</p>}
      {records.state==="unavailable" && <><p role="alert">{t("paidClock.unavailable")}</p><button type="button" onClick={()=>void records.refresh()}>{t("paidClock.refresh")}</button></>}
      {ownVisible.map(row=>{
        const status=row.delivery.status;
        const label=status==="queued"?"queued":status==="acknowledged"?"acknowledged":status==="attention"?"review":"unknown";
        const retry=(status==="queued" || status==="sending" || status==="uncertain") && !row.delivery.receipt;
        return <article key={row.clientId} data-clock-request={row.clientId}>
          <p><strong>{t(`paidClock.${row.intent.action}`)}</strong>{" · "}<time dateTime={row.intent.tappedAt}>{tapTimeLabel(row.intent.tappedAt)}</time></p>
          <p role="status">{t(`paidClock.${label}`)}</p>
          {status!=="acknowledged" && <div className="paid-clock-actions">
            <button type="button" disabled={!!busy || !online} onClick={()=>void recover(row.clientId,"check")}>{t("paidClock.check")}</button>
            {retry && <button type="button" disabled={!!busy || !online} onClick={()=>void recover(row.clientId,"retry_original")}>{t("paidClock.resend")}</button>}
          </div>}
          {retry && <p className="paid-clock-help">{t("paidClock.resendHelp")}</p>}
        </article>;
      })}
      {ownVisible.length>0 && !online && <p>{t("paidClock.offline")}</p>}
      {includeHistory && ownVisible.some(row=>row.delivery.status==="acknowledged") && <p className="paid-clock-help">{t("paidClock.historyHelp")}</p>}
      {busy && <p role="status">{t("paidClock.working")}</p>}
      {!busy && feedback && <p role="status">{t(`paidClock.${feedback}`)}</p>}
    </section>:null}
  </div>;
}
