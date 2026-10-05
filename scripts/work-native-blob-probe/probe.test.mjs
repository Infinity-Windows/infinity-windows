import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {args,validateOutput,assertRoundtrip,CASES,PLAN,browserCase,main,errorView,closeResources,applyReadResult,reportStatus,reportIdentity,loadDeclaredPlaywright,caseBrowserIdentity} from './probe.mjs';

test('default and check-plan cannot request execution',()=>{
  assert.deepEqual(args([]),{execute:false});assert.deepEqual(args(['--check-plan']),{execute:false});
  for(const argv of [['--execute'],['--execute-linux-probe'],['--check-plan','--execute-linux-probe'],['--execute-linux-probe','--checkout','relative','--output','/tmp/unused']])assert.throws(()=>args(argv));
});
test('unused output must be outside real checkout including symlinks',()=>{
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'blob-probe-test-'));
  try {const root=path.join(temporary,'repo');fs.mkdirSync(root);fs.symlinkSync(root,path.join(temporary,'alias'));
    assert.throws(()=>validateOutput(root,path.join(root,'child')));
    assert.throws(()=>validateOutput(root,path.join(temporary,'alias/child')));
    assert.throws(()=>validateOutput(root,root));assert.throws(()=>validateOutput(root,temporary));
    assert.equal(validateOutput(root,path.join(temporary,'new')).output,path.join(fs.realpathSync(temporary),'new'));
  } finally {fs.rmSync(temporary,{recursive:true,force:true});}
});
test('finite matrix retains original bytes and separates MIME from context',()=>{
  assert.equal(PLAN.total,16);assert.equal(new Set(CASES.map(x=>x.id)).size,8);
  assert.deepEqual(CASES.slice(0,6).map(x=>x.bytes),Array.from({length:6},()=>[0,255,7]));
  assert.deepEqual(CASES[6].bytes,[11,29,53]);assert.equal(CASES[6].type,'');
  assert.deepEqual(PLAN.contexts,['ephemeral','persistent']);
});
for(const spec of CASES)test('roundtrip validation rejects changed bytes/type/name/metadata: '+spec.id,()=>{
  const row={bytes:spec.bytes,kind:spec.kind,type:spec.type,name:spec.kind==='File'?'original.bin':null,lastModified:spec.kind==='File'?1700000000123:null,marker:spec.oldPhoto?'Keep original':'original Ω\r\n tap +06:00'};
  assert.doesNotThrow(()=>assertRoundtrip(spec,row));
  for(const patch of [{bytes:[1,2,3]},{kind:'unknown'},{type:'changed'},{name:'changed'},{lastModified:42},{marker:'changed'}])assert.throws(()=>assertRoundtrip(spec,{...row,...patch}));
});
test('request error then terminal abort preserve real DOMException fields without throwing null',async()=>{
  const old=globalThis.indexedDB;const error=new DOMException('Error preparing Blob/File data to be stored in object store','UnknownError');let closed=false,transaction;
  globalThis.indexedDB={open(){const request={};queueMicrotask(()=>{request.result={close(){closed=true;},transaction(){transaction={durability:'default',error:null,objectStore(){return {add(){queueMicrotask(()=>{transaction.onerror({target:{source:{name:'commands'},error}});transaction.error=error;transaction.onabort();});}};}};return transaction;}};request.onsuccess();});return request;}};
  try{const result=await browserCase({spec:CASES[0],phase:'write'});assert.equal(result.ok,false);assert.equal(result.stage,'write');assert.equal(result.error.name,'UnknownError');assert.deepEqual(result.errors.map(x=>x.event),['error','abort']);assert.equal(result.errors[0].transactionError,null);assert.equal(result.errors[0].requestError.message,error.message);assert.equal(result.errors[1].transactionError.name,'UnknownError');assert.equal(closed,true);}
  finally{globalThis.indexedDB=old;}
});
test('default plan produces no browser/process execution or filesystem mutation',async()=>{
  const before=fs.readdirSync(new URL('.',import.meta.url)).sort(),log=console.log;let value;
  console.log=x=>value=x;try{await main([]);}finally{console.log=log;}
  assert.equal(JSON.parse(value).total,16);assert.deepEqual(fs.readdirSync(new URL('.',import.meta.url)).sort(),before);
});
test('execution refuses non-Linux before output creation',async()=>{
  if(process.platform==='linux')return;
  await assert.rejects(main(['--execute-linux-probe','--checkout','/definitely-absent','--output','/definitely-absent-output']),/linux_only/);
});
test('both resource closes run and their failures never replace the primary error',async()=>{
  const item={primaryError:errorView(new Error('write failed')),cleanupErrors:[]},called=[];
  await closeResources(item,{async close(){called.push('context');throw Error('context close failed');}},{async close(){called.push('browser');throw Error('browser close failed');}});
  assert.deepEqual(called,['context','browser']);assert.equal(item.primaryError.message,'write failed');
  assert.deepEqual(item.cleanupErrors.map(x=>x.message),['context close failed','browser close failed']);
  const successful={primaryError:null,cleanupErrors:[]};await closeResources(successful,{async close(){throw Error('cleanup after success');}},null);
  assert.equal(successful.primaryError,null);assert.equal(successful.cleanupErrors[0].message,'cleanup after success');
});

