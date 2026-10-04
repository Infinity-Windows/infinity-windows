import { expect, test as base, chromium, webkit, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const test=base.extend<{journalPage:Page}>({journalPage:async({browserName},fixtureReady)=>{
  let browser:Browser|undefined,context:BrowserContext|undefined,dir:string|undefined;
  try{
    if(browserName==='webkit'){dir=mkdtempSync(join(tmpdir(),'activity-protocol-webkit-'));context=await webkit.launchPersistentContext(dir,{headless:true});}
    else{browser=await chromium.launch({headless:true});context=await browser.newContext();}
    await fixtureReady(context.pages()[0]??await context.newPage());
  }finally{await context?.close();await browser?.close();if(dir)rmSync(dir,{recursive:true,force:true});}
}});
async function fixture(page:Page){
  await page.route('**/activity-protocol-fixture',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><html><body>Native protocol journal fixture</body></html>'}));
  await page.route(/^https:\/\//,route=>route.abort());
  await page.goto('/activity-protocol-fixture');
}
test('native v1 upgrade preserves original rows and payroll/photo bytes, while generations get independent sequence zero',async({journalPage:page})=>{
  await fixture(page);
  const result=await page.evaluate(async()=>{
    const id=(n:number)=>`00000000-0000-0000-0000-${String(n).padStart(12,'0')}`;
    const raw={command:{encodingVersion:1,requestId:id(90),ownerId:id(1),deviceId:id(2),clientGeneration:id(91),sequence:0,predecessorRequestId:null,expectedRevision:0,shiftRef:'opaque old shift',intent:{scope:'general',projectRef:'old project',activityRef:'old activity',menuRevision:'old menu',unitRef:null},tapAt:'2026-10-03T12:00:00.000Z',observedServerEvidence:'old observation'},receipt:null};
    const head={streamKey:`${id(1)}:${id(2)}`,ownerId:id(1),deviceId:id(2),clientGeneration:id(91),sequence:0,headRequestId:id(90)};
    const old=await new Promise<IDBDatabase>((resolve,reject)=>{const r=indexedDB.open('iw-work-capture-journal-v1',1);r.onupgradeneeded=()=>{const c=r.result.createObjectStore('commands',{keyPath:'command.requestId'});c.createIndex('by_stream',['command.ownerId','command.deviceId','command.sequence'],{unique:true});r.result.createObjectStore('heads',{keyPath:'streamKey'});};r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
    const seed=old.transaction(['commands','heads'],'readwrite');seed.objectStore('commands').add(raw);seed.objectStore('heads').add(head);await new Promise<void>((resolve,reject)=>{seed.oncomplete=()=>resolve();seed.onabort=()=>reject(seed.error);});old.close();
    const photos=await new Promise<IDBDatabase>((resolve,reject)=>{const r=indexedDB.open('wops-write-outbox',2);r.onupgradeneeded=()=>{r.result.createObjectStore('entries',{keyPath:'id'});r.result.createObjectStore('metadata',{keyPath:'id'});};r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
    const p=photos.transaction(['entries','metadata'],'readwrite');p.objectStore('entries').add({id:'photo',blob:new Blob([new Uint8Array([0,1,254,255])],{type:'image/png'}),meta:'original photo owner/tap'});p.objectStore('entries').add({id:'clock',meta:'original keyed payroll clock request'});p.objectStore('metadata').add({id:'original',meta:'keep'});await new Promise<void>((resolve,reject)=>{p.oncomplete=()=>resolve();p.onabort=()=>reject(p.error);});
    // @ts-expect-error Browser Vite module URL.
    const journal=await import('/src/lib/workActivity/journal.ts');
    const payload={deviceId:id(2),clientGeneration:id(3),clientSequence:0,predecessorCommandId:null,expectedRevision:0,basis:{observationId:id(4)},shiftRef:null,tappedAt:'2026-10-04T00:00:00.123456Z',clockCheckedAt:null,clockSkewMs:null,intent:{kind:'establish_stream',previousGeneration:null,previousHeadCommandId:null}};
    const first=await journal.appendActivityCommand({ownerId:id(1),commandId:id(5),payload});
    await journal.markActivityAttempt(id(1),id(2),id(5),payload);
    const fresh={...payload,clientGeneration:id(6),intent:{kind:'establish_stream',previousGeneration:id(3),previousHeadCommandId:id(5)}};
    const second=await journal.appendActivityCommand({ownerId:id(1),commandId:id(7),payload:fresh});
    const retired=await journal.getActivityDispatchReadiness(id(1),id(2),id(5));
    const original=await journal.getActivityCommand(id(1),id(2),id(5));
    const db=await new Promise<IDBDatabase>((resolve,reject)=>{const r=indexedDB.open('iw-work-capture-journal-v1',2);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
    const read=db.transaction(['commands','heads'],'readonly');const c=read.objectStore('commands').get(id(90)),h=read.objectStore('heads').get(head.streamKey);let saved:any,savedHead:any;c.onsuccess=()=>saved=c.result;h.onsuccess=()=>savedHead=h.result;await new Promise<void>((resolve,reject)=>{read.oncomplete=()=>resolve();read.onabort=()=>reject(read.error);});
    const r=photos.transaction(['entries','metadata'],'readonly');const rows=r.objectStore('entries').getAll(),meta=r.objectStore('metadata').getAll();let entries:any[],metadata:any[];rows.onsuccess=()=>entries=rows.result;meta.onsuccess=()=>metadata=meta.result;await new Promise<void>((resolve,reject)=>{r.oncomplete=()=>resolve();r.onabort=()=>reject(r.error);});
    const bytes=Array.from(new Uint8Array(await entries!.find(x=>x.id==='photo').blob.arrayBuffer()));
    const output={version:db.version,legacyIntact:JSON.stringify(raw)===JSON.stringify(saved)&&JSON.stringify(head)===JSON.stringify(savedHead),firstSequence:first.payload.clientSequence,secondSequence:second.payload.clientSequence,retired,originalUncertain:original.uncertain,photoVersion:photos.version,bytes,entries:entries!.map(x=>({id:x.id,meta:x.meta})),metadata:metadata!};db.close();photos.close();return output;
  });
  expect(result).toEqual({version:2,legacyIntact:true,firstSequence:0,secondSequence:0,retired:{ready:false,reason:'retired_generation'},originalUncertain:true,photoVersion:2,bytes:[0,1,254,255],entries:[{id:'clock',meta:'original keyed payroll clock request'},{id:'photo',meta:'original photo owner/tap'}],metadata:[{id:'original',meta:'keep'}]});
});
test('unknown predecessor, unavailable receipt and local-envelope drift never settle or unblock a descendant',async({journalPage:page})=>{
  await fixture(page);
  const result=await page.evaluate(async()=>{
    // @ts-expect-error Browser Vite module URL.
    const j=await import('/src/lib/workActivity/journal.ts');
    const id=(n:number)=>`00000000-0000-0000-0000-${String(n).padStart(12,'0')}`;
    const p={deviceId:id(2),clientGeneration:id(3),clientSequence:0,predecessorCommandId:null,expectedRevision:0,basis:{observationId:id(4)},shiftRef:null,tappedAt:'2026-10-04T00:00:00.123456Z',clockCheckedAt:null,clockSkewMs:null,intent:{kind:'establish_stream',previousGeneration:null,previousHeadCommandId:null}};
    await j.appendActivityCommand({ownerId:id(1),commandId:id(5),payload:p});await j.markActivityAttempt(id(1),id(2),id(5),p);
    const child={...p,clientSequence:1,predecessorCommandId:id(5),shiftRef:{kind:'shift',id:id(7)},intent:{kind:'stop'}};
    await j.appendActivityCommand({ownerId:id(1),commandId:id(6),payload:child});
    const blocked=await j.getActivityDispatchReadiness(id(1),id(2),id(6));
    const unchanged=await j.recordActivityReceipt(id(1),id(2),id(5),p,{protocolVersion:1,availability:'unavailable',receipt:null});
    const reply={protocolVersion:1,availability:'available',receipt:{protocolVersion:1,commandId:id(5),status:'noop',reasonCode:null,beforeRevision:0,afterRevision:0,transitionId:null,effectiveAt:null}};
    let driftRejected=false;try{await j.recordActivityReceipt(id(1),id(2),id(5),{...p,expectedRevision:1},reply);}catch{driftRejected=true;}
    await j.recordActivityReceipt(id(1),id(2),id(5),p,reply);
    const ready=await j.getActivityDispatchReadiness(id(1),id(2),id(6));
    let contradictoryRejected=false;try{await j.recordActivityReceipt(id(1),id(2),id(5),p,{...reply,receipt:{...reply.receipt,status:'refused',reasonCode:'state_changed'}});}catch{contradictoryRejected=true;}
    const foreign=await j.getActivityCommand(id(99),id(2),id(5));
    return {blocked,stillUncertain:unchanged.uncertain,driftRejected,ready,contradictoryRejected,foreign};
  });
  expect(result).toEqual({blocked:{ready:false,reason:'predecessor_unknown'},stillUncertain:true,driftRejected:true,ready:{ready:true},contradictoryRejected:true,foreign:null});
});
test('a native late abort rolls back command and head before the save promise can resolve',async({journalPage:page})=>{
  await fixture(page);
  const result=await page.evaluate(async()=>{
    // @ts-expect-error Browser Vite module URL.
    const j=await import('/src/lib/workActivity/journal.ts');
    // @ts-expect-error Browser Vite module URL.
    const storage=await import('/src/lib/workCapture/storage.ts');
    const id=(n:number)=>`00000000-0000-0000-0000-${String(n).padStart(12,'0')}`;
    const db=await storage.openWorkJournal(indexedDB);db.close();
    const original=IDBObjectStore.prototype.add;let injected=false;
    IDBObjectStore.prototype.add=function(...args:Parameters<typeof original>){const request=original.apply(this,args);if(this.name==='protocol_commands'){request.addEventListener('success',()=>{injected=true;this.transaction.abort();},{once:true});}return request;};
    let rejected=false;
    try{await j.appendActivityCommand({ownerId:id(1),commandId:id(5),payload:{deviceId:id(2),clientGeneration:id(3),clientSequence:0,predecessorCommandId:null,expectedRevision:0,basis:{observationId:id(4)},shiftRef:null,tappedAt:'2026-10-04T00:00:00.123456Z',clockCheckedAt:null,clockSkewMs:null,intent:{kind:'establish_stream',previousGeneration:null,previousHeadCommandId:null}}});}catch{rejected=true;}finally{IDBObjectStore.prototype.add=original;}
    const row=await j.getActivityCommand(id(1),id(2),id(5));
    const inspect=await storage.openWorkJournal(indexedDB);const tx=inspect.transaction('protocol_heads','readonly'),r=tx.objectStore('protocol_heads').count();let count=0;r.onsuccess=()=>count=r.result;await new Promise<void>((resolve,reject)=>{tx.oncomplete=()=>resolve();tx.onabort=()=>reject(tx.error);});inspect.close();
    return {injected,rejected,row,count};
  });
  expect(result).toEqual({injected:true,rejected:true,row:null,count:0});
});
test('independent same-origin tabs admit one successor for the exact reread head',async({journalPage:page})=>{
  await fixture(page);const second=await page.context().newPage();await fixture(second);
  try{
    await page.evaluate(async()=>{
      // @ts-expect-error Browser Vite module URL.
      const j=await import('/src/lib/workActivity/journal.ts');const id=(n:number)=>`00000000-0000-0000-0000-${String(n).padStart(12,'0')}`;
      await j.appendActivityCommand({ownerId:id(1),commandId:id(5),payload:{deviceId:id(2),clientGeneration:id(3),clientSequence:0,predecessorCommandId:null,expectedRevision:0,basis:{observationId:id(4)},shiftRef:null,tappedAt:'2026-10-04T00:00:00.123456Z',clockCheckedAt:null,clockSkewMs:null,intent:{kind:'establish_stream',previousGeneration:null,previousHeadCommandId:null}}});
    });
    const race=(p:Page,n:number)=>p.evaluate(async(n)=>{
      // @ts-expect-error Browser Vite module URL.
      const j=await import('/src/lib/workActivity/journal.ts');const id=(n:number)=>`00000000-0000-0000-0000-${String(n).padStart(12,'0')}`;
      try{const r=await j.appendActivityCommand({ownerId:id(1),commandId:id(n),payload:{deviceId:id(2),clientGeneration:id(3),clientSequence:1,predecessorCommandId:id(5),expectedRevision:0,basis:{observationId:id(4)},shiftRef:{kind:'shift',id:id(7)},tappedAt:'2026-10-04T00:00:00.123456Z',clockCheckedAt:null,clockSkewMs:null,intent:{kind:'stop'}}});return{saved:true,sequence:r.payload.clientSequence};}catch{return{saved:false,sequence:null};}
    },n);
    const results=await Promise.all([race(page,6),race(second,8)]);
    expect(results.filter(x=>x.saved)).toEqual([{saved:true,sequence:1}]);expect(results.filter(x=>!x.saved)).toHaveLength(1);
  }finally{await second.close();}
});

test('the exact uncertain protocol head survives page reload without dispatch or legacy conversion',async({journalPage:page})=>{
  await fixture(page);
  const saved=await page.evaluate(async()=>{
    // @ts-expect-error Browser Vite module URL.
    const j=await import('/src/lib/workActivity/journal.ts');
    const id=(n:number)=>`00000000-0000-0000-0000-${String(n).padStart(12,'0')}`;
    const payload={deviceId:id(2),clientGeneration:id(3),clientSequence:0,predecessorCommandId:null,expectedRevision:0,basis:{observationId:id(4)},shiftRef:null,tappedAt:'2026-10-04T00:00:00.123456Z',clockCheckedAt:null,clockSkewMs:null,intent:{kind:'establish_stream',previousGeneration:null,previousHeadCommandId:null}};
    await j.appendActivityCommand({ownerId:id(1),commandId:id(5),payload});return j.markActivityAttempt(id(1),id(2),id(5),payload);
  });
  await page.reload();
  const restored=await page.evaluate(async()=>{
    // @ts-expect-error Browser Vite module URL.
    const j=await import('/src/lib/workActivity/journal.ts');
    const id=(n:number)=>`00000000-0000-0000-0000-${String(n).padStart(12,'0')}`;
    return {head:await j.getCurrentActivityCommand(id(1),id(2)),foreign:await j.getCurrentActivityCommand(id(99),id(2))};
  });
  expect(restored).toEqual({head:saved,foreign:null});expect(restored.head.uncertain).toBe(true);
});
