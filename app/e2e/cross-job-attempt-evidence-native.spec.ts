import {test as base,expect,chromium,webkit,firefox,type Page,type BrowserContext} from '@playwright/test';
import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import type * as Harness from './support/crossJobAttemptEvidenceHarness';
declare global {interface Window {attemptFixture:typeof Harness}}
// Every case owns a fresh ordinary persistent profile. No operational profile.
const test=base.extend({context:async({browserName,baseURL,viewport,deviceScaleFactor},provideContext)=>{
 const directory=mkdtempSync(join(tmpdir(),'cross-job-evidence-v4-'));let context:BrowserContext|undefined;
 try{context=await ({chromium,webkit,firefox}[browserName]).launchPersistentContext(directory,{headless:true,baseURL,viewport,deviceScaleFactor});await provideContext(context);}finally{try{await context?.close();}finally{rmSync(directory,{recursive:true,force:true});}}
}});
async function fixture(page:Page){await page.route('**/*',route=>new URL(route.request().url()).hostname==='localhost'?route.continue():route.abort());await page.route('**/attempt-v4-isolated',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><title>Attempt evidence fixture</title>'}));await page.goto('/attempt-v4-isolated');await page.evaluate(async()=>{
 // @ts-expect-error Isolated local Vite test module only.
 window.attemptFixture=await import('/e2e/support/crossJobAttemptEvidenceHarness.ts');
});}
for(const version of [1,2,3] as const)test(`native ${version} to4 preserves every original store and adds only empty evidence`,async({page})=>{
 await fixture(page);const result=await page.evaluate(async version=>{const f=window.attemptFixture;let old:IDBDatabase;if(version===1||version===2)old=await f.seedLegacy(version,true);else{await f.seedLegacy(2);old=await f.legacy.openCrossJobJournalV3(indexedDB);await f.legacy.appendCrossJobOriginal(old,f.values.genesis(),f.context());}const before=await f.census(old);old.close();const db=await f.open(),after=await f.census(db);db.close();let oldOpenRejected=false;try{(await f.legacy.openCrossJobJournalV3(indexedDB)).close();}catch{oldOpenRejected=true;}return {before,after,oldOpenRejected};},version);
 expect(result.after.version).toBe(4);expect(result.after.stores.filter(s=>result.before.stores.some(old=>old.name===s.name))).toEqual(result.before.stores);expect(result.after.stores.find(s=>s.name==='cross_job_attempt_evidence_v1')).toEqual({name:'cross_job_attempt_evidence_v1',keyPath:['ownerId','deviceId','commandId','attemptToken'],indexes:[],rows:[]});expect(result.oldOpenRejected).toBe(true);
});
const modes=['success','auth-throw','auth-change','snapshot-throw','snapshot-auth-change','lost','sync-throw','sql23514','sql42501','unknown-code','error-code-getter','result-error-getter','malformed-response','settle-during-snapshot','evidence-quota','row-quota','add-collision','postcommit-auth-change'] as const;
for(const mode of modes)test(`native adapter atomic attempt ${mode}`,async({page})=>{
 await fixture(page);const result=await page.evaluate(async mode=>{
  const f=window.attemptFixture;f.login();const db=await f.open(),o=f.values.genesis(),ctx=f.context();await f.storage.appendCrossJobOriginalV4(db,o,ctx);
  const claims=await Promise.all([f.storage.claimCrossJobOriginalV4(db,o.command.commandId,f.values.id(70),ctx,f.admission(o)),f.storage.claimCrossJobOriginalV4(db,o.command.commandId,f.values.id(71),ctx,f.admission(o))]);const ticket=claims.find(Boolean);if(!ticket||claims.filter(Boolean).length!==1)throw Error('claim race');
  const before=await f.storage.readCrossJobOriginalV4(db,o.command.commandId,ctx);let calls=0,getters=0,authCalls=0;
  const predicted=f.predictAllocation(o.command,o.prediction.status),proof=f.values.submission(predicted),lookup=f.values.lookup(predicted);
  const changeAuth=()=>f.auth.rememberSignedIn({user:{id:f.values.id(99)}});
  const ports={getSession:async()=>{authCalls++;if(mode==='auth-change')changeAuth();if(mode==='auth-throw')throw Error('fixture auth');return {data:{session:{access_token:'fixture-token',user:{id:f.values.id(1)}}},error:null};},clientWithToken:(token:string)=>({rpc:(name:string,args:Record<string,unknown>)=>{
   if(token!=='fixture-token')throw Error('wrong token');
   if(name==='work_cross_job_snapshot')return (async()=>{if(mode==='snapshot-auth-change')changeAuth();if(mode==='snapshot-throw')throw Error('fixture snapshot');if(mode==='settle-during-snapshot')await f.storage.settleCrossJobClaimV4(db,ticket,ctx,null,null);return {data:o.anchor,error:null};})();
   if(name==='work_cross_job_receipt')return Promise.resolve({data:lookup,error:null});
   if(name!=='work_activity_command'||JSON.stringify(args)!==JSON.stringify({p_command_id:o.command.commandId,p_protocol_version:2,p_payload:o.command.payload}))throw Error('wrong original wire');calls++;
   if(mode==='sync-throw')throw {code:'42501'};if(mode==='lost')return Promise.reject({code:'23514'});
   if(mode==='sql23514'||mode==='sql42501')return Promise.resolve({data:null,error:{code:mode.slice(3)}});
   if(mode==='unknown-code')return Promise.resolve({data:null,error:{code:'XX000'}});
   if(mode==='error-code-getter')return Promise.resolve({data:null,error:{get code(){getters++;return '42501';}}});
   if(mode==='result-error-getter')return Promise.resolve({data:null,get error(){getters++;return {code:'42501'};}});
   if(mode==='malformed-response')return Promise.resolve({data:{bad:true},error:null});
   return Promise.resolve({data:proof.reply,error:null});
  }})};
  const put=IDBObjectStore.prototype.put,add=IDBObjectStore.prototype.add;
  if(mode==='add-collision'){const tx=db.transaction(f.storage.ATTEMPT_EVIDENCE,'readwrite');tx.objectStore(f.storage.ATTEMPT_EVIDENCE).add({ownerId:o.command.ownerId,deviceId:o.command.payload.deviceId,commandId:o.command.commandId,attemptToken:ticket.token,fixture:'collision'});await f.complete(tx);}
  IDBObjectStore.prototype.add=function(...args:Parameters<typeof add>){if(mode==='evidence-quota'&&this.name===f.storage.ATTEMPT_EVIDENCE)throw new DOMException('fixture quota','QuotaExceededError');return add.apply(this,args);};
  IDBObjectStore.prototype.put=function(...args:Parameters<typeof put>){if(this.name===f.storage.CROSS_JOB_COMMANDS&&(args[0] as {revision?:number}).revision===2){if(mode==='row-quota')throw new DOMException('fixture quota','QuotaExceededError');if(mode==='postcommit-auth-change'){const tx=this.transaction,previous=tx.oncomplete;tx.oncomplete=event=>{previous?.call(tx,event);changeAuth();};}}return put.apply(this,args);};
  const api=f.api.createActivityTransportV3(async()=>ports),env={context:ctx,clock:()=>({elapsedMs:0,serverNow:o.anchor.asOf})};let answer;
  try{answer=await api.submitClaim(db,ticket,env);}finally{IDBObjectStore.prototype.put=put;IDBObjectStore.prototype.add=add;}
  const again=await api.submitClaim(db,ticket,env),after=await f.storage.readCrossJobOriginalV4(db,o.command.commandId,ctx),evidence=await f.storage.readAttemptEvidenceV1(db,o.command.commandId,ctx);db.close();
  return {calls,getters,authCalls,answer,again,before,after,evidence,bytes:o.commandBytes,proof};
 },mode);
 expect(result.getters).toBe(0);expect(result.again).toMatchObject({kind:'not_sent',reason:'send_capability_missing'});expect(result.after?.everAttempted).toBe(true);expect(result.after?.original.commandBytes).toBe(result.bytes);expect(result.authCalls).toBe(1);
 const notInvoked=['auth-throw','snapshot-throw','settle-during-snapshot'],noEvidence=['auth-change','snapshot-auth-change','evidence-quota','row-quota'];
 expect(result.calls).toBe([...notInvoked,'auth-change','snapshot-auth-change'].includes(mode)?0:1);
 if(notInvoked.includes(mode)){expect(result.evidence).toMatchObject({kind:'recorded',evidence:{fact:{kind:'not_invoked'}}});expect(result.after).toMatchObject({revision:2,hold:'unknown',historical:null});}
 else if(noEvidence.includes(mode)){expect(result.evidence).toEqual({kind:'not_recorded'});expect(result.after).toEqual(result.before);}
 else if(mode==='add-collision'){expect(result.after).toEqual(result.before);expect(result.evidence).toEqual({kind:'unreadable'});}
 else{expect(result.evidence).toMatchObject({kind:'recorded',evidence:{fact:{kind:'invoked',observedSqlError:mode==='sql23514'||mode==='sql42501'?{source:'command_rpc_returned_error',code:mode.slice(3)}:null}}});if(mode==='success'||mode==='postcommit-auth-change')expect(result.after?.historical?.submission).toEqual(result.proof);else expect(result.after).toMatchObject({hold:'unknown',historical:null});}
 if(mode==='postcommit-auth-change')expect(result.answer).toEqual({kind:'unknown',record:null});
});
for(const mode of ['forfeit','false-ready','throw-ready','settle-in-ready'] as const)test(`native private invoker ${mode} cannot later call`,async({page})=>{
 await fixture(page);const result=await page.evaluate(async mode=>{const f=window.attemptFixture,db=await f.open(),o=f.values.genesis(),ctx=f.context();await f.storage.appendCrossJobOriginalV4(db,o,ctx);const ticket=await f.storage.claimCrossJobOriginalV4(db,o.command.commandId,f.values.id(70),ctx,f.admission(o));if(!ticket)throw Error();const local=f.storage.consumeCrossJobSendV4(db,ticket),prepared=await f.storage.prepareCrossJobSendCheckV4(db,ticket,ctx);let calls=0,checks=0,first=false,second=false,pending:Promise<unknown>|undefined;
 const rpc=()=>{calls++;return Promise.resolve({data:null,error:null});};if(mode==='forfeit')local.forfeit();try{await local.invoke(()=>{checks++;if(mode==='throw-ready')throw Error();if(mode==='settle-in-ready'){pending=f.storage.settleCrossJobClaimV4(db,ticket,ctx,null,null);return true;}return mode==='false-ready'?false:prepared(f.admission(o));},rpc);}catch{first=true;}try{await local.invoke(()=>true,rpc);}catch{second=true;}local.forfeit();if(pending)await pending;else await f.storage.settleCrossJobClaimV4(db,ticket,ctx,null,null);const evidence=await f.storage.readAttemptEvidenceV1(db,o.command.commandId,ctx);db.close();return {calls,checks,first,second,evidence};},mode);
 expect(result.calls).toBe(0);expect(result.first&&result.second).toBe(true);expect(result.evidence).toMatchObject({kind:'recorded',evidence:{fact:{kind:'not_invoked'}}});
});
test('native V3 consumed old page closes on another page upgrade; original stays attempted without evidence',async({page,context})=>{
 await fixture(page);await page.evaluate(async()=>{const f=window.attemptFixture,db=await f.legacy.openCrossJobJournalV3(indexedDB),o=f.values.genesis(),ctx=f.context();await f.legacy.appendCrossJobOriginal(db,o,ctx);const ticket=await f.legacy.claimCrossJobOriginal(db,o.command.commandId,f.values.id(70),ctx,f.admission(o));if(!ticket)throw Error();f.legacy.consumeCrossJobSend(db,ticket);Object.assign(window,{oldEvidenceFixture:{db,o,ticket}});});
 const other=await context.newPage();try{await fixture(other);const result=await other.evaluate(async()=>{const f=window.attemptFixture,db=await f.open(),o=f.values.genesis(),ctx=f.context();const row=await f.storage.readCrossJobOriginalV4(db,o.command.commandId,ctx),evidence=await f.storage.readAttemptEvidenceV1(db,o.command.commandId,ctx),claim=await f.storage.claimCrossJobOriginalV4(db,o.command.commandId,f.values.id(71),ctx,f.admission(o));db.close();return {row,evidence,claim,bytes:o.commandBytes};});
 const old=await page.evaluate(()=>{const state=Object.getOwnPropertyDescriptor(window,'oldEvidenceFixture')!.value;let closed=false;try{state.db.transaction('cross_job_commands_v2','readonly');}catch{closed=true;}return {closed};});expect(old.closed).toBe(true);expect(result.row?.everAttempted).toBe(true);expect(result.row?.original.commandBytes).toBe(result.bytes);expect(result.evidence).toEqual({kind:'not_recorded'});expect(result.claim).toBeNull();}finally{await other.close();}
});
test('native winning handle alone owns its ticket; later hold leaves immutable evidence byte-identical',async({page})=>{
 await fixture(page);const result=await page.evaluate(async()=>{const f=window.attemptFixture,a=await f.open(),b=await f.open(),o=f.values.genesis(),ctx=f.context();await f.storage.appendCrossJobOriginalV4(a,o,ctx);const tickets=await Promise.all([f.storage.claimCrossJobOriginalV4(a,o.command.commandId,f.values.id(70),ctx,f.admission(o)),f.storage.claimCrossJobOriginalV4(b,o.command.commandId,f.values.id(71),ctx,f.admission(o))]);const index=tickets.findIndex(Boolean),ticket=tickets[index]!;if(tickets.filter(Boolean).length!==1)throw Error('race');const db=index===0?a:b,wrong=index===0?b:a;let wrongRejected=false;try{f.storage.consumeCrossJobSendV4(wrong,ticket);}catch{wrongRejected=true;}const local=f.storage.consumeCrossJobSendV4(db,ticket),ready=await f.storage.prepareCrossJobSendCheckV4(db,ticket,ctx);let calls=0;await local.invoke(()=>ready(f.admission(o)),()=>{calls++;return Promise.resolve({data:null,error:null});});local.forfeit();await f.storage.settleCrossJobClaimV4(db,ticket,ctx,null,null);const before=await f.storage.readAttemptEvidenceV1(db,o.command.commandId,ctx);await f.storage.holdCrossJobOriginalV4(db,o.command.commandId,ctx,'context_changed');const after=await f.storage.readAttemptEvidenceV1(db,o.command.commandId,ctx);a.close();b.close();return {wrongRejected,calls,before,after};});expect(result.wrongRejected).toBe(true);expect(result.calls).toBe(1);expect(result.after).toEqual(result.before);expect(result.after).toMatchObject({kind:'recorded',evidence:{fact:{kind:'invoked',observedSqlError:null}}});
});
test('native V4 versionchange forfeits an already prepared local invoker without inventing evidence',async({page})=>{
 await fixture(page);const result=await page.evaluate(async()=>{const f=window.attemptFixture,db=await f.open(),o=f.values.genesis(),ctx=f.context();await f.storage.appendCrossJobOriginalV4(db,o,ctx);const ticket=await f.storage.claimCrossJobOriginalV4(db,o.command.commandId,f.values.id(70),ctx,f.admission(o));if(!ticket)throw Error();const local=f.storage.consumeCrossJobSendV4(db,ticket),ready=await f.storage.prepareCrossJobSendCheckV4(db,ticket,ctx);const newer=await new Promise<IDBDatabase>((resolve,reject)=>{const r=indexedDB.open(f.storage.CROSS_JOB_DB_NAME,5);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});let calls=0,rejected=false;try{await local.invoke(()=>ready(f.admission(o)),()=>{calls++;return Promise.resolve({data:null,error:null});});}catch{rejected=true;}const tx=newer.transaction([f.storage.CROSS_JOB_COMMANDS,f.storage.ATTEMPT_EVIDENCE],'readonly'),done=f.complete(tx);const [row,evidence]=await Promise.all([f.get(tx.objectStore(f.storage.CROSS_JOB_COMMANDS).get(o.command.commandId)),f.get(tx.objectStore(f.storage.ATTEMPT_EVIDENCE).getAll()),done]);newer.close();return {calls,rejected,row,evidence};});expect(result.calls).toBe(0);expect(result.rejected).toBe(true);expect(result.row).toMatchObject({everAttempted:true,revision:1,hold:null,historical:null});expect(result.evidence).toEqual([]);
});

