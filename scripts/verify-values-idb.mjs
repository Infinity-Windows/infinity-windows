// Real browser DB2 compatibility and atomic ACK regressions. Synthetic receipt tests
// local store identity only; handler/SQL fixtures verify the full receipt contract.
// Run from monthly-values-reviews with Node22. Uses only installed packages.
import fs from 'node:fs'; import {createRequire} from 'node:module';
const req=createRequire(process.cwd()+'/app/package.json'); const ts=req('typescript'); const {chromium,webkit}=req('playwright');
const transpile=p=>ts.transpileModule(fs.readFileSync(p,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;
const code={core:transpile('app/src/lib/offline/outbox-core.ts'),store:transpile('app/src/lib/offline/outboxStore.ts'),auth:transpile('app/src/lib/signedIn.ts'),legacy:transpile('scripts/fixtures/outbox-store-v2-baseline.ts')};
const browser=await (process.argv.includes('--webkit')?webkit:chromium).launch({headless:true}); const page=await browser.newPage(); await page.route('http://localhost:44448/',r=>r.fulfill({contentType:'text/html',body:'fixture'})); await page.goto('http://localhost:44448');
try { console.log(JSON.stringify(await page.evaluate(async code=>{
 const url=s=>URL.createObjectURL(new Blob([s],{type:'text/javascript'})); const coreUrl=url(code.core),authUrl=url(code.auth);
 const core=await import(coreUrl),auth=await import(authUrl),storage=await import(url(code.store.replace('"./outbox-core"',JSON.stringify(coreUrl)).replace('"../signedIn"',JSON.stringify(authUrl))));
 const store=new storage.IndexedDbOutboxStore(); const owner='owner-a'; auth.rememberSignedIn({user:{id:owner}});
 const entry=core.makeEntry({op:'values_submit',ownerId:owner,payload:{assignmentId:'assignment',requestId:'request',rubricVersion:1,digest:'a'.repeat(64)}},'request',1);
 const draft={id:owner+':assignment',ownerId:owner,assignmentId:'assignment',requestId:'request',rubricVersion:1,digest:'a'.repeat(64),scores:{fullsend:7},comment:'',status:'queued',updatedAt:1};
 const receipt={receipt:{encodingVersion:'forge-values-submit/v1',...entry.payload}};
 await store.put(entry); await store.putValuesDraft(draft);
 const result={}; const assert=(truth,label)=>{if(!truth)throw Error(label)};
 const retained=async()=>{assert((await store.getAll()).length===1,'queue retained');assert((await store.getValuesDraft(owner,'assignment')).status==='queued','draft retained');};
 const bounce=()=>{auth.rememberSignedIn({user:{id:'owner-b'}});auth.rememberSignedIn({user:{id:owner}})};
 const context=()=>{const mark=auth.signInMark();return {canCommit:()=>auth.stillSignedInAs(mark,owner)}};
 const safeAck=async ctx=>{try{return await store.acknowledgeValues(entry,receipt,ctx)}catch(e){return 'rejected:'+e.message}};
 const originalGet=IDBObjectStore.prototype.get;
 IDBObjectStore.prototype.get=function(...args){const r=originalGet.apply(this,args);if(this.name==='metadata'&&String(args[0]).startsWith('values-draft/v1/'))r.addEventListener('success',bounce,{once:true});return r};
 result.accountBounceBeforeCallback=await safeAck(context()); IDBObjectStore.prototype.get=originalGet; await retained();
 const originalPut=IDBObjectStore.prototype.put;
 IDBObjectStore.prototype.put=function(...args){const r=originalPut.apply(this,args);if(this.name==='metadata'&&String(args[0]?.id).startsWith('values-draft/v1/')&&JSON.parse(args[0].meta).status==='accepted')r.addEventListener('success',bounce,{once:true});return r};
 result.accountBounceBeforeCommit=await safeAck(context()); IDBObjectStore.prototype.put=originalPut; await retained();
 const controller=new AbortController(); const ctx={...context(),signal:controller.signal};
 IDBObjectStore.prototype.put=function(...args){const r=originalPut.apply(this,args);if(this.name==='metadata'&&String(args[0]?.id).startsWith('values-draft/v1/')&&JSON.parse(args[0].meta).status==='accepted')r.addEventListener('success',()=>controller.abort(),{once:true});return r};
 result.abortAfterAcceptedWrite=await safeAck(ctx); IDBObjectStore.prototype.put=originalPut; await retained();
 const stale={...entry,attemptCount:2}; await store.put(stale); result.staleCAS=await safeAck(context()); assert(result.staleCAS===false,'stale CAS false'); await retained(); await store.put(entry);
 result.commit=await safeAck(context()); assert(result.commit===true,'commit true'); assert((await store.getAll()).length===0,'queue deleted');assert((await store.getValuesDraft(owner,'assignment')).status==='accepted','receipt committed');
 class Hung extends storage.MemoryOutboxStore{async acknowledgeValues(){return new Promise(()=>{})}} const hung=new Hung(); await hung.put(entry);await hung.put(core.makeEntry({op:'photo_upload',ownerId:owner,payload:{}},'photo',2));
 const order=[]; const timer=setTimeout(()=>hung.put(core.makeEntry({op:'clock_in',ownerId:owner,payload:{}},'clock',3)),5);
 result.hungAck=await core.drainUntilSettled(hung,{values_submit:async()=>receipt,photo_upload:async()=>{order.push('photo')},clock_in:async()=>{order.push('clock')}},{now:100,sendDeadlineMs:()=>30});clearTimeout(timer);
 result.order=order; assert(order.join(',')==='clock,photo','clock/photo drain ordering');assert((await hung.getAll()).some(e=>e.id==='request'),'hung review retained');assert(result.hungAck.sent===2&&result.hungAck.retried===1,'watchdog result');

 const legacy=await import(url(code.legacy.replace('"./outbox-core"',JSON.stringify(coreUrl))));
 const oldStore=new legacy.IndexedDbOutboxStore();
 const photo=core.makeEntry({op:'photo_upload',ownerId:owner,payload:{}},'retained-photo',4);
 await store.put(photo,new Blob(['original photo bytes'],{type:'image/jpeg'}));
 const oldRows=await oldStore.getAll();assert(oldRows.length===1&&oldRows[0].id===photo.id,'legacy does not queue private metadata');
 assert(await (await oldStore.getBlob(photo.id)).text()==='original photo bytes','legacy photo bytes retained');
 assert(await oldStore.swap(photo.id,photo,{...photo,attemptCount:1}),'legacy swap works');
 const oldClock=core.makeEntry({op:'clock_in',ownerId:owner,payload:{}},'old-clock',5);await oldStore.put(oldClock);
 const oldOrder=[];const oldDrain=await core.drainUntilSettled(oldStore,{clock_in:async()=>{oldOrder.push('clock')},photo_upload:async()=>{oldOrder.push('photo')}},{now:100});
 assert(oldDrain.sent===2&&oldOrder.join(',')==='clock,photo','legacy queue drains after new review ACK');
 assert((await store.getValuesDraft(owner,'assignment')).status==='accepted','legacy drain preserves receipt');
 const db=await new Promise((resolve,reject)=>{const r=indexedDB.open('wops-write-outbox',2);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)});assert(db.version===2,'new draft does not upgrade production DB');db.close();result.legacyDB2='PASS';
 // A prior unreleased developer DB3 is preserved and migrated without deletion.
 const upgrade=await new Promise((resolve,reject)=>{const r=indexedDB.open('wops-write-outbox',3);r.onupgradeneeded=()=>r.result.createObjectStore('values_drafts',{keyPath:'id'});r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)});
 const dev={...draft,id:'owner-a:dev-assignment',assignmentId:'dev-assignment',requestId:'dev-request',status:'editing'};
 await new Promise((resolve,reject)=>{const tx=upgrade.transaction('values_drafts','readwrite');tx.objectStore('values_drafts').put(dev);tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error)});upgrade.close();
 await store.put(photo,new Blob(['dev photo bytes']));assert((await store.getValuesDraft(owner,'dev-assignment')).requestId==='dev-request','developer draft migrated');assert(await (await store.getBlob(photo.id)).text()==='dev photo bytes','developer photo preserved');
 result.unreleasedDB3='PASS';return result;
},code),null,2)); } finally {await browser.close()}
