// Real browser DB2 compatibility and atomic ACK regressions. Synthetic receipts
// check local store identity; handler/SQL fixtures verify the full contract.
// Serve normal ESM from a real loopback origin, as the app does. No intercepted
// origin, blob: module loader, production service or review content in logs.
import fs from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
const req = createRequire(process.cwd() + '/app/package.json');
const ts = req('typescript');
const { chromium, webkit } = req('playwright');
const engine = process.argv.includes('--webkit') ? 'webkit' : 'chromium';
const transpile = p => ts.transpileModule(fs.readFileSync(p, 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText;
const routes = new Map([
  ['/', ['text/html', '<!doctype html><meta charset="utf-8"><title>Values IDB fixture</title>']],
  ['/core.js', ['text/javascript', transpile('app/src/lib/offline/outbox-core.ts')]],
  ['/auth.js', ['text/javascript', transpile('app/src/lib/signedIn.ts')]],
  ['/store.js', ['text/javascript', transpile('app/src/lib/offline/outboxStore.ts')
    .replace('"./outbox-core"', '"./core.js"').replace('"../signedIn"', '"./auth.js"')]],
  ['/legacy.js', ['text/javascript', transpile('scripts/fixtures/outbox-store-v2-baseline.ts')
    .replace('"./outbox-core"', '"./core.js"')]],
]);
const server = http.createServer((request, response) => {
  const route = routes.get(new URL(request.url, 'http://127.0.0.1').pathname);
  if (!route) { response.writeHead(404); response.end(); return; }
  response.writeHead(200, { 'Content-Type': route[0] + '; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(route[1]);
});
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
let browser;
let page;
try {
  browser = await (engine === 'webkit' ? webkit : chromium).launch({ headless: true });
  page = await browser.newPage();
  page.on('console', message => {
    if (message.text().startsWith('[values-idb-stage]')) console.log(message.text());
  });
  page.on('pageerror', error => console.error(JSON.stringify({ engine, pageError: error.name })));
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  console.log(JSON.stringify(await page.evaluate(async () => {
    const diagnostics = { stage: 'boot', events: [], nativeControls: [] };
    globalThis.__valuesIdbDiagnostics = diagnostics;
    const mark = stage => {
      diagnostics.stage = stage;
      console.log('[values-idb-stage] ' + stage);
    };
    const errorName = source => { try { return source?.error?.name ?? null; } catch { return 'unavailable'; } };
    const event = data => {
      diagnostics.events.push({ stage: diagnostics.stage, ...data });
      if (diagnostics.events.length > 100) diagnostics.events.shift();
    };
    // Only names/modes/event/error types are recorded. Never keys, serialized
    // metadata, scores, comments, receipts, Blobs or request results.
    const transactionIds = new WeakMap();
    let nextTransactionId = 1;
    const realTransaction = IDBDatabase.prototype.transaction;
    IDBDatabase.prototype.transaction = function (...args) {
      const tx = Reflect.apply(realTransaction, this, args);
      const transaction = nextTransactionId++;
      transactionIds.set(tx, transaction);
      const detail = { transaction, stores: Array.from(tx.objectStoreNames), mode: tx.mode };
      event({ kind: 'transaction-start', ...detail });
      for (const kind of ['complete', 'abort', 'error']) tx.addEventListener(kind, e => {
        event({ kind: 'transaction-' + kind, ...detail, transactionError: errorName(tx), requestError: errorName(e.target) });
      });
      return tx;
    };
    for (const method of ['get', 'getAll', 'put', 'add', 'delete']) {
      const original = IDBObjectStore.prototype[method];
      IDBObjectStore.prototype[method] = function (...args) {
        const detail = { method, store: this.name, transaction: transactionIds.get(this.transaction) };
        let request;
        try { request = Reflect.apply(original, this, args); }
        catch (error) { event({ kind: 'request-throw', ...detail, errorName: error.name }); throw error; }
        request.addEventListener('success', () => event({ kind: 'request-success', ...detail }), { once: true });
        request.addEventListener('error', () => event({ kind: 'request-error', ...detail, errorName: errorName(request) }), { once: true });
        return request;
      };
    }
    // Platform controls are collected even if one fails, so a store failure
    // can be compared with bare native string/Blob storage in the same engine.
    // Failures still fail the final gate; they are never skipped or excused.
    for (const kind of ['string', 'blob']) {
      mark('native-' + kind + '-control');
      let db;
      try {
        db = await new Promise((resolve, reject) => {
          const open = indexedDB.open('values-native-' + kind, 1);
          open.onupgradeneeded = () => open.result.createObjectStore('rows', { keyPath: 'id' });
          open.onsuccess = () => resolve(open.result);
          open.onerror = () => reject(open.error);
        });
        const value = kind === 'blob' ? new Blob(['native control bytes'], { type: 'image/jpeg' }) : 'native control bytes';
        await new Promise((resolve, reject) => {
          const tx = db.transaction('rows', 'readwrite');
          let requestError;
          const put = tx.objectStore('rows').put({ id: 'control', value });
          put.onerror = () => { requestError = put.error; };
          tx.oncomplete = resolve;
          tx.onabort = () => reject(requestError ?? tx.error ?? new Error('Native control transaction aborted'));
        });
        const stored = await new Promise((resolve, reject) => {
          const read = db.transaction('rows').objectStore('rows').get('control');
          read.onsuccess = () => resolve(read.result.value);
          read.onerror = () => reject(read.error);
        });
        const text = kind === 'blob' ? await stored.text() : stored;
        if (text !== 'native control bytes') throw new Error('Native control bytes changed');
        diagnostics.nativeControls.push({ kind, ok: true });
      } catch (error) {
        diagnostics.nativeControls.push({ kind, ok: false, errorName: error?.name ?? 'unknown' });
      } finally { db?.close(); }
    }
    const nativeControls = diagnostics.nativeControls;
    mark('http-module-load');
    const core = await import('/core.js');
    const auth = await import('/auth.js');
    const storage = await import('/store.js');
 const store=new storage.IndexedDbOutboxStore(); const owner='owner-a'; auth.rememberSignedIn({user:{id:owner}});
 const entry=core.makeEntry({op:'values_submit',ownerId:owner,payload:{assignmentId:'assignment',requestId:'request',rubricVersion:1,digest:'a'.repeat(64)}},'request',1);
 const draft={id:owner+':assignment',ownerId:owner,assignmentId:'assignment',requestId:'request',rubricVersion:1,digest:'a'.repeat(64),scores:{fullsend:7},comment:'',status:'queued',updatedAt:1};
 const receipt={receipt:{encodingVersion:'forge-values-submit/v1',...entry.payload}};
 mark('initial-entry-put'); await store.put(entry); mark('initial-draft-put'); await store.putValuesDraft(draft);
 const result={}; const assert=(truth,label)=>{if(!truth)throw Error(label)};
 const retained=async()=>{assert((await store.getAll()).length===1,'queue retained');assert((await store.getValuesDraft(owner,'assignment')).status==='queued','draft retained');};
 const bounce=()=>{auth.rememberSignedIn({user:{id:'owner-b'}});auth.rememberSignedIn({user:{id:owner}})};
 const context=()=>{const mark=auth.signInMark();return {canCommit:()=>auth.stillSignedInAs(mark,owner)}};
 const safeAck=async ctx=>{try{return await store.acknowledgeValues(entry,receipt,ctx)}catch(e){return 'rejected:'+e.message}};
 const originalGet=IDBObjectStore.prototype.get;
 IDBObjectStore.prototype.get=function(...args){const r=originalGet.apply(this,args);if(this.name==='metadata'&&String(args[0]).startsWith('values-draft/v1/'))r.addEventListener('success',bounce,{once:true});return r};
 mark('ack-account-change-before-read'); result.accountBounceBeforeCallback=await safeAck(context()); IDBObjectStore.prototype.get=originalGet; await retained();
 const originalPut=IDBObjectStore.prototype.put;
 IDBObjectStore.prototype.put=function(...args){const r=originalPut.apply(this,args);if(this.name==='metadata'&&String(args[0]?.id).startsWith('values-draft/v1/')&&JSON.parse(args[0].meta).status==='accepted')r.addEventListener('success',bounce,{once:true});return r};
 mark('ack-account-change-before-commit'); result.accountBounceBeforeCommit=await safeAck(context()); IDBObjectStore.prototype.put=originalPut; await retained();
 const controller=new AbortController(); const ctx={...context(),signal:controller.signal};
 IDBObjectStore.prototype.put=function(...args){const r=originalPut.apply(this,args);if(this.name==='metadata'&&String(args[0]?.id).startsWith('values-draft/v1/')&&JSON.parse(args[0].meta).status==='accepted')r.addEventListener('success',()=>controller.abort(),{once:true});return r};
 mark('ack-abort-after-write'); result.abortAfterAcceptedWrite=await safeAck(ctx); IDBObjectStore.prototype.put=originalPut; await retained();
 mark('stale-CAS'); const stale={...entry,attemptCount:2}; await store.put(stale); result.staleCAS=await safeAck(context()); assert(result.staleCAS===false,'stale CAS false'); await retained(); await store.put(entry);
 mark('matching-ack-commit'); result.commit=await safeAck(context()); assert(result.commit===true,'commit true'); assert((await store.getAll()).length===0,'queue deleted');assert((await store.getValuesDraft(owner,'assignment')).status==='accepted','receipt committed');
 mark('hung-ack-watchdog'); class Hung extends storage.MemoryOutboxStore{async acknowledgeValues(){return new Promise(()=>{})}} const hung=new Hung(); await hung.put(entry);await hung.put(core.makeEntry({op:'photo_upload',ownerId:owner,payload:{}},'photo',2));
 const order=[]; const timer=setTimeout(()=>hung.put(core.makeEntry({op:'clock_in',ownerId:owner,payload:{}},'clock',3)),5);
 result.hungAck=await core.drainUntilSettled(hung,{values_submit:async()=>receipt,photo_upload:async()=>{order.push('photo')},clock_in:async()=>{order.push('clock')}},{now:100,sendDeadlineMs:()=>30});clearTimeout(timer);
 result.order=order; assert(order.join(',')==='clock,photo','clock/photo drain ordering');assert((await hung.getAll()).some(e=>e.id==='request'),'hung review retained');assert(result.hungAck.sent===2&&result.hungAck.retried===1,'watchdog result');

 mark('legacy-module-load'); const legacy=await import('/legacy.js');
 const oldStore=new legacy.IndexedDbOutboxStore();
 const photo=core.makeEntry({op:'photo_upload',ownerId:owner,payload:{}},'retained-photo',4);
 mark('legacy-photo-blob-put'); await store.put(photo,new Blob(['original photo bytes'],{type:'image/jpeg'}));
 mark('legacy-read-and-blob'); const oldRows=await oldStore.getAll();assert(oldRows.length===1&&oldRows[0].id===photo.id,'legacy does not queue private metadata');
 assert(await (await oldStore.getBlob(photo.id)).text()==='original photo bytes','legacy photo bytes retained');
 mark('legacy-swap'); assert(await oldStore.swap(photo.id,photo,{...photo,attemptCount:1}),'legacy swap works');
 mark('legacy-clock-put'); const oldClock=core.makeEntry({op:'clock_in',ownerId:owner,payload:{}},'old-clock',5);await oldStore.put(oldClock);
 mark('legacy-drain'); const oldOrder=[];const oldDrain=await core.drainUntilSettled(oldStore,{clock_in:async()=>{oldOrder.push('clock')},photo_upload:async()=>{oldOrder.push('photo')}},{now:100});
 assert(oldDrain.sent===2&&oldOrder.join(',')==='clock,photo','legacy queue drains after new review ACK');
 assert((await store.getValuesDraft(owner,'assignment')).status==='accepted','legacy drain preserves receipt');
 mark('DB2-version-check'); const db=await new Promise((resolve,reject)=>{const r=indexedDB.open('wops-write-outbox',2);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)});assert(db.version===2,'new draft does not upgrade production DB');db.close();result.legacyDB2='PASS';
 // A prior unreleased developer DB3 is preserved and migrated without deletion.
 mark('developer-DB3-upgrade'); const upgrade=await new Promise((resolve,reject)=>{const r=indexedDB.open('wops-write-outbox',3);r.onupgradeneeded=()=>r.result.createObjectStore('values_drafts',{keyPath:'id'});r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)});
 const dev={...draft,id:'owner-a:dev-assignment',assignmentId:'dev-assignment',requestId:'dev-request',status:'editing'};
 mark('developer-DB3-draft-put'); await new Promise((resolve,reject)=>{const tx=upgrade.transaction('values_drafts','readwrite');tx.objectStore('values_drafts').put(dev);tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error)});upgrade.close();
 mark('developer-DB3-photo-blob-put'); await store.put(photo,new Blob(['dev photo bytes']));mark('developer-DB3-draft-migration');assert((await store.getValuesDraft(owner,'dev-assignment')).requestId==='dev-request','developer draft migrated');assert(await (await store.getBlob(photo.id)).text()==='dev photo bytes','developer photo preserved');
 result.unreleasedDB3='PASS'; result.nativeControls=nativeControls; assert(nativeControls.every(control=>control.ok),'native IndexedDB string/Blob controls'); mark('complete'); return result;

  }), null, 2));
} catch (error) {
  let diagnostics;
  try { diagnostics = await page?.evaluate(() => globalThis.__valuesIdbDiagnostics ?? { stage: 'before-evaluate' }); }
  catch { diagnostics = { stage: 'browser-unavailable' }; }
  console.error(JSON.stringify({ engine, diagnostics }, null, 2));
  throw error;
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