// Source checkpoint 2: append-only controls; the original 28 cases above remain exact.
for(const code of ['23514','42501'] as const)test(`AE2 pending command settlement freezes invoked before late ${code}`,async({page})=>{
 await fixture(page);const result=await page.evaluate(async code=>{
  const f=window.attemptFixture;f.login();const db=await f.open(),o=f.values.genesis(),ctx=f.context();await f.storage.appendCrossJobOriginalV4(db,o,ctx);
  const ticket=await f.storage.claimCrossJobOriginalV4(db,o.command.commandId,f.values.id(70),ctx,f.admission(o));if(!ticket)throw Error('missing claim');
  let started!:()=>void,release!:(value:{data:null;error:{code:string}})=>void,calls=0;const entered=new Promise<void>(resolve=>{started=resolve;}),pending=new Promise<{data:null;error:{code:string}}>(resolve=>{release=resolve;});
  const api=f.api.createActivityTransportV3(async()=>({getSession:async()=>({data:{session:{access_token:'fixture-token',user:{id:o.command.ownerId}}},error:null}),clientWithToken:()=>({rpc:(name,args)=>{
   if(name==='work_cross_job_snapshot')return Promise.resolve({data:o.anchor,error:null});
   if(name!=='work_activity_command'||JSON.stringify(args)!==JSON.stringify({p_command_id:o.command.commandId,p_protocol_version:2,p_payload:o.command.payload}))throw Error('unexpected wire');calls++;started();return pending;
  }})}));const env={context:ctx,clock:()=>({elapsedMs:0,serverNow:o.anchor.asOf})};
  const submitted=api.submitClaim(db,ticket,env);await entered;
  const settled=await f.storage.settleCrossJobClaimV4(db,ticket,ctx,null,null),frozen=await f.storage.readAttemptEvidenceV1(db,o.command.commandId,ctx);
  release({data:null,error:{code}});const answer=await submitted,after=await f.storage.readAttemptEvidenceV1(db,o.command.commandId,ctx),row=await f.storage.readCrossJobOriginalV4(db,o.command.commandId,ctx),again=await api.submitClaim(db,ticket,env);
  let consumeRejected=false;try{f.storage.consumeCrossJobSendV4(db,ticket);}catch{consumeRejected=true;}db.close();return {calls,settled,frozen,after,row,answer,again,consumeRejected,original:o};
 },code);
 expect(result.calls).toBe(1);expect(result.frozen).toMatchObject({kind:'recorded',evidence:{fact:{kind:'invoked',observedSqlError:null}}});expect(result.after).toEqual(result.frozen);expect(result.row).toEqual(result.settled);expect(result.row?.original).toEqual(result.original);expect(result.row).toMatchObject({everAttempted:true,revision:2,hold:'unknown',historical:null});expect(result.answer).toEqual({kind:'unknown',record:null,sqlState:code});expect(result.again).toMatchObject({kind:'not_sent',reason:'send_capability_missing'});expect(result.consumeRejected).toBe(true);
});
test('AE2 actual asynchronous abort after both write successes rolls back the pair without fallback',async({page})=>{
 await fixture(page);const result=await page.evaluate(async()=>{
  const f=window.attemptFixture,db=await f.open(),o=f.values.genesis(),ctx=f.context();await f.storage.appendCrossJobOriginalV4(db,o,ctx);const ticket=await f.storage.claimCrossJobOriginalV4(db,o.command.commandId,f.values.id(70),ctx,f.admission(o));if(!ticket)throw Error('missing claim');const before=await f.storage.readCrossJobOriginalV4(db,o.command.commandId,ctx),local=f.storage.consumeCrossJobSendV4(db,ticket),ready=await f.storage.prepareCrossJobSendCheckV4(db,ticket,ctx);let calls=0;
  await local.invoke(()=>ready(f.admission(o)),()=>{calls++;return Promise.resolve({data:null,error:null});});local.forfeit();
  const put=IDBObjectStore.prototype.put,add=IDBObjectStore.prototype.add,events:string[]=[];let writes=0,adds=0,completeEvents=0,abortEvents=0,reason='';
  IDBObjectStore.prototype.add=function(...args:Parameters<typeof add>){const request=add.apply(this,args);if(this.name===f.storage.ATTEMPT_EVIDENCE){adds++;request.addEventListener('success',()=>events.push('evidence-request-success'));}return request;};
  IDBObjectStore.prototype.put=function(...args:Parameters<typeof put>){const request=put.apply(this,args);if(this.name===f.storage.CROSS_JOB_COMMANDS&&(args[0] as {revision?:number}).revision===2){writes++;const tx=this.transaction;tx.addEventListener('complete',()=>{completeEvents++;});tx.addEventListener('abort',()=>{abortEvents++;events.push('transaction-abort');});request.addEventListener('success',()=>{events.push('row-request-success');tx.abort();events.push('abort-requested');});}return request;};
  try{await f.storage.settleCrossJobClaimV4(db,ticket,ctx,null,null);}catch(error){reason=error instanceof Error?error.message:'unknown';}finally{IDBObjectStore.prototype.put=put;IDBObjectStore.prototype.add=add;}
  const after=await f.storage.readCrossJobOriginalV4(db,o.command.commandId,ctx),evidence=await f.storage.readAttemptEvidenceV1(db,o.command.commandId,ctx),newClaim=await f.storage.claimCrossJobOriginalV4(db,o.command.commandId,f.values.id(71),ctx,f.admission(o));let secondSettlementRejected=false;try{await f.storage.settleCrossJobClaimV4(db,ticket,ctx,null,null);}catch{secondSettlementRejected=true;}db.close();return {before,after,evidence,calls,writes,adds,events,completeEvents,abortEvents,reason,newClaim,secondSettlementRejected};
 });
 expect(result.events).toEqual(['evidence-request-success','row-request-success','abort-requested','transaction-abort']);expect(result.reason).not.toBe('');expect(result.abortEvents).toBe(1);expect(result.completeEvents).toBe(0);expect(result.calls).toBe(1);expect(result.writes).toBe(1);expect(result.adds).toBe(1);expect(result.after).toEqual(result.before);expect(result.after).toMatchObject({everAttempted:true,revision:1,hold:null,historical:null});expect(result.evidence).toEqual({kind:'not_recorded'});expect(result.newClaim).toBeNull();expect(result.secondSettlementRejected).toBe(true);
});
test('AE2 context changes before transaction completion guard: committed pair with rejection',async({page})=>{
 await fixture(page);const result=await page.evaluate(async()=>{
  const f=window.attemptFixture,db=await f.open(),o=f.values.genesis(),ctx=f.context();await f.storage.appendCrossJobOriginalV4(db,o,ctx);const ticket=await f.storage.claimCrossJobOriginalV4(db,o.command.commandId,f.values.id(70),ctx,f.admission(o));if(!ticket)throw Error('missing claim');const local=f.storage.consumeCrossJobSendV4(db,ticket),ready=await f.storage.prepareCrossJobSendCheckV4(db,ticket,ctx);let calls=0;await local.invoke(()=>ready(f.admission(o)),()=>{calls++;return Promise.resolve({data:null,error:null});});local.forfeit();
  const put=IDBObjectStore.prototype.put;let changedBeforeGuard=false,errorResult:unknown=null;
  IDBObjectStore.prototype.put=function(...args:Parameters<typeof put>){if(this.name===f.storage.CROSS_JOB_COMMANDS&&(args[0] as {revision?:number}).revision===2){const tx=this.transaction,guard=tx.oncomplete;tx.oncomplete=event=>{f.setContext({userId:f.values.id(99)});changedBeforeGuard=true;guard?.call(tx,event);};}return put.apply(this,args);};
  try{await f.storage.settleCrossJobClaimV4(db,ticket,ctx,null,null);}catch(error){if(!(error instanceof f.legacy.JournalV3Error))throw error;errorResult={reason:error.reason,committed:error.committed};}finally{IDBObjectStore.prototype.put=put;f.setContext(o.fences);}
  const row=await f.storage.readCrossJobOriginalV4(db,o.command.commandId,ctx),evidence=await f.storage.readAttemptEvidenceV1(db,o.command.commandId,ctx);let repeated=false;try{await f.storage.settleCrossJobClaimV4(db,ticket,ctx,null,null);}catch{repeated=true;}db.close();return {calls,changedBeforeGuard,errorResult,row,evidence,repeated,original:o};
 });
 expect(result.changedBeforeGuard).toBe(true);expect(result.errorResult).toEqual({reason:'context_changed',committed:true});expect(result.calls).toBe(1);expect(result.row).toMatchObject({everAttempted:true,revision:2,hold:'unknown',historical:null});expect(result.row?.original).toEqual(result.original);expect(result.evidence).toMatchObject({kind:'recorded',evidence:{fact:{kind:'invoked',observedSqlError:null}}});expect(result.repeated).toBe(true);
});
test('AE2 auth loss after invocation suppresses adapter settlement; scoped direct settlement cannot recover send',async({page})=>{
 await fixture(page);const result=await page.evaluate(async()=>{
  const f=window.attemptFixture;f.login();const db=await f.open(),o=f.values.genesis(),ctx=f.context();await f.storage.appendCrossJobOriginalV4(db,o,ctx);const ticket=await f.storage.claimCrossJobOriginalV4(db,o.command.commandId,f.values.id(70),ctx,f.admission(o));if(!ticket)throw Error('missing claim');const before=await f.storage.readCrossJobOriginalV4(db,o.command.commandId,ctx);let calls=0;
  const api=f.api.createActivityTransportV3(async()=>({getSession:async()=>({data:{session:{access_token:'fixture-token',user:{id:o.command.ownerId}}},error:null}),clientWithToken:()=>({rpc:(name)=>{
   if(name==='work_cross_job_snapshot')return Promise.resolve({data:o.anchor,error:null});if(name!=='work_activity_command')throw Error('unexpected RPC');calls++;f.auth.rememberSignedIn({user:{id:f.values.id(99)}});return Promise.resolve({data:null,error:{code:'42501'}});
  }})}));const env={context:ctx,clock:()=>({elapsedMs:0,serverNow:o.anchor.asOf})},answer=await api.submitClaim(db,ticket,env),suppressed=await f.storage.readCrossJobOriginalV4(db,o.command.commandId,ctx),missing=await f.storage.readAttemptEvidenceV1(db,o.command.commandId,ctx);
  let consumeRejected=false;try{f.storage.consumeCrossJobSendV4(db,ticket);}catch{consumeRejected=true;}
  // A supplied journal scope is not actual authentication. No session reset or
  // same/different-login recovery policy is implied by this direct primitive.
  const settled=await f.storage.settleCrossJobClaimV4(db,ticket,ctx,null,null),evidence=await f.storage.readAttemptEvidenceV1(db,o.command.commandId,ctx),again=await api.submitClaim(db,ticket,env),newClaim=await f.storage.claimCrossJobOriginalV4(db,o.command.commandId,f.values.id(71),ctx,f.admission(o));db.close();return {calls,before,answer,suppressed,missing,consumeRejected,settled,evidence,again,newClaim,original:o};
 });
 expect(result.answer).toEqual({kind:'unknown',record:null});expect(result.suppressed).toEqual(result.before);expect(result.missing).toEqual({kind:'not_recorded'});expect(result.consumeRejected).toBe(true);expect(result.calls).toBe(1);expect(result.settled).toMatchObject({everAttempted:true,revision:2,hold:'unknown',historical:null});expect(result.settled.original).toEqual(result.original);expect(result.evidence).toMatchObject({kind:'recorded',evidence:{fact:{kind:'invoked',observedSqlError:{source:'command_rpc_returned_error',code:'42501'}}}});expect(result.again).toMatchObject({kind:'not_sent',reason:'send_capability_missing'});expect(result.newClaim).toBeNull();
});

