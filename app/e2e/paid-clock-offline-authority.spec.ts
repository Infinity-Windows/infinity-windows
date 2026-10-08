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
 await load(page);
}
async function load(page:Page){
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
const startCapability={protocolVersion:1,asOf:"2026-10-04T08:00:00Z",clockProtocol:"setup_v1",receiptProtocol:"retained_v1",
 mode:"active",canAuthorSetup:true,setupReason:null,canDispatchExistingSetup:true,canReadOwnReceipts:true,canDispatchPayrollSafety:true};
const originalStamp={tappedAt:"2026-10-04T08:00:00.123456-06:00",clockCheckedAt:"2026-10-04T13:59:00.000001Z",clockSkewMs:17};
async function reserveStart(page:Page){return page.evaluate(async stamp=>{
 const {auth,coordinator}=window.paidOffline,intent=coordinator.paidSetupIntent({...stamp,clientId:crypto.randomUUID()});
 return {intent,result:await coordinator.reservePaidClockStart(auth.signInMark(),intent)};
},originalStamp);}
async function readRows(page:Page){return page.evaluate(()=>{const {auth,store}=window.paidOffline;return store.readPaidClockRecords(auth.signInMark());});}
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

test("first offline Clock In reserves one owner-wide original across tabs without granting safety authority",async({page,context})=>{
 await open(page);const other=await context.newPage();await open(other);
 let remote=0;for(const tab of [page,other])await tab.route("**/rest/v1/**",route=>{remote++;return route.abort();});
 await context.setOffline(true);
 const attempts=await Promise.all([reserveStart(page),reserveStart(other)]);
 expect(attempts.every(a=>a.result.kind==="reserved")).toBe(true);
 const winners=attempts.filter(a=>a.result.kind==="reserved"&&a.result.created);expect(winners).toHaveLength(1);
 const original=winners[0].intent;
 expect(attempts.map(a=>a.result.clientId)).toEqual([original.clientId,original.clientId]);
 const rows=await readRows(page);expect(rows).toHaveLength(1);expect(rows[0].intent).toEqual(original);
 expect(rows[0].delivery).toMatchObject({status:"queued",everAttempted:false,receipt:null,resolvedShiftId:null});
 for(const tab of [page,other]){
  const result=await tab.evaluate(async original=>{
   const {auth,coordinator,store,current}=window.paidOffline,login=auth.signInMark();
   const safety=await coordinator.submitPaidClockIntent(login,{action:"break_start",clientId:crypto.randomUUID(),
    shiftRef:{kind:"clock_command",id:original.clientId},breakType:"rest",tappedAt:original.tappedAt,clockCheckedAt:null,clockSkewMs:null},original.clientId);
   return {safety,observed:current.readLastObservedPaidClock(login),head:store.getCurrentLoginCommittedHead(login,"00000000-0000-4000-8000-000000000801")};
  },original);
  expect(result).toEqual({safety:expect.objectContaining({kind:"held",reason:"storage_unavailable"}),observed:null,head:null});
 }
 expect(await readRows(page)).toEqual(rows);expect(remote).toBe(0);
});

test("held readiness cannot lose the committed original on reload and reconnect is receipt-only",async({page})=>{
 await open(page);const saved=await reserveStart(page);expect(saved.result.kind).toBe("reserved");
 const before=await readRows(page);let capabilityReads=0,currentReads=0,clockWrites=0,receiptReads=0,release!:()=>void;
 const barrier=new Promise<void>(resolve=>{release=resolve;});
 await page.route("**/rest/v1/time_shifts?**",route=>{currentReads++;return json(route,null,null);});
 await page.route("**/rest/v1/rpc/*",async route=>{
  const rpc=new URL(route.request().url()).pathname.split("/").at(-1);
  if(rpc==="work_activity_clock_receipt"){receiptReads++;return json(route,{protocolVersion:1,availability:"unavailable",receipt:null},null);}
  if(rpc==="work_activity_clock_capability"){
   capabilityReads++;await barrier;
   try{await json(route,startCapability,null);}catch{/* Old document intentionally destroyed while its read was held. */}return;
  }
  clockWrites++;return route.abort();
 });
 const pending=page.evaluate(async id=>{const {auth,coordinator}=window.paidOffline;return coordinator.deliverReservedPaidClockStart(id,auth.signInMark());},saved.intent.clientId).catch(()=>null);
 await expect.poll(()=>capabilityReads).toBe(1);
 expect(await readRows(page)).toEqual(before);expect(currentReads).toBe(0);expect(clockWrites).toBe(0);
 await page.reload();release();await pending;await load(page);
 expect(await readRows(page)).toEqual(before);
 await page.evaluate(async()=>{
  // @ts-expect-error Vite browser module.
  const recovery=await import("/src/lib/paidClock/recovery.ts");
  window.dispatchEvent(new Event("online"));await recovery.checkSavedPaidClockReceipts(window.paidOffline.auth.signInMark());
 });
 expect(receiptReads).toBe(2);expect(capabilityReads).toBe(1);expect(currentReads).toBe(0);expect(clockWrites).toBe(0);
 expect(await readRows(page)).toEqual(before);
});

test("native first-tap reservation rolls back requests, head and device metadata on ABA or storage failure",async({page})=>{
 await open(page);
 const result=await page.evaluate(async({owner,stamp})=>{
  const {auth,store,coordinator}=window.paidOffline,outcomes=[];
  await store.readPaidClockRecords(auth.signInMark());
  for(const failure of ["aba","quota"]){
   const add=IDBObjectStore.prototype.add;let injected=false;
   IDBObjectStore.prototype.add=function(...args:Parameters<typeof add>){
    if(this.name==="requests"&&!injected){injected=true;
     if(failure==="quota")throw new DOMException("Synthetic quota boundary","QuotaExceededError");
     const request=add.apply(this,args);auth.rememberSignedIn(null);auth.rememberSignedIn({user:{id:owner}});return request;
    }return add.apply(this,args);
   };
   let saved;
   try{saved=await coordinator.reservePaidClockStart(auth.signInMark(),coordinator.paidSetupIntent({...stamp,clientId:crypto.randomUUID()}));}
   finally{IDBObjectStore.prototype.add=add;}
   const db=await new Promise<IDBDatabase>(resolve=>{const r=indexedDB.open(store.PAID_CLOCK_DB,1);r.onsuccess=()=>resolve(r.result);});
   const tx=db.transaction("heads"),heads=await new Promise<unknown[]>(resolve=>{const r=tx.objectStore("heads").getAll();r.onsuccess=()=>resolve(r.result);});db.close();
   outcomes.push({failure,injected,saved,heads,rows:await store.readPaidClockRecords(auth.signInMark())});
  }return outcomes;
 },{owner:OWNER,stamp:originalStamp});
 expect(result).toEqual([
  {failure:"aba",injected:true,saved:expect.objectContaining({kind:"held",reason:"account_changed"}),heads:[],rows:[]},
  {failure:"quota",injected:true,saved:expect.objectContaining({kind:"held",reason:"storage_unavailable"}),heads:[],rows:[]},
 ]);
});

test("older unknown start wins reservation after restart without changing evidence or consulting corrupt identity",async({page})=>{
 await open(page);const saved=await reserveStart(page);
 const before=await page.evaluate(async id=>{
  const {auth,store}=window.paidOffline;
  await store.updatePaidClockDelivery(auth.signInMark(),id,null,row=>({...row.delivery,status:"uncertain",everAttempted:true,everUncertain:true,attemptToken:crypto.randomUUID()}));
  const db=await new Promise<IDBDatabase>(resolve=>{const r=indexedDB.open(store.PAID_CLOCK_DB,1);r.onsuccess=()=>resolve(r.result);});
  const tx=db.transaction("heads","readwrite");tx.objectStore("heads").put({key:"metadata:paid-clock-device-v1",version:1,deviceId:"corrupt"});
  await new Promise<void>((resolve,reject)=>{tx.oncomplete=()=>resolve();tx.onabort=()=>reject(tx.error);});db.close();
  return store.readPaidClockRecords(auth.signInMark());
 },saved.intent.clientId);
 await open(page);let rpc=0;await page.route("**/rest/v1/**",route=>{rpc++;return route.abort();});
 const later=await reserveStart(page);expect(later.result).toMatchObject({kind:"reserved",clientId:saved.intent.clientId,created:false,record:before[0]});
 const again=await page.evaluate(async original=>{const {auth,coordinator}=window.paidOffline;return coordinator.reservePaidClockStart(auth.signInMark(),original);},saved.intent);
 expect(again).toMatchObject({kind:"reserved",created:false,record:before[0]});
 expect(await readRows(page)).toEqual(before);expect(rpc).toBe(0);
});

test("a reloaded unattempted start requires fresh off-state and settles only its own matching receipt",async({page})=>{
 await open(page);const saved=await reserveStart(page),before=await readRows(page);await open(page);
 let capabilityReads=0,currentReads=0,clockWrites=0,receiptReady=false;
 await page.route("**/rest/v1/time_shifts?**",route=>{currentReads++;return json(route,ownShift(),null);});
 await page.route("**/rest/v1/rpc/*",route=>{
  const rpc=new URL(route.request().url()).pathname.split("/").at(-1);
  if(rpc==="work_activity_clock_capability"){capabilityReads++;return json(route,startCapability,null);}
  if(rpc==="work_activity_clock_receipt")return json(route,receiptReady?{protocolVersion:1,availability:"available",receipt:{
   clientId:saved.intent.clientId,action:"clock_in",outcome:"clocked_in",shiftId:SHIFT,...originalStamp,arrivedAt:"2026-10-04T14:00:01Z",
   usedTapTime:true,reviewReason:null,receiptProtocol:"setup_v1",retention:"retained",sourcePresent:true,activityTransition:null,
  }}:{protocolVersion:1,availability:"unavailable",receipt:null},null);
  clockWrites++;return route.abort();
 });
 const retry=()=>page.evaluate(id=>{const {auth,coordinator}=window.paidOffline;return coordinator.recoverPaidClockRequest(id,auth.signInMark(),"retry_original");},saved.intent.clientId);
 expect(await retry()).toEqual({kind:"held",reason:"dependency"});expect(await readRows(page)).toEqual(before);
 expect(capabilityReads).toBe(1);expect(currentReads).toBe(1);expect(clockWrites).toBe(0);
 receiptReady=true;
 expect(await retry()).toMatchObject({kind:"settled",record:{clientId:saved.intent.clientId,delivery:{status:"acknowledged",everAttempted:true}}});
 expect((await readRows(page))[0].intent).toEqual(saved.intent);expect(clockWrites).toBe(0);
 expect(capabilityReads).toBe(1);expect(currentReads).toBe(1);
});

test("a reserved original survives lost acknowledgement and only explicit retry sends the same UUID and stamp",async({page})=>{
 await open(page);const saved=await reserveStart(page),calls:Record<string,unknown>[]=[];
 let receiptReady=false;
 await page.route("**/rest/v1/time_shifts?**",route=>json(route,null,null));
 await page.route("**/rest/v1/rpc/*",route=>{
  const rpc=new URL(route.request().url()).pathname.split("/").at(-1);
  if(rpc==="work_activity_clock_capability")return json(route,startCapability,null);
  if(rpc==="work_activity_clock_receipt")return json(route,receiptReady?{protocolVersion:1,availability:"available",receipt:{
   clientId:saved.intent.clientId,action:"clock_in",outcome:"clocked_in",shiftId:SHIFT,...originalStamp,arrivedAt:"2026-10-04T14:00:01Z",
   usedTapTime:true,reviewReason:null,receiptProtocol:"setup_v1",retention:"retained",sourcePresent:true,activityTransition:null,
  }}:{protocolVersion:1,availability:"unavailable",receipt:null},null);
  expect(rpc).toBe("clock_in");calls.push(route.request().postDataJSON());
  if(calls.length===1)return route.abort("failed");
  receiptReady=true;return json(route,{id:SHIFT,status:"open"},null);
 });
 const first=await page.evaluate(id=>{const {auth,coordinator}=window.paidOffline;return coordinator.deliverReservedPaidClockStart(id,auth.signInMark());},saved.intent.clientId);
 expect(first).toMatchObject({kind:"saved",dispatch:{kind:"held",reason:"unknown"}});
 const before=await readRows(page);expect(before[0].delivery).toMatchObject({status:"uncertain",everAttempted:true});
 await page.reload();await load(page);
 await page.evaluate(async()=>{
  // @ts-expect-error Vite browser module.
  const recovery=await import("/src/lib/paidClock/recovery.ts");await recovery.checkSavedPaidClockReceipts(window.paidOffline.auth.signInMark());
 });
 expect(calls).toHaveLength(1);expect(await readRows(page)).toEqual(before);
 const retried=await page.evaluate(id=>{const {auth,coordinator}=window.paidOffline;return coordinator.recoverPaidClockRequest(id,auth.signInMark(),"retry_original");},saved.intent.clientId);
 expect(retried).toMatchObject({kind:"settled",record:{delivery:{status:"acknowledged",everUncertain:true}}});
 expect(calls).toHaveLength(2);expect(calls[1]).toEqual(calls[0]);
 expect(calls[0]).toMatchObject({p_client_id:saved.intent.clientId,p_tapped_at:originalStamp.tappedAt,p_clock_checked_at:originalStamp.clockCheckedAt,p_clock_skew_ms:17,p_setup_version:1,p_project_id:null,p_cost_code_id:null});
 expect((await readRows(page))[0].intent).toEqual(saved.intent);
});

for(const boundary of ["native_completion","token_wait"] as const){
 test(`a ${boundary} no-send veto survives native commit and reload without becoming retry authority`,async({page})=>{
  await open(page);const saved=await reserveStart(page),writes:Record<string,unknown>[]=[];
  let openShift=false,receiptReady=false,currentReads=0,capabilityReads=0;
  await page.route("**/rest/v1/time_shifts?**",route=>{currentReads++;return json(route,openShift?ownShift():null,null);});
  await page.route("**/rest/v1/rpc/*",route=>{
   const rpc=new URL(route.request().url()).pathname.split("/").at(-1);
   if(rpc==="work_activity_clock_capability"){capabilityReads++;return json(route,startCapability,null);}
   if(rpc==="work_activity_clock_receipt")return json(route,receiptReady?{protocolVersion:1,availability:"available",receipt:{
    clientId:saved.intent.clientId,action:"clock_in",outcome:"clocked_in",shiftId:SHIFT,...originalStamp,arrivedAt:"2026-10-04T14:00:01Z",
    usedTapTime:true,reviewReason:null,receiptProtocol:"setup_v1",retention:"retained",sourcePresent:true,activityTransition:null,
   }}:{protocolVersion:1,availability:"unavailable",receipt:null},null);
   expect(rpc).toBe("clock_in");writes.push(route.request().postDataJSON());receiptReady=true;return json(route,{id:SHIFT,status:"open"},null);
  });
  const first=await page.evaluate(async({id,boundary})=>{
   const {auth,current,coordinator,store}=window.paidOffline,login=auth.signInMark();
   const put=IDBObjectStore.prototype.put,transaction=IDBDatabase.prototype.transaction;
   const sending=new WeakSet<IDBTransaction>();let committed=false,injected=false,armed=false;
   // This listener is installed before storage assigns oncomplete. The native
   // commit is real; invalidation happens before the helper resumes from done.
   IDBDatabase.prototype.transaction=function(...args:Parameters<typeof transaction>){
    const tx=transaction.apply(this,args);
    tx.addEventListener("complete",()=>{if(sending.has(tx)&&!injected){committed=true;if(boundary==="native_completion"){injected=true;current.invalidateObservedClockTarget(login);}}});return tx;
   };
   IDBObjectStore.prototype.put=function(...args:Parameters<typeof put>){
    const request=put.apply(this,args),row=args[0] as {clientId?:string;delivery?:{status?:string}};
    if(this.name==="requests"&&row.clientId===id&&row.delivery?.status==="sending"){sending.add(this.transaction);armed=true;}
    return request;
   };
   // @ts-expect-error Actual browser source module, no server fixture replacement.
   const {supabase}=await import("/src/lib/supabase.ts");
   const getSession=supabase.auth.getSession.bind(supabase.auth);
   let enter!:()=>void,release!:()=>void;const entered=new Promise<void>(done=>{enter=done;}),released=new Promise<void>(done=>{release=done;});
   supabase.auth.getSession=async()=>{const value=await getSession();if(boundary==="token_wait"&&armed&&!injected){enter();await released;}return value;};
   try{
    const operation=coordinator.deliverReservedPaidClockStart(id,login);
    if(boundary==="token_wait"){await entered;injected=true;current.invalidateObservedClockTarget(login);release();}
    const result=await operation;return {result,committed,injected,rows:await store.readPaidClockRecords(login)};
   }finally{release?.();IDBObjectStore.prototype.put=put;IDBDatabase.prototype.transaction=transaction;supabase.auth.getSession=getSession;}
  },{id:saved.intent.clientId,boundary});
  expect(first.committed).toBe(true);expect(first.injected).toBe(true);expect(writes).toHaveLength(0);
  expect(first.result).toMatchObject({kind:"saved",dispatch:{kind:"held",reason:boundary==="native_completion"?"storage":"dependency"}});
  expect(first.rows[0].intent).toEqual(saved.intent);
  expect(first.rows[0].delivery).toMatchObject({status:"attention",attentionReason:"first_delivery_held",everAttempted:true,everUncertain:false,receipt:null,resolvedShiftId:null});
  const committedToken=first.rows[0].delivery.attemptToken;expect(committedToken).toBeTruthy();
  await page.reload();await load(page);openShift=true;
  const retry=()=>page.evaluate(id=>{const {auth,coordinator}=window.paidOffline;return coordinator.recoverPaidClockRequest(id,auth.signInMark(),"retry_original");},saved.intent.clientId);
  expect(await retry()).toEqual({kind:"held",reason:"dependency"});expect(writes).toHaveLength(0);
  expect(currentReads).toBe(2);expect(capabilityReads).toBe(2);
  expect((await readRows(page))[0].delivery).toMatchObject({attemptToken:committedToken,everAttempted:true,everUncertain:false,attentionReason:"first_delivery_held"});
  openShift=false;
  expect(await retry()).toMatchObject({kind:"settled",record:{delivery:{status:"acknowledged",everAttempted:true,everUncertain:false}}});
  expect(writes).toHaveLength(1);expect(writes[0]).toMatchObject({p_client_id:saved.intent.clientId,p_tapped_at:originalStamp.tappedAt,p_clock_checked_at:originalStamp.clockCheckedAt,p_clock_skew_ms:17,p_setup_version:1});
  expect((await readRows(page))[0].intent).toEqual(saved.intent);
 });
}
