import { useCallback, useLayoutEffect, useReducer, useRef, useSyncExternalStore } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { signInGeneration, signInMark, stillSignedInAs, subscribeSignedIn } from "../signedIn";
import { useViewAsRole } from "../viewAsRoleContext";
import type { UnitReviewSelectionSource } from "../workUnitReview/useUnitReviewCoordinator";
import { REVIEW_FRESH_MS } from "../workUnitReview/coordinator";
import { fetchActivityTotals } from "./api";
import type { TotalsView } from "./protocol";
import type { getRealProfile } from "../install/api";
let environment=0,hidden=false;
const listeners=new Set<()=>void>();
const changed=()=>{environment++;for(const listener of listeners)listener();};
const hide=()=>{hidden=true;changed();};const show=()=>{hidden=false;changed();};
const foreground=()=>!hidden&&document.visibilityState!=="hidden"&&navigator.onLine!==false;
function subscribeEnvironment(listener:()=>void){
 if(!listeners.size){hidden=document.visibilityState==="hidden";window.addEventListener("online",changed);window.addEventListener("offline",changed);window.addEventListener("pagehide",hide);window.addEventListener("pageshow",show);document.addEventListener("visibilitychange",changed);}
 listeners.add(listener);return()=>{listeners.delete(listener);if(!listeners.size){window.removeEventListener("online",changed);window.removeEventListener("offline",changed);window.removeEventListener("pagehide",hide);window.removeEventListener("pageshow",show);document.removeEventListener("visibilitychange",changed);}};
}
const environmentSnapshot=()=>environment;
const noop=()=>()=>{};const missing=()=>-1;const zero=()=>0;
interface Session {projectId:string;unitId:string|null;current:()=>boolean;startedAt:number;receivedAt:number;data:TotalsView|null;state:"loading"|"ready"|"unavailable";}
/** RAM-only totals. The shared parent lifetime invalidates BEFORE selection,
 * navigation, activity/dimension mutations and source refresh. Nothing sends,
 * cancels, stores or marks operational records as accepted. */
export function useActivityTotals(projectId:string,unitId:string|null,source:UnitReviewSelectionSource,admitted:()=>boolean,admissionRevision:string|number=""){
 const selected=useSyncExternalStore(source.subscribe,source.getSnapshot,source.getSnapshot);
 const preview=useViewAsRole().sensitiveLifetime;
 const previewRevision=useSyncExternalStore(preview?.subscribe??noop,preview?.getSnapshot??missing,missing);
 const auth=useSyncExternalStore(subscribeSignedIn,signInGeneration,zero);
 const network=useSyncExternalStore(subscribeEnvironment,environmentSnapshot,zero);
 const qc=useQueryClient();
 const profileStamp=useCallback(()=>{const s=qc.getQueryState(["myRealProfile"]);return JSON.stringify([s?.dataUpdateCount,s?.errorUpdateCount,s?.status,s?.fetchStatus,s?.isInvalidated]);},[qc]);
 const profileSubscribe=useCallback((listener:()=>void)=>qc.getQueryCache().subscribe(e=>{if((e.type==="updated"||e.type==="removed")&&JSON.stringify(e.query.queryKey)==='["myRealProfile"]')listener();}),[qc]);
 const profile=useSyncExternalStore(profileSubscribe,profileStamp,()=>"");
 const admission=useRef(admitted);useLayoutEffect(()=>{admission.current=admitted;});
 const active=useRef<Session|null>(null);const [,paint]=useReducer(n=>n+1,0);const [revision,refreshRevision]=useReducer(n=>n+1,0);
 useLayoutEffect(()=>{
  let alive=true;const login=signInMark();const profileData=qc.getQueryData<Awaited<ReturnType<typeof getRealProfile>>>(["myRealProfile"]);const role=profileData?.role;
  const current=()=>{try{const p=qc.getQueryState<Awaited<ReturnType<typeof getRealProfile>>>(["myRealProfile"]);return alive&&source.getSnapshot()===selected&&!!login.userId&&stillSignedInAs(login,login.userId)&&foreground()
   &&environmentSnapshot()===network&&!!preview&&preview.getSnapshot()===previewRevision&&!!role&&preview.admitted(login.userId,role)
   &&profileStamp()===profile&&p?.status==="success"&&p.fetchStatus==="idle"&&!p.isInvalidated&&p.data===profileData&&p.data?.id===login.userId&&!p.data.retired_at&&admission.current()
   &&(unitId===null||(selected.selection?.selectedJobId===projectId.toLowerCase()&&selected.selection.selectedUnitId===unitId.toLowerCase()&&selected.selection.admitted()));}catch{return false;}};
  active.current=null;
  if(!current()){paint();return()=>{alive=false;};}
  const session:Session={projectId,unitId,current,startedAt:performance.now(),receivedAt:0,data:null,state:"loading"};active.current=session;paint();
  const timer=window.setTimeout(()=>{if(active.current===session){session.data=null;session.state="unavailable";window.clearInterval(tick);paint();}},REVIEW_FRESH_MS+1);
  // One readonly read per admitted lifetime/check. No write or reconnect replay.
  void fetchActivityTotals(projectId,unitId,login,current).then(reply=>{
   if(!current()||active.current!==session||performance.now()-session.startedAt>=REVIEW_FRESH_MS)return;
   session.receivedAt=performance.now();session.data=reply.availability==="available"?reply.totals:null;
   session.state=session.data?"ready":"unavailable";paint();
  }).catch(()=>{if(current()&&active.current===session){session.state="unavailable";session.data=null;paint();}});
  // This timer changes only a labelled display estimate. Never raw SQL data.
  // Repaint even when admission just closed: render must erase the old answer
  // as soon as its parent source deadline passes, before this read's deadline.
  const tick=window.setInterval(()=>{if(active.current===session&&session.data)paint();},1000);
  return()=>{alive=false;session.data=null;window.clearTimeout(timer);window.clearInterval(tick);if(active.current===session)active.current=null;};
 },[projectId,unitId,source,selected,preview,previewRevision,auth,network,qc,profile,profileStamp,revision,admissionRevision]);
 const session=active.current;
 const valid=!!session&&session.projectId===projectId&&session.unitId===unitId&&session.current()&&performance.now()-session.startedAt<REVIEW_FRESH_MS;
 return {state:valid?session!.state:"held" as const,data:valid?session!.data:null,
  liveElapsedMicros:valid&&session!.data?BigInt(Math.max(0,Math.floor((performance.now()-session!.receivedAt)*1000))):0n,
  refresh:()=>{try{if(session&&active.current===session&&session.current())refreshRevision();}catch{/* Held surface remains hidden. */}}};
}