// Source checkpoint 3: nine approved branch controls; original 33 cases unchanged.
for(const channel of ['auth','snapshot','lookup'] as const)for(const code of ['23514','42501'] as const)test(`AE3 ${channel} returned ${code} is never command-error evidence`,async({page})=>{
 await fixture(page);const result=await page.evaluate(async({channel,code})=>{
  const f=window.attemptFixture;f.login();const db=await f.open(),ctx=f.context(),parent=f.values.genesis();await f.storage.appendCrossJobOriginalV4(db,parent,ctx);const parentTicket=await f.storage.claimCrossJobOriginalV4(db,parent.command.commandId,f.values.id(69),ctx,f.admission(parent));if(!parentTicket)throw Error('missing parent');
  const parentPrediction=f.predictAllocation(parent.command,parent.prediction.status),parentRow=await f.storage.settleCrossJobClaimV4(db,parentTicket,ctx,f.values.submission(parentPrediction),f.values.lookup(parentPrediction));if(!parentRow.historical?.confirmed)throw Error('parent not confirmed');
  const o=f.values.child(parentRow),predicted=f.predictAllocation(o.command,o.prediction.status),proof=f.values.submission(predicted);if(o.prediction.status!=='applied')throw Error('requires applied child');await f.storage.appendCrossJobOriginalV4(db,o,ctx);const ticket=await f.storage.claimCrossJobOriginalV4(db,o.command.commandId,f.values.id(70),ctx,f.admission(o));if(!ticket)throw Error('missing child claim');
  const calls:string[]=[];let authCalls=0;const api=f.api.createActivityTransportV3(async()=>({getSession:async()=>{authCalls++;return {data:{session:{access_token:'fixture-token',user:{id:o.command.ownerId}}},error:channel==='auth'?{code}:null};},clientWithToken:token=>({rpc:(name,args)=>{
   if(token!=='fixture-token')throw Error('wrong token');calls.push(name);if(name==='work_cross_job_snapshot')return Promise.resolve({data:o.anchor,error:channel==='snapshot'?{code}:null});
   if(name==='work_cross_job_receipt'){if(channel!=='lookup')throw Error('unexpected lookup');return Promise.resolve({data:null,error:{code}});}
   if(name!=='work_activity_command'||JSON.stringify(args)!==JSON.stringify({p_command_id:o.command.commandId,p_protocol_version:2,p_payload:o.command.payload}))throw Error('wrong command');return Promise.resolve({data:proof.reply,error:null});
  }})}));const env={context:ctx,clock:()=>({elapsedMs:0,serverNow:o.anchor.asOf})},answer=await api.submitClaim(db,ticket,env),again=await api.submitClaim(db,ticket,env),row=await f.storage.readCrossJobOriginalV4(db,o.command.commandId,ctx),evidence=await f.storage.readAttemptEvidenceV1(db,o.command.commandId,ctx);db.close();return {calls,authCalls,answer,again,row,evidence,proof,original:o,token:ticket.token};
 },{channel,code});
 expect(result.authCalls).toBe(1);expect(result.again).toMatchObject({kind:'not_sent',reason:'send_capability_missing'});expect(result.row?.original).toEqual(result.original);expect(result.row).toMatchObject({everAttempted:true,attemptToken:result.token,revision:2});expect(result.answer).not.toHaveProperty('sqlState');
 if(channel==='lookup'){expect(result.calls).toEqual(['work_cross_job_snapshot','work_activity_command','work_cross_job_receipt']);expect(result.answer).toMatchObject({kind:'receipt',reply:result.proof.reply});expect(result.row).toMatchObject({hold:'intent_unproven',historical:{submission:result.proof,lookup:null,confirmed:null}});expect(result.evidence).toMatchObject({kind:'recorded',evidence:{fact:{kind:'invoked',observedSqlError:null}}});}
 else{expect(result.calls).toEqual(channel==='auth'?[]:['work_cross_job_snapshot']);expect(result.answer).toMatchObject({kind:'not_sent',reason:'admission_or_auth_unavailable'});expect(result.row).toMatchObject({hold:'unknown',historical:null});expect(result.evidence).toMatchObject({kind:'recorded',evidence:{fact:{kind:'not_invoked'}}});}
});
test('AE3 command-unavailable strict reply retains receipt label without lookup or history',async({page})=>{
 await fixture(page);const result=await page.evaluate(async()=>{
  const f=window.attemptFixture;f.login();const db=await f.open(),o=f.values.genesis(),ctx=f.context();await f.storage.appendCrossJobOriginalV4(db,o,ctx);const ticket=await f.storage.claimCrossJobOriginalV4(db,o.command.commandId,f.values.id(70),ctx,f.admission(o));if(!ticket)throw Error('missing claim');const reply={protocolVersion:2,availability:'unavailable',receipt:null},calls:string[]=[];
  const api=f.api.createActivityTransportV3(async()=>({getSession:async()=>({data:{session:{access_token:'fixture-token',user:{id:o.command.ownerId}}},error:null}),clientWithToken:()=>({rpc:(name,args)=>{calls.push(name);if(name==='work_cross_job_snapshot')return Promise.resolve({data:o.anchor,error:null});if(name!=='work_activity_command'||JSON.stringify(args)!==JSON.stringify({p_command_id:o.command.commandId,p_protocol_version:2,p_payload:o.command.payload}))throw Error('unexpected RPC');return Promise.resolve({data:reply,error:null});}})}));const env={context:ctx,clock:()=>({elapsedMs:0,serverNow:o.anchor.asOf})},answer=await api.submitClaim(db,ticket,env),again=await api.submitClaim(db,ticket,env),row=await f.storage.readCrossJobOriginalV4(db,o.command.commandId,ctx),evidence=await f.storage.readAttemptEvidenceV1(db,o.command.commandId,ctx);db.close();return {calls,answer,again,row,evidence,reply,original:o,token:ticket.token};
 });
 expect(result.calls).toEqual(['work_cross_job_snapshot','work_activity_command']);expect(result.answer).toEqual({kind:'receipt',reply:result.reply,record:result.row});expect(result.row).toMatchObject({everAttempted:true,attemptToken:result.token,revision:2,hold:'unknown',historical:null});expect(result.row?.original).toEqual(result.original);expect(result.evidence).toMatchObject({kind:'recorded',evidence:{fact:{kind:'invoked',observedSqlError:null}}});expect(result.again).toMatchObject({kind:'not_sent',reason:'send_capability_missing'});
});
test('AE3 two-handle claim race then concurrent same-ticket submissions has one invocation and settlement',async({page})=>{
 await fixture(page);const result=await page.evaluate(async()=>{
  const f=window.attemptFixture;f.login();const a=await f.open(),b=await f.open(),o=f.values.genesis(),ctx=f.context();await f.storage.appendCrossJobOriginalV4(a,o,ctx);const claims=await Promise.all([f.storage.claimCrossJobOriginalV4(a,o.command.commandId,f.values.id(70),ctx,f.admission(o)),f.storage.claimCrossJobOriginalV4(b,o.command.commandId,f.values.id(71),ctx,f.admission(o))]);const index=claims.findIndex(Boolean),ticket=claims[index];if(!ticket||claims.filter(Boolean).length!==1)throw Error('claim race');const db=index===0?a:b,before=await f.storage.readCrossJobOriginalV4(db,o.command.commandId,ctx),predicted=f.predictAllocation(o.command,o.prediction.status),proof=f.values.submission(predicted);
  let release!:()=>void,authCalls=0,loads=0,commandCalls=0,settlementPuts=0,evidenceAdds=0;const authGate=new Promise<void>(resolve=>{release=resolve;}),put=IDBObjectStore.prototype.put,add=IDBObjectStore.prototype.add;
  IDBObjectStore.prototype.put=function(...args:Parameters<typeof put>){if(this.name===f.storage.CROSS_JOB_COMMANDS&&(args[0] as {revision?:number}).revision===2)settlementPuts++;return put.apply(this,args);};IDBObjectStore.prototype.add=function(...args:Parameters<typeof add>){if(this.name===f.storage.ATTEMPT_EVIDENCE)evidenceAdds++;return add.apply(this,args);};
  const api=f.api.createActivityTransportV3(async()=>{loads++;return {getSession:async()=>{authCalls++;await authGate;return {data:{session:{access_token:'fixture-token',user:{id:o.command.ownerId}}},error:null};},clientWithToken:()=>({rpc:(name,args)=>{if(name==='work_cross_job_snapshot')return Promise.resolve({data:o.anchor,error:null});if(name==='work_cross_job_receipt')return Promise.resolve({data:f.values.lookup(predicted),error:null});if(name!=='work_activity_command'||JSON.stringify(args)!==JSON.stringify({p_command_id:o.command.commandId,p_protocol_version:2,p_payload:o.command.payload}))throw Error('wrong command');commandCalls++;return Promise.resolve({data:proof.reply,error:null});}})};});
  const env={context:ctx,clock:()=>({elapsedMs:0,serverNow:o.anchor.asOf})};let first,second,commandsBeforeRelease;
  try{const pending=api.submitClaim(db,ticket,env);second=await api.submitClaim(db,ticket,env);commandsBeforeRelease=commandCalls;release();first=await pending;}finally{release();IDBObjectStore.prototype.put=put;IDBObjectStore.prototype.add=add;}
  const row=await f.storage.readCrossJobOriginalV4(db,o.command.commandId,ctx),evidence=await f.storage.readAttemptEvidenceV1(db,o.command.commandId,ctx);a.close();b.close();return {winners:claims.filter(Boolean).length,before,row,evidence,first,second,commandsBeforeRelease,loads,authCalls,commandCalls,settlementPuts,evidenceAdds,original:o,token:ticket.token};
 });
 expect(result.winners).toBe(1);expect(result.second).toEqual({kind:'not_sent',reason:'send_capability_missing',record:null});expect(result.commandsBeforeRelease).toBe(0);expect(result.loads).toBe(1);expect(result.authCalls).toBe(1);expect(result.commandCalls).toBe(1);expect(result.settlementPuts).toBe(1);expect(result.evidenceAdds).toBe(1);expect(result.first).toMatchObject({kind:'receipt',record:result.row});expect(result.row).toMatchObject({everAttempted:true,attemptToken:result.token,revision:2,hold:null});expect(result.before?.attemptToken).toBe(result.token);expect(result.row?.original).toEqual(result.original);expect(result.row?.original).toEqual(result.before?.original);expect(result.evidence).toMatchObject({kind:'recorded',evidence:{attemptToken:result.token,originalCommandBytes:result.original.commandBytes,fact:{kind:'invoked',observedSqlError:null}}});
});
test('AE3 settlement before consume records no inferred fact and permanently closes later send',async({page})=>{
 await fixture(page);const result=await page.evaluate(async()=>{
  const f=window.attemptFixture;f.login();const db=await f.open(),o=f.values.genesis(),ctx=f.context();await f.storage.appendCrossJobOriginalV4(db,o,ctx);const ticket=await f.storage.claimCrossJobOriginalV4(db,o.command.commandId,f.values.id(70),ctx,f.admission(o));if(!ticket)throw Error('missing claim');const settled=await f.storage.settleCrossJobClaimV4(db,ticket,ctx,null,null),evidence=await f.storage.readAttemptEvidenceV1(db,o.command.commandId,ctx);let consumeRejected=false,loads=0;try{f.storage.consumeCrossJobSendV4(db,ticket);}catch{consumeRejected=true;}
  const api=f.api.createActivityTransportV3(async()=>{loads++;throw Error('must not load ports');}),answer=await api.submitClaim(db,ticket,{context:ctx,clock:()=>({elapsedMs:0,serverNow:o.anchor.asOf})}),newClaim=await f.storage.claimCrossJobOriginalV4(db,o.command.commandId,f.values.id(71),ctx,f.admission(o)),after=await f.storage.readCrossJobOriginalV4(db,o.command.commandId,ctx);db.close();return {settled,evidence,consumeRejected,loads,answer,newClaim,after,original:o,token:ticket.token};
 });
 expect(result.settled).toMatchObject({everAttempted:true,attemptToken:result.token,revision:2,hold:'unknown',historical:null});expect(result.settled.original).toEqual(result.original);expect(result.evidence).toEqual({kind:'not_recorded'});expect(result.consumeRejected).toBe(true);expect(result.loads).toBe(0);expect(result.answer).toEqual({kind:'not_sent',reason:'send_capability_missing',record:null});expect(result.newClaim).toBeNull();expect(result.after).toEqual(result.settled);
});

