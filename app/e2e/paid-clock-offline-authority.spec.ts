import { expect, test, type Page } from "@playwright/test";
import { FIXTURE_AUTH_KEY, FIXTURE_SESSION, TEST_USER } from "./support/supabaseFixtures";
import { json } from "./support/specHelpers";
declare global { interface Window { paidOffline: {
 auth: typeof import("../src/lib/signedIn"); store: typeof import("../src/lib/paidClock/storage");
 current: typeof import("../src/lib/paidClock/current"); coordinator: typeof import("../src/lib/paidClock/coordinator");
}; } }
const OWNER=TEST_USER.id,SHIFT="00000000-0000-4000-8000-000000000801",DEVICE="00000000-0000-4000-8000-000000000802";
const ownShift=(client:string|null=null)=>({id:SHIFT,profile_id:OWNER,project_id:null,cost_code_id:null,client_id:client,
 clock_in_at:"2026-10-04T08:00:00Z",clock_out_at:null,break_seconds:0,break_started_at:null,break_type:null,
 injured:null,time_confirmed:null,status:"open",created_at:"2026-10-04T08:00:00Z",note:null,injury_note:null,
 job_mode:null,review_reason:null,projects:null,cost_codes:null});
async function open(page:Page){
 await page.addInitScript(({key,session})=>localStorage.setItem(key,JSON.stringify(session)),{key:FIXTURE_AUTH_KEY,session:FIXTURE_SESSION});
 await page.route("**/*",route=>new URL(route.request().url()).hostname==="localhost"?route.continue():route.abort());
 await page.route("**/paid-clock-offline-fixture",route=>route.fulfill({status:200,contentType:"text/html",body:"<!doctype html><title>Native offline authoring</title>"}));
 await page.goto("/paid-clock-offline-fixture");
 await page.evaluate(async owner=>{
  // @ts-expect-error Vite serves actual modules.
  const auth=await import("/src/lib/signedIn.ts");auth.rememberSignedIn({user:{id:owner}});
  // @ts-expect-error Vite serves actual modules.
  const store=await import("/src/lib/paidClock/storage.ts");
  // @ts-expect-error Vite serves actual modules.
  const current=await import("/src/lib/paidClock/current.ts");
  // @ts-expect-error Vite serves actual modules.
  const coordinator=await import("/src/lib/paidClock/coordinator.ts");
  window.paidOffline={auth,store,current,coordinator};
 },OWNER);
}
async function observe(page:Page){await page.evaluate(async()=>{const {auth,current}=window.paidOffline;await current.fetchOwnPaidClockCurrent(auth.signInMark());});}
test("offline observed shift saves immutable break/end/out natively without RPC",async({page,context})=>{
 await open(page);let rpc=0;await page.route("**/rest/v1/time_shifts?**",route=>json(route,ownShift(),null));
 await page.route("**/rest/v1/rpc/**",route=>{rpc++;return route.abort();});await observe(page);await context.setOffline(true);
 const result=await page.evaluate(async shift=>{
  const {auth,store,coordinator}=window.paidOffline;
  const stamp={tappedAt:"2026-10-04T09:00:00.123456Z",clockCheckedAt:null,clockSkewMs:null},ref={kind:"shift" as const,id:shift};
  const start={...stamp,clientId:crypto.randomUUID(),action:"break_start" as const,shiftRef:ref,breakType:"rest" as const};
  const end={...stamp,clientId:crypto.randomUUID(),action:"break_end" as const,shiftRef:ref};
  const out={...stamp,clientId:crypto.randomUUID(),action:"clock_out" as const,shiftRef:ref,photo:null,injured:false,timeConfirmed:false,breakSeconds:0,lat:null,lng:null,injuryNote:null};
  const results=[await coordinator.submitPaidClockIntent(auth.signInMark(),start,null),await coordinator.submitPaidClockIntent(auth.signInMark(),end,start.clientId),await coordinator.submitPaidClockIntent(auth.signInMark(),out,end.clientId)];
  const head=store.getCurrentLoginCommittedHead(auth.signInMark(),shift);
  return {results,rows:await store.readPaidClockRecords(auth.signInMark()),intents:[start,end,out],head,
   valid:store.isCurrentLoginCommittedHead(head,auth.signInMark(),shift),copyValid:store.isCurrentLoginCommittedHead({...head},auth.signInMark(),shift)};
 },SHIFT);
 expect(result.results.every(r=>r.kind==="saved"&&r.dispatch.kind==="held"&&r.dispatch.reason==="offline")).toBe(true);
 const rows=[...result.rows].sort((a,b)=>a.sequence-b.sequence);expect(rows.map(r=>r.intent)).toEqual(result.intents);
 expect(rows.map(r=>r.sequence)).toEqual([0,1,2]);expect(rows.map(r=>r.predecessorClientId)).toEqual([null,result.intents[0].clientId,result.intents[1].clientId]);
 expect(new Set(rows.map(r=>r.storageGeneration)).size).toBe(1);expect(rpc).toBe(0);
 expect(result.head).toEqual({clientId:result.intents[2].clientId,action:"clock_out",origin:{kind:"shift",id:SHIFT}});expect(result.valid).toBe(true);expect(result.copyValid).toBe(false);
});
test("current-login native commit admits lineage; reload and duplicate history do not",async({page,context})=>{
 await open(page);
 const original=await page.evaluate(async device=>{
  const {auth,store}=window.paidOffline;
  const intent={action:"clock_in" as const,clientId:crypto.randomUUID(),tappedAt:"2026-10-04T08:00:00Z",clockCheckedAt:null,clockSkewMs:null,projectId:null,costCodeId:null,photo:null,lat:null,lng:null,note:null,mode:null,setupVersion:1 as const};
  await store.appendPaidClockIntent(auth.signInMark(),device,intent,null);return intent;
 },DEVICE);await context.setOffline(true);
 const started=await page.evaluate(async original=>{
  const {auth,coordinator}=window.paidOffline;
  const intent={action:"break_start" as const,clientId:crypto.randomUUID(),shiftRef:{kind:"clock_command" as const,id:original.clientId},breakType:"rest" as const,tappedAt:original.tappedAt,clockCheckedAt:null,clockSkewMs:null};
  return {intent,result:await coordinator.submitPaidClockIntent(auth.signInMark(),intent,original.clientId)};
 },original);expect(started.result.kind).toBe("saved");
 await context.setOffline(false);await open(page);await context.setOffline(true);
 const after=await page.evaluate(async({original,start,device})=>{
  const {auth,store,coordinator}=window.paidOffline;
  await store.appendPaidClockIntent(auth.signInMark(),device,original,null);
  const before=await store.readPaidClockRecords(auth.signInMark());
  const result=await coordinator.submitPaidClockIntent(auth.signInMark(),{action:"break_end",clientId:crypto.randomUUID(),shiftRef:start.shiftRef,tappedAt:start.tappedAt,clockCheckedAt:null,clockSkewMs:null},start.clientId);
  return {before,after:await store.readPaidClockRecords(auth.signInMark()),result,head:store.getCurrentLoginCommittedHead(auth.signInMark(),"00000000-0000-4000-8000-000000000801")};
 },{original,start:started.intent,device:DEVICE});
 expect(after.result).toMatchObject({kind:"held",reason:"storage_unavailable"});expect(after.after).toEqual(after.before);expect(after.head).toBeNull();
});
test("source invalidation and ABA abort native pending writes; copied targets refuse",async({page})=>{
 await open(page);await page.route("**/rest/v1/time_shifts?**",route=>json(route,ownShift(),null));await observe(page);
 const result=await page.evaluate(async({shift,device,owner})=>{
  const {auth,store,current}=window.paidOffline;
  const intent=()=>({tappedAt:"2026-10-04T09:00:00Z",clockCheckedAt:null,clockSkewMs:null,clientId:crypto.randomUUID(),action:"break_start" as const,shiftRef:{kind:"shift" as const,id:shift},breakType:"rest" as const});
  let copied=false;try{await store.appendPendingPaidClockIntent(auth.signInMark(),device,intent(),null,{...current.readObservedClockTarget(auth.signInMark(),shift)!});}catch{copied=true;}
  const outcomes=[];
  for(const mutation of ["source","auth"]){
   await current.fetchOwnPaidClockCurrent(auth.signInMark());const login=auth.signInMark(),target=current.readObservedClockTarget(login,shift),add=IDBObjectStore.prototype.add;
   let injected=false,aborted=false;
   IDBObjectStore.prototype.add=function(...args:Parameters<typeof add>){const request=add.apply(this,args);
    if(this.name==="requests"&&!injected){injected=true;if(mutation==="source")current.invalidateObservedClockTarget(login,shift);else{auth.rememberSignedIn(null);auth.rememberSignedIn({user:{id:owner}});}}return request;};
   try{await store.appendPendingPaidClockIntent(login,device,intent(),null,target);}catch{aborted=true;}finally{IDBObjectStore.prototype.add=add;}
   outcomes.push({injected,aborted,rows:await store.readPaidClockRecords(auth.signInMark())});
  }return {copied,outcomes};
 },{shift:SHIFT,device:DEVICE,owner:OWNER});
 expect(result.copied).toBe(true);expect(result.outcomes).toEqual([{injected:true,aborted:true,rows:[]},{injected:true,aborted:true,rows:[]}]);
});
test("unknown older break survives independent observed offline out",async({page,context})=>{
 await open(page);await page.route("**/rest/v1/time_shifts?**",route=>json(route,ownShift(),null));await observe(page);
 const before=await page.evaluate(async({shift,device})=>{
  const {auth,store,current}=window.paidOffline,login=auth.signInMark();
  const intent={action:"break_start" as const,clientId:crypto.randomUUID(),shiftRef:{kind:"shift" as const,id:shift},breakType:"rest" as const,tappedAt:"2026-10-04T09:00:00Z",clockCheckedAt:null,clockSkewMs:null};
  const old=await store.appendPendingPaidClockIntent(login,device,intent,null,current.readObservedClockTarget(login,shift));
  return store.updatePaidClockDelivery(login,old.clientId,null,r=>({...r.delivery,status:"uncertain",everAttempted:true,everUncertain:true,attemptToken:crypto.randomUUID()}));
 },{shift:SHIFT,device:DEVICE});await context.setOffline(true);
 const result=await page.evaluate(async shift=>{
  const {auth,store,coordinator}=window.paidOffline;
  const request={action:"clock_out" as const,clientId:crypto.randomUUID(),shiftRef:{kind:"shift" as const,id:shift},tappedAt:"2026-10-04T09:02:00Z",clockCheckedAt:null,clockSkewMs:null,photo:null,injured:false,timeConfirmed:false,breakSeconds:0,lat:null,lng:null,injuryNote:null};
  return {result:await coordinator.submitPaidClockIntent(auth.signInMark(),request,null),rows:await store.readPaidClockRecords(auth.signInMark())};
 },SHIFT);
 expect(result.result.kind).toBe("saved");expect(result.rows.find(r=>r.clientId===before.clientId)).toEqual(before);
 const out=result.rows.find(r=>r.clientId!==before.clientId)!;expect(out.predecessorClientId).toBeNull();expect(out.sequence).toBe(0);expect(out.storageGeneration).not.toBe(before.storageGeneration);
});
test("fresh exact clock-command binding re-admits history; different binding and source removal refuse",async({page})=>{
 await open(page);
 const original=await page.evaluate(async device=>{
  const {auth,store,coordinator}=window.paidOffline;
  const intent=coordinator.paidSetupIntent({clientId:crypto.randomUUID(),tappedAt:"2026-10-04T08:00:00Z",clockCheckedAt:null,clockSkewMs:null});
  await store.appendPaidClockIntent(auth.signInMark(),device,intent,null);return intent;
 },DEVICE);
 // A fresh read replaces the RAM lineage; only an exact current source binding
 // can now readmit that saved generation. UUID similarity/history is not enough.
 let returned=ownShift("00000000-0000-4000-8000-000000000899");
 await page.route("**/rest/v1/time_shifts?**",route=>json(route,returned,null));await observe(page);
 const attempt=()=>page.evaluate(async({original,device})=>{
  const {auth,store}=window.paidOffline;
  try{return await store.appendPendingPaidClockIntent(auth.signInMark(),device,{action:"break_start",clientId:crypto.randomUUID(),shiftRef:{kind:"clock_command",id:original.clientId},breakType:"rest",tappedAt:original.tappedAt,clockCheckedAt:null,clockSkewMs:null},original.clientId);}catch{return null;}
 },{original,device:DEVICE});
 expect(await attempt()).toBeNull();returned=ownShift(original.clientId);await observe(page);
 const accepted=await attempt();expect(accepted?.predecessorClientId).toBe(original.clientId);
 const head=await page.evaluate(shift=>{const {auth,store}=window.paidOffline;const value=store.getCurrentLoginCommittedHead(auth.signInMark(),shift);return {value,valid:store.isCurrentLoginCommittedHead(value,auth.signInMark(),shift),frozen:Object.isFrozen(value?.origin)};},SHIFT);
 expect(head).toEqual({value:{clientId:accepted!.clientId,action:"break_start",origin:{kind:"clock_command",id:original.clientId}},valid:true,frozen:true});
 const removed=await page.evaluate(async({shift,device,start})=>{
  const {auth,store,current}=window.paidOffline;
  current.invalidateObservedClockTarget(auth.signInMark(),shift);
  try{await store.appendPendingPaidClockIntent(auth.signInMark(),device,{action:"break_end",clientId:crypto.randomUUID(),shiftRef:start.origin,tappedAt:start.intent.tappedAt,clockCheckedAt:null,clockSkewMs:null},start.clientId);return false;}catch{return true;}
 },{shift:SHIFT,device:DEVICE,start:accepted!});expect(removed).toBe(true);
});
test("offline current tabs deduplicate the same independent original without dispatch",async({page,context})=>{
 await open(page);const other=await context.newPage();await open(other);
 for(const tab of [page,other]){await tab.route("**/rest/v1/time_shifts?**",route=>json(route,ownShift(),null));await observe(tab);}
 await context.setOffline(true);
 const append=(tab:Page)=>tab.evaluate(async shift=>{
  const {auth,coordinator}=window.paidOffline;
  return coordinator.submitPaidClockIntent(auth.signInMark(),{action:"clock_out",clientId:crypto.randomUUID(),shiftRef:{kind:"shift",id:shift},tappedAt:new Date().toISOString(),clockCheckedAt:null,clockSkewMs:null,photo:null,injured:false,timeConfirmed:false,breakSeconds:0,lat:null,lng:null,injuryNote:null},null);
 },SHIFT);
 const results=await Promise.all([append(page),append(other)]);
 expect(results.every(r=>r.kind==="saved"&&r.dispatch.kind==="held"&&r.dispatch.reason==="offline")).toBe(true);
 expect(results[0].clientId).toBe(results[1].clientId);
 const heads=await Promise.all([page,other].map(tab=>tab.evaluate(shift=>{const {auth,store}=window.paidOffline;return store.getCurrentLoginCommittedHead(auth.signInMark(),shift);},SHIFT)));
 expect(heads.filter(Boolean)).toHaveLength(1);expect(heads.find(Boolean)?.clientId).toBe(results[0].clientId);
 const rows=await page.evaluate(async()=>{const {auth,store}=window.paidOffline;return store.readPaidClockRecords(auth.signInMark());});expect(rows).toHaveLength(1);
});
test("removed source invalidates a locally committed clock lineage before any target has been observed",async({page})=>{
 await open(page);
 const refused=await page.evaluate(async({device,shift})=>{
  const {auth,store,current,coordinator}=window.paidOffline;
  const original=coordinator.paidSetupIntent({clientId:crypto.randomUUID(),tappedAt:"2026-10-04T08:00:00Z",clockCheckedAt:null,clockSkewMs:null});
  await store.appendPaidClockIntent(auth.signInMark(),device,original,null);
  current.invalidateObservedClockTarget(auth.signInMark(),shift);
  try{await store.appendPendingPaidClockIntent(auth.signInMark(),device,{action:"break_start",clientId:crypto.randomUUID(),shiftRef:{kind:"clock_command",id:original.clientId},breakType:"rest",tappedAt:original.tappedAt,clockCheckedAt:null,clockSkewMs:null},original.clientId);return false;}catch{return true;}
 },{device:DEVICE,shift:SHIFT});expect(refused).toBe(true);
});