const completeCases=()=>Array.from({length:PLAN.total},()=>({status:'byte_roundtrip_verified',primaryError:null,cleanupErrors:[]}));
test('observed read failure after write is inconclusive and cannot exit zero',()=>{
  const cases=completeCases(),item=cases[3];
  applyReadResult(item,CASES[0],{ok:false,phase:'read',stage:'materialize',error:{name:'UnknownError',message:'read failed'}});
  assert.equal(item.status,'observed_read_failure');assert.equal(item.primaryError,null);
  assert.equal(reportStatus(cases),'inconclusive_read_or_validation_failure');
  assert.notEqual(reportStatus(cases),'characterization_complete_not_suite_pass');
});
test('wrong bytes have a distinct browser finding, not infrastructure',()=>{
  const cases=completeCases(),item=cases[0];applyReadResult(item,CASES[0],{ok:true,row:{bytes:[9]}});
  assert.equal(item.status,'observed_roundtrip_mismatch');assert.match(item.validationError.message,/roundtrip_mismatch/);assert.equal(item.primaryError,null);
  assert.equal(reportStatus(cases),'inconclusive_read_or_validation_failure');
});
test('finite successful writes and observed write failures remain complete observations only',()=>{
  const cases=completeCases();assert.equal(reportStatus(cases),'characterization_complete_not_suite_pass');
  cases[0].status='observed_write_failure';assert.equal(reportStatus(cases),'characterization_complete_not_suite_pass');
  cases[0].status='unknown';assert.equal(reportStatus(cases),'inconclusive_read_or_validation_failure');
  cases[0].primaryError={message:'launch failed'};assert.equal(reportStatus(cases),'partial_or_infrastructure_failure');
  assert.equal(reportStatus(completeCases().slice(1)),'partial_or_infrastructure_failure');
  const cleanup=completeCases();cleanup[0].cleanupErrors.push({message:'close failed'});assert.equal(reportStatus(cleanup),'partial_or_infrastructure_failure');
});
test('report identifies exact script and pin bytes independently',()=>{
  const first=reportIdentity(new URL('./probe.mjs',import.meta.url),new URL('./source-pins.json',import.meta.url));
  assert.match(first.scriptSha256,/^[a-f0-9]{64}$/);assert.match(first.sourcePinsSha256,/^[a-f0-9]{64}$/);assert.notEqual(first.scriptSha256,first.sourcePinsSha256);
  const reversed=reportIdentity(new URL('./source-pins.json',import.meta.url),new URL('./probe.mjs',import.meta.url));
  assert.equal(first.scriptSha256,reversed.sourcePinsSha256);assert.equal(first.sourcePinsSha256,reversed.scriptSha256);
});
test('declared package import and metadata lookup work without top-level transitive hoisting',()=>{
  const calls=[],engine={};
  const request=id=>{calls.push(['load',id]);assert.equal(id,'@playwright/test');return {webkit:engine};};
  request.resolve=id=>{calls.push(['rootResolve',id]);assert.equal(id,'@playwright/test/package.json');return '/nested/test/package.json';};
  const scoped=parent=>({resolve(id){calls.push([parent,id]);
    if(parent==='/nested/test/package.json'){assert.equal(id,'playwright/package.json');return '/nested/test/node_modules/playwright/package.json';}
    assert.equal(parent,'/nested/test/node_modules/playwright/package.json');assert.equal(id,'playwright-core/package.json');return '/nested/test/node_modules/playwright/node_modules/playwright-core/package.json';
  }});
  const loaded=loadDeclaredPlaywright(request,scoped);assert.equal(loaded.webkit,engine);assert.equal(loaded.packageFile,'/nested/test/node_modules/playwright/node_modules/playwright-core/package.json');assert.equal(calls.length,4);
});
test('persistent null browser retains honest manifest identity, never invents a measured version',()=>{
  const metadata={engineManifest:{name:'webkit',revision:'2336',browserVersion:'manifest-only'},manifestSha256:'pinned-manifest',executablePath:'/existing/browser'};
  const item=caseBrowserIdentity(null,{browser:()=>null},metadata);
  assert.equal(item.reportedVersion,null);assert.equal(item.reportedVersionSource,'unavailable-context-browser-null');assert.deepEqual(item.engineManifest,metadata.engineManifest);
  const ephemeral=caseBrowserIdentity({version:()=> 'observed'},null,metadata);assert.equal(ephemeral.reportedVersion,'observed');assert.equal(ephemeral.reportedVersionSource,'launched-browser');
});
test('frozen probe1 read-failure regression is reproduced from its exact finalizer expression',()=>{
  const source=fs.readFileSync(new URL('./before/probe.mjs',import.meta.url),'utf8');
  const expression=source.match(/result.status=(result.cases.length===PLAN.total[^;]+);/)[1];
  const cases=completeCases();cases[0].status='observed_read_failure';
  const oldStatus=Function('result','PLAN','return '+expression)({cases},PLAN);
  assert.equal(oldStatus,'characterization_complete_not_suite_pass');assert.equal(reportStatus(cases),'inconclusive_read_or_validation_failure');
});