// Source checkpoint 4: six bounded AE4 controls; the original 42 cases above remain exact.
// Supplied journal scopes are caller fences only. Equal or unequal login
// generation here is never real re-login admission, and no recovery policy is
// implied for live clock bounds, waits, other verified sessions or history.
for(const scope of ['owner','device','generation'] as const)test(`AE4 foreign ${scope} scope reads corrupt evidence as null without any evidence lookup`,async({page})=>{
 await fixture(page);const result=await page.evaluate(async scope=>{
  const f=window.attemptFixture,db=await f.open(),o=f.values.genesis(),ctx=f.context(),EVID=f.storage.ATTEMPT_EVIDENCE;await f.storage.appendCrossJobOriginalV4(db,o,ctx);
  const ticket=await f.storage.claimCrossJobOriginalV4(db,o.command.commandId,f.values.id(70),ctx,f.admission(o));if(!ticket)throw Error('missing claim');const local=f.storage.consumeCrossJobSendV4(db,ticket);local.forfeit();await f.storage.settleCrossJobClaimV4(db,ticket,ctx,null,null);
  const readTx=db.transaction(EVID,'readonly'),readDone=f.complete(readTx),[stored]=await Promise.all([f.get(readTx.objectStore(EVID).get([o.command.ownerId,o.command.payload.deviceId,o.command.commandId,ticket.token])),readDone]);
  const own=f.values.fences(),foreign={...own,...(scope==='owner'?{userId:f.values.id(98)}:scope==='device'?{deviceId:f.values.id(97)}:{loginGeneration:own.loginGeneration+1})},foreignCtx={expected:foreign,current:()=>foreign};
  const changed=(Object.keys(own) as (keyof typeof own)[]).filter(k=>JSON.stringify(own[k])!==JSON.stringify(foreign[k]));
  // Exact lookup ledger for this fresh fixture only; restored before return.
  const get=IDBObjectStore.prototype.get,ledger:string[]=[];IDBObjectStore.prototype.get=function(...args:Parameters<typeof get>){ledger.push(this.name);return get.apply(this,args);};
  const outcome=await (async()=>{try{
   const valid=await f.storage.readAttemptEvidenceV1(db,o.command.commandId,ctx),validLookups=ledger.splice(0);
   const tx=db.transaction(EVID,'readwrite');tx.objectStore(EVID).put({...stored,fact:{kind:'tampered'}});await f.complete(tx);
   const corrupt=await f.storage.readAttemptEvidenceV1(db,o.command.commandId,ctx),corruptLookups=ledger.splice(0);
   const before=await f.census(db);ledger.splice(0);
   const foreignRead=await f.storage.readAttemptEvidenceV1(db,o.command.commandId,foreignCtx),foreignLookups=ledger.splice(0);
   const after=await f.census(db);return {valid,validLookups,corrupt,corruptLookups,before,foreignRead,foreignLookups,after};
  }finally{IDBObjectStore.prototype.get=get;}})();
  db.close();return {...outcome,changed,stored};
 },scope);
 expect(result.changed).toEqual([{owner:'userId',device:'deviceId',generation:'loginGeneration'}[scope]]);
 expect(result.stored).toMatchObject({fact:{kind:'not_invoked'}});expect(result.valid).toEqual({kind:'recorded',evidence:result.stored});expect(result.validLookups).toEqual(['cross_job_commands_v2','cross_job_attempt_evidence_v1']);
 expect(result.corrupt).toEqual({kind:'unreadable'});expect(result.corruptLookups).toEqual(['cross_job_commands_v2','cross_job_attempt_evidence_v1']);
 expect(result.before.stores.find(s=>s.name==='cross_job_attempt_evidence_v1')?.rows).toEqual([{...result.stored,fact:{kind:'tampered'}}]);
 expect(result.foreignRead).toBeNull();expect(result.foreignLookups).toEqual(['cross_job_commands_v2']);expect(result.after).toEqual(result.before);
});
test('AE4 replaced canonical attempt token parses but settlement refuses on claim binding and spends authority',async({page})=>{
 await fixture(page);const result=await page.evaluate(async()=>{
  const f=window.attemptFixture,db=await f.open(),o=f.values.genesis(),ctx=f.context(),CMD=f.storage.CROSS_JOB_COMMANDS;await f.storage.appendCrossJobOriginalV4(db,o,ctx);
  const ticket=await f.storage.claimCrossJobOriginalV4(db,o.command.commandId,f.values.id(70),ctx,f.admission(o));if(!ticket)throw Error('missing claim');const witness={commandId:ticket.command.commandId,token:ticket.token,command:JSON.stringify(ticket.command)};
  const local=f.storage.consumeCrossJobSendV4(db,ticket),ready=await f.storage.prepareCrossJobSendCheckV4(db,ticket,ctx),admitted=ready(f.admission(o)),invoked=local.invocationStarted();
  const raw=async()=>{const tx=db.transaction(CMD,'readonly'),done=f.complete(tx);const [value]=await Promise.all([f.get(tx.objectStore(CMD).get(o.command.commandId)),done]);return value;};
  const reason=async(run:()=>unknown)=>{try{await run();return 'resolved';}catch(error){return error instanceof f.legacy.JournalV3Error?error.reason:`other:${error instanceof Error?error.message:typeof error}`;}};
  const claimed=await raw(),replacement=f.values.id(72),tx=db.transaction(CMD,'readwrite');tx.objectStore(CMD).put({...claimed,attemptToken:replacement});await f.complete(tx);
  const stored=await raw();let parsed:unknown=null,parseError='';try{parsed=f.legacy.parseCrossJobRecord(stored);}catch(error){parseError=error instanceof Error?error.message:'unknown';}
  const injected=await f.census(db),first=await reason(()=>f.storage.settleCrossJobClaimV4(db,ticket,ctx,null,null)),second=await reason(()=>f.storage.settleCrossJobClaimV4(db,ticket,ctx,null,null));local.forfeit();
  const evidence=await f.storage.readAttemptEvidenceV1(db,o.command.commandId,ctx),after=await f.census(db),witnessAfter={commandId:ticket.command.commandId,token:ticket.token,command:JSON.stringify(ticket.command)};db.close();
  return {witness,witnessAfter,admitted,invoked,claimed,replacement,parsed,parseError,injected,first,second,evidence,after,original:o};
 });
 expect(result.admitted).toBe(true);expect(result.invoked).toBe(false);expect(result.claimed).toMatchObject({everAttempted:true,attemptToken:result.witness.token,revision:1,hold:null,historical:null});expect(result.replacement).not.toBe(result.witness.token);
 expect(result.parseError).toBe('');expect(result.parsed).toEqual({...result.claimed,attemptToken:result.replacement});expect((result.parsed as {original:unknown}).original).toEqual(result.original);
 expect(result.first).toBe('claim_conflict');expect(result.second).toBe('claim_capability_missing');expect(result.after).toEqual(result.injected);expect(result.evidence).toEqual({kind:'not_recorded'});
 expect(result.injected.stores.find(s=>s.name==='cross_job_attempt_evidence_v1')?.rows).toEqual([]);expect(result.witnessAfter).toEqual(result.witness);expect(result.witness.commandId).toBe(result.original.command.commandId);
});
test('AE4 key-reordered command with recomputed bytes parses but private original binding refuses settlement',async({page})=>{
 await fixture(page);const result=await page.evaluate(async()=>{
  const f=window.attemptFixture,db=await f.open(),o=f.values.genesis(),ctx=f.context(),CMD=f.storage.CROSS_JOB_COMMANDS;await f.storage.appendCrossJobOriginalV4(db,o,ctx);
  const ticket=await f.storage.claimCrossJobOriginalV4(db,o.command.commandId,f.values.id(70),ctx,f.admission(o));if(!ticket)throw Error('missing claim');
  const local=f.storage.consumeCrossJobSendV4(db,ticket),ready=await f.storage.prepareCrossJobSendCheckV4(db,ticket,ctx),admitted=ready(f.admission(o)),invoked=local.invocationStarted();
  const raw=async()=>{const tx=db.transaction(CMD,'readonly'),done=f.complete(tx);const [value]=await Promise.all([f.get(tx.objectStore(CMD).get(o.command.commandId)),done]);return value;};
  const reason=async(run:()=>unknown)=>{try{await run();return 'resolved';}catch(error){return error instanceof f.legacy.JournalV3Error?error.reason:`other:${error instanceof Error?error.message:typeof error}`;}};
  const reorder=(v:unknown):unknown=>Array.isArray(v)?v.map(reorder):v!==null&&typeof v==='object'?Object.fromEntries(Object.entries(v).reverse().map(([k,x])=>[k,reorder(x)])):v;
  const claimed=await raw(),command=reorder(claimed.original.command),commandBytes=JSON.stringify(command),tx=db.transaction(CMD,'readwrite');tx.objectStore(CMD).put({...claimed,original:{...claimed.original,command,commandBytes}});await f.complete(tx);
  const stored=await raw();let parsed:ReturnType<typeof f.legacy.parseCrossJobRecord>|null=null,parseError='';try{parsed=f.legacy.parseCrossJobRecord(stored);}catch(error){parseError=error instanceof Error?error.message:'unknown';}
  const semantic=parsed!==null&&JSON.stringify(f.predictAllocation(parsed.original.command,'noop'))===JSON.stringify(f.predictAllocation(o.command,'noop'));
  const injected=await f.census(db),first=await reason(()=>f.storage.settleCrossJobClaimV4(db,ticket,ctx,null,null)),second=await reason(()=>f.storage.settleCrossJobClaimV4(db,ticket,ctx,null,null));local.forfeit();
  const evidence=await f.storage.readAttemptEvidenceV1(db,o.command.commandId,ctx),after=await f.census(db);db.close();
  return {admitted,invoked,claimed,stored,parsed,parseError,semantic,commandBytes,originalKeys:Object.keys(o.command),storedKeys:parsed?Object.keys(parsed.original.command):[],injected,first,second,evidence,after,original:o,token:ticket.token};
 });
 expect(result.admitted).toBe(true);expect(result.invoked).toBe(false);expect(result.claimed).toMatchObject({everAttempted:true,attemptToken:result.token,revision:1,hold:null,historical:null});expect(result.claimed.original).toEqual(result.original);
 expect(result.parseError).toBe('');expect(result.semantic).toBe(true);expect(result.commandBytes).not.toBe(result.original.commandBytes);expect(result.storedKeys).toEqual([...result.originalKeys].reverse());
 expect(result.parsed).toMatchObject({commandId:result.original.command.commandId,everAttempted:true,attemptToken:result.token,revision:1,hold:null,historical:null,original:{commandBytes:result.commandBytes}});expect(result.parsed).toEqual(result.stored);
 expect(result.first).toBe('claim_conflict');expect(result.second).toBe('claim_capability_missing');expect(result.after).toEqual(result.injected);expect(result.evidence).toEqual({kind:'not_recorded'});
 expect(result.injected.stores.find(s=>s.name==='cross_job_attempt_evidence_v1')?.rows).toEqual([]);
});
test('AE4 actual page reload loses the consumed V4 capability; reconstructed ticket is refused everywhere',async({page})=>{
 await fixture(page);const witness=await page.evaluate(async()=>{
  const f=window.attemptFixture,db=await f.open(),o=f.values.genesis(),ctx=f.context();await f.storage.appendCrossJobOriginalV4(db,o,ctx);
  const ticket=await f.storage.claimCrossJobOriginalV4(db,o.command.commandId,f.values.id(70),ctx,f.admission(o));if(!ticket)throw Error('missing claim');
  // Genuine live capability before reload: consumed and admissible, never invoked or settled.
  const local=f.storage.consumeCrossJobSendV4(db,ticket),ready=await f.storage.prepareCrossJobSendCheckV4(db,ticket,ctx),admitted=ready(f.admission(o)),invoked=local.invocationStarted();
  const row=await f.storage.readCrossJobOriginalV4(db,o.command.commandId,ctx),evidence=await f.storage.readAttemptEvidenceV1(db,o.command.commandId,ctx),census=await f.census(db);
  Object.assign(window,{ae4ReloadMarker:ticket.token});return {token:ticket.token,command:ticket.command,admitted,invoked,row,evidence,census};
 });
 await page.reload();await page.evaluate(async()=>{
  // @ts-expect-error Isolated local Vite test module only.
  window.attemptFixture=await import('/e2e/support/crossJobAttemptEvidenceHarness.ts');
 });
 const result=await page.evaluate(async w=>{
  const navigation=(performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming|undefined)?.type??null,markerSurvived=Object.hasOwn(window,'ae4ReloadMarker');
  const f=window.attemptFixture;f.login();const db=await f.open(),o=f.values.genesis(),ctx=f.context(),ticket={command:w.command,token:w.token};
  const reason=async(run:()=>unknown)=>{try{await run();return 'resolved';}catch(error){return error instanceof f.legacy.JournalV3Error?error.reason:`other:${error instanceof Error?error.message:typeof error}`;}};
  const before=await f.census(db),consume=await reason(()=>f.storage.consumeCrossJobSendV4(db,ticket)),prepare=await reason(()=>f.storage.prepareCrossJobSendCheckV4(db,ticket,ctx)),settle=await reason(()=>f.storage.settleCrossJobClaimV4(db,ticket,ctx,null,null));
  let loads=0,remote=0;const api=f.api.createActivityTransportV3(async()=>{loads++;return {getSession:async()=>{remote++;return {data:{session:{access_token:'fixture-token',user:{id:o.command.ownerId}}},error:null};},clientWithToken:()=>({rpc:()=>{remote++;return Promise.resolve({data:null,error:null});}})};});
  const answer=await api.submitClaim(db,ticket,{context:ctx,clock:()=>({elapsedMs:0,serverNow:o.anchor.asOf})});
  const row=await f.storage.readCrossJobOriginalV4(db,o.command.commandId,ctx),evidence=await f.storage.readAttemptEvidenceV1(db,o.command.commandId,ctx),claim=await f.storage.claimCrossJobOriginalV4(db,o.command.commandId,f.values.id(71),ctx,f.admission(o)),after=await f.census(db);db.close();
  return {navigation,markerSurvived,before,consume,prepare,settle,loads,remote,answer,row,evidence,claim,after,original:o};
 },witness);
 expect(witness.admitted).toBe(true);expect(witness.invoked).toBe(false);expect(witness.row).toMatchObject({everAttempted:true,attemptToken:witness.token,revision:1,hold:null,historical:null});expect(witness.evidence).toEqual({kind:'not_recorded'});
 expect(result.navigation).toBe('reload');expect(result.markerSurvived).toBe(false);expect(result.before).toEqual(witness.census);expect(witness.command).toEqual(result.original.command);
 expect(result.consume).toBe('send_capability_missing');expect(result.prepare).toBe('send_capability_missing');expect(result.settle).toBe('claim_capability_missing');
 expect(result.answer).toEqual({kind:'not_sent',reason:'send_capability_missing',record:null});expect(result.loads).toBe(0);expect(result.remote).toBe(0);
 expect(result.row).toEqual(witness.row);expect(result.row?.original).toEqual(result.original);expect(result.evidence).toEqual({kind:'not_recorded'});expect(result.claim).toBeNull();expect(result.after).toEqual(result.before);
});

