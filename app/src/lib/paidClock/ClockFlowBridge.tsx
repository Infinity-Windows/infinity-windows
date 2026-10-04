import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { signedInUserId, signInGeneration, signInMark, stillSignedInAs, subscribeSignedIn } from "../signedIn";
import type { TimeShift } from "../timeclock";
import type { QueuedClockAction } from "../clockQueueView";
import { useViewAsRole } from "../viewAsRoleContext";
import { usePaidClockRecords } from "./usePaidClockRecords";
import { useOwnPaidClockCurrent } from "./useOwnPaidClockCurrent";
import { usePaidClockCapability } from "./usePaidClockCapability";
import { fetchPaidClockCapability } from "./capability";
import { authorNativeClockSafety, authorNativeClockStart, projectClockFlow, type NativeClockFlow } from "./flow";
import { checkSavedPaidClockReceipts } from "./recovery";
import { paidSetupIntent } from "./coordinator";
import { trackPaidClockOperation } from "./reloadGuard";
import {getCurrentLoginCommittedHead} from "./storage";
import "../i18n/paidClockCatalog";

// Release authorization is deliberate and remains off until the full backend,
// entry routing, peer and installed-app acceptance gates have passed.
export const PAID_SETUP_RELEASE_AUTHORIZED=false;
export default function ClockFlowBridge({profileId,legacyReady,legacyShift,legacyPending,onFlow,releaseAuthorized=PAID_SETUP_RELEASE_AUTHORIZED}:{
  profileId:string|null;legacyReady:boolean;legacyShift:TimeShift|null;legacyPending:QueuedClockAction|null;
  onFlow:(flow:NativeClockFlow|null)=>void;releaseAuthorized?:boolean;
}) {
  const owner=useSyncExternalStore(subscribeSignedIn,signedInUserId,()=>null);
  const generation=useSyncExternalStore(subscribeSignedIn,signInGeneration,()=>0);
  const preview=useViewAsRole();
  const allowed=!!owner && owner===profileId && !preview.previewPerson && !preview.previewRole;
  const ownProfile=allowed?profileId:null;
  const records=usePaidClockRecords(ownProfile);
  const paid=useOwnPaidClockCurrent(ownProfile,releaseAuthorized || records.rows.length>0 || records.state!=="ready");
  const capability=usePaidClockCapability(ownProfile,releaseAuthorized);
  const latest=useRef({records,paid,capability});latest.current={records,paid,capability};
  const startInFlight=useRef<string|null>(null);
  const refresh=useCallback(()=>{
    void latest.current.records.refresh();void latest.current.paid.refresh();void latest.current.capability.refresh();
  },[]);
  const {route,canStartDay,canRequestSafety}=projectClockFlow({releaseAuthorized,backendReady:capability.state==="ready" && capability.value?.mode==="active" &&
    capability.value.canDispatchExistingSetup && capability.value.canReadOwnReceipts && capability.value.canDispatchPayrollSafety,
    nativeRead:records.state,records:records.rows,currentRead:paid.state,current:paid.value,legacyReady,legacyShift,legacyPending});
  const flow=useMemo<NativeClockFlow>(()=>({ownerId:allowed?owner:null,loginGeneration:generation,
    route,canStartDay,canRequestSafety,nativeRead:records.state,records:records.rows,currentRead:paid.state,current:paid.value,refresh,
    setupReason:capability.value?.setupReason,
    pendingSafetyAction:allowed && paid.value?.kind==="open"?getCurrentLoginCommittedHead(signInMark(),paid.value.shift.id)?.action ?? null:null,
    authorStart:async punch=>{
      const original=paidSetupIntent(punch);
      const login=signInMark();
      // Freeze the supplied tap before capability awaits; never carry it to
      // a legacy fallback if admission or storage later becomes unavailable.
      if(!allowed || !canStartDay || route!=="isolated" || !owner || login.generation!==generation || !stillSignedInAs(login,owner))
        return {kind:"held",clientId:original.clientId,reason:"basis_unavailable"};
      const startIdentity=`${owner}:${generation}`;
      if(startInFlight.current===startIdentity)return {kind:"held",clientId:original.clientId,reason:"basis_unavailable"};
      startInFlight.current=startIdentity;
      return trackPaidClockOperation(async()=>{try {
        const fresh=await fetchPaidClockCapability(login);
        if(!fresh.canAuthorSetup || !fresh.canDispatchExistingSetup || !fresh.canReadOwnReceipts || !fresh.canDispatchPayrollSafety ||
          !owner || !stillSignedInAs(login,owner))return {kind:"held",clientId:original.clientId,reason:"basis_unavailable"};
        return await authorNativeClockStart(original,login,true);
      } catch {return {kind:"held",clientId:original.clientId,reason:"basis_unavailable"};}
      finally {if(startInFlight.current===startIdentity)startInFlight.current=null;refresh();}});
    },
    authorSafety:async intent=>{
      const login=signInMark();
      if(!allowed || !owner || login.generation!==generation || !stillSignedInAs(login,owner))
        return {kind:"held",clientId:intent.clientId,reason:"account_changed"};
      // An unactivated Classic account must never enter native recovery merely
      // because its server read won the race against the device inventory.
      // Previously admitted native history may still close its own paid shift.
      if(!releaseAuthorized && (latest.current.records.state!=="ready" || latest.current.records.rows.length===0))
        return {kind:"held",clientId:intent.clientId,reason:"basis_unavailable"};
      try {return await authorNativeClockSafety(intent,login,paid.value);}
      finally {refresh();}
    },
  }),[allowed,owner,generation,route,canStartDay,canRequestSafety,records.state,records.rows,paid.state,paid.value,capability.value?.setupReason,refresh,releaseAuthorized]);
  useEffect(()=>{onFlow(flow);},[flow,onFlow]);
  useEffect(()=>()=>onFlow(null),[onFlow]);
  useEffect(()=>{
    if(!allowed)return;
    let active=true,busy=false;
    const login={userId:owner,generation};
    const run=async()=>{
      if(!active || busy || !owner || !stillSignedInAs(login,owner))return;
      busy=true;
      try {await checkSavedPaidClockReceipts(login);}
      finally {busy=false;if(active && stillSignedInAs(login,owner))refresh();}
    };
    const wake=()=>{void run();};
    const visible=()=>{if(document.visibilityState==="visible")wake();};
    // Queue change notifications deliberately do not trigger another pass.
    wake();window.addEventListener("online",wake);window.addEventListener("focus",wake);
    document.addEventListener("visibilitychange",visible);
    return()=>{active=false;window.removeEventListener("online",wake);window.removeEventListener("focus",wake);document.removeEventListener("visibilitychange",visible);};
  },[allowed,owner,generation,refresh]);
  return null;
}