// Source checkpoint 5: three bounded AE5 controls; the original 48 cases above remain exact.
// One V4 lifetime and a synthetic same-store version5 upgrade only: no old V3,
// released client, authentication, provider or future V5 schema claim. A late
// caller-visible reply is permitted; settlement and evidence cannot follow it.
for(const mode of ['receipt','23514','42501'] as const)test(`AE5 late ${mode} reply after real versionchange cannot settle or mint evidence`,async({page})=>{
 await fixture(page);const result=await page.evaluate(async mode=>{
  const f=window.attemptFixture;f.login();const db=await f.open(),o=f.values.genesis(),ctx=f.context(),CMD=f.storage.CROSS_JOB_COMMANDS;await f.storage.appendCrossJobOriginalV4(db,o,ctx);
  const ticket=await f.storage.claimCrossJobOriginalV4(db,o.command.commandId,f.values.id(70),ctx,f.admission(o));if(!ticket)throw Error('missing claim');
  const claimed=await f.storage.readCrossJobOriginalV4(db,o.command.commandId,ctx),predicted=f.predictAllocation(o.command,o.prediction.status),proof=f.values.submission(predicted);
  type Reply={data:unknown;error:{code:string}|null};
  const events:string[]=[],calls:string[]=[],expectedWire=JSON.stringify({p_command_id:o.command.commandId,p_protocol_version:2,p_payload:o.command.payload});
  let loads=0,authCalls=0,wire='',commandsAtEntry=-1,started!:()=>void,release!:(value:Reply)=>void;
  const entered=new Promise<void>(resolve=>{started=resolve;}),pending=new Promise<Reply>(resolve=>{release=resolve;});
  const api=f.api.createActivityTransportV3(async()=>{loads++;return {getSession:async()=>{authCalls++;return {data:{session:{access_token:'fixture-token',user:{id:o.command.ownerId}}},error:null};},clientWithToken:()=>({rpc:(name,args)=>{
   calls.push(name);if(name==='work_cross_job_snapshot')return Promise.resolve({data:o.anchor,error:null});
   // The success path's existing read-only receipt lookup is allowed after the upgrade.
   if(name==='work_cross_job_receipt')return Promise.resolve({data:f.values.lookup(predicted),error:null});
   if(name!=='work_activity_command')throw Error('unexpected RPC');wire=JSON.stringify(args);commandsAtEntry=calls.filter(c=>c===name).length;events.push('command-entered');started();return pending;
  }})};});
  const env={context:ctx,clock:()=>({elapsedMs:0,serverNow:o.anchor.asOf})};
  const submitted=api.submitClaim(db,ticket,env).then(answer=>{events.push('adapter-resolved');return answer;});
  await entered;const before=await f.census(db);
  // Observe without replacing the production onversionchange handler.
  const productionHandlerRetained=typeof db.onversionchange==='function';db.addEventListener('versionchange',()=>events.push('versionchange'));
  const newer=await new Promise<IDBDatabase>((resolve,reject)=>{const r=indexedDB.open(f.storage.CROSS_JOB_DB_NAME,5);r.onblocked=()=>events.push('blocked');r.onsuccess=()=>{events.push('upgrade-complete');resolve(r.result);};r.onerror=()=>reject(r.error);});
  let oldRefuses=false;try{db.transaction(CMD,'readonly');}catch{oldRefuses=true;}
  events.push('reply-released');release(mode==='receipt'?{data:proof.reply,error:null}:{data:null,error:{code:mode}});const answer=await submitted;
  const late={calls:[...calls],loads,authCalls};
  const reason=async(run:()=>unknown)=>{try{await run();return 'resolved';}catch(error){return error instanceof f.legacy.JournalV3Error?error.reason:`other:${error instanceof Error?error.message:typeof error}`;}};
  const consume=await reason(()=>f.storage.consumeCrossJobSendV4(db,ticket)),prepare=await reason(()=>f.storage.prepareCrossJobSendCheckV4(db,ticket,ctx)),settle=await reason(()=>f.storage.settleCrossJobClaimV4(db,ticket,ctx,null,null)),again=await api.submitClaim(db,ticket,env);
  const after=await f.census(newer),row=after.stores.find(s=>s.name===CMD)?.rows.find(r=>r.commandId===o.command.commandId);newer.close();
  return {events,productionHandlerRetained,oldRefuses,wire,expectedWire,commandsAtEntry,answer,late,repeat:{calls:[...calls],loads,authCalls},consume,prepare,settle,again,before,after,row,claimed,reply:proof.reply,original:o,token:ticket.token};
 },mode);
 expect(result.events).toEqual(['command-entered','versionchange','upgrade-complete','reply-released','adapter-resolved']);expect(result.productionHandlerRetained).toBe(true);expect(result.oldRefuses).toBe(true);
 expect(result.commandsAtEntry).toBe(1);expect(result.wire).toBe(result.expectedWire);
 expect(result.late).toEqual({calls:mode==='receipt'?['work_cross_job_snapshot','work_activity_command','work_cross_job_receipt']:['work_cross_job_snapshot','work_activity_command'],loads:1,authCalls:1});
 expect(result.answer).toEqual(mode==='receipt'?{kind:'receipt',reply:result.reply,record:null}:{kind:'unknown',record:null,sqlState:mode});
 expect(result.consume).toBe('send_capability_missing');expect(result.prepare).toBe('send_capability_missing');expect(result.settle).toBe('claim_capability_missing');
 expect(result.again).toEqual({kind:'not_sent',reason:'send_capability_missing',record:null});expect(result.repeat).toEqual(result.late);
 expect(result.claimed).toMatchObject({everAttempted:true,attemptToken:result.token,revision:1,hold:null,historical:null});expect(result.claimed?.original).toEqual(result.original);
 expect(result.before.version).toBe(4);expect(result.after.version).toBe(5);expect(result.after.stores).toEqual(result.before.stores);expect(result.row).toEqual(result.claimed);
 expect(result.after.stores.find(s=>s.name==='cross_job_attempt_evidence_v1')?.rows).toEqual([]);
});
