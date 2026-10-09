import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdtempSync,mkdirSync,rmSync,symlinkSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {assertBrowserAndCategories,assertRunEnvironment,verifyPair,fileMap} from './experiment-gates.mjs';
import {createWorkerConsoleRecorder} from './worker-console-records.mjs';
const root=dirname(fileURLToPath(import.meta.url));
const pins=JSON.parse(readFileSync(join(root,'RUNTIME-PINS.json')));
const env={...pins.flags,IW_MAP_PORT:'5196',IW_PWA_RUN_INDEX:'1',IW_PWA_RESPONSE_MODE:'baseline',IW_PWA_RUN_DIR:'/tmp/controlled-unexecuted-run'};
test('exact complete browser and saved category order; extras never expand list',()=>assert.deepEqual(assertBrowserAndCategories(pins.browser,[...pins.traceCategories,'v8-extra'],pins),pins.traceCategories));
for(const field of Object.keys(pins.browser))test('browser mismatch refuses '+field,()=>assert.throws(()=>assertBrowserAndCategories({...pins.browser,[field]:'wrong'},pins.traceCategories,pins)));
test('missing trace category refuses',()=>assert.throws(()=>assertBrowserAndCategories(pins.browser,pins.traceCategories.slice(1),pins)));
for(const [i,mode]of pins.order.entries())test('fixed arm '+(i+1),()=>assert.equal(assertRunEnvironment({...env,IW_PWA_RUN_INDEX:String(i+1),IW_PWA_RESPONSE_MODE:mode},pins).mode,mode));
test('off cannot replace baseline',()=>assert.throws(()=>assertRunEnvironment({...env,IW_PWA_RESPONSE_MODE:'off'},pins)));
test('activation treatment stays off',()=>assert.throws(()=>assertRunEnvironment({...env,IW_PWA_ACTIVATION_GATE_COMPARE:'1'},pins)));
test('archive reuse stays on',()=>assert.throws(()=>assertRunEnvironment({...env,IW_PWA_REUSE:'0'},pins)));
test('drop prevents launch',()=>assert.throws(()=>assertRunEnvironment({...env,IW_PWA_DROP:'assets/x.js'},pins)));
test('disabled worker console prevents launch',()=>assert.throws(()=>assertRunEnvironment({...env,PLAYWRIGHT_DISABLE_SERVICE_WORKER_CONSOLE:'1'},pins)));
const url='http://localhost:5196/assets/useQuery-BBUeMcK7.js',hash='a'.repeat(64);
const worker=()=>({url:()=> 'http://localhost:5196/sw.js'});
function message(w,data){return {text:()=> 'PWA_RESPONSE_EXPERIMENT '+JSON.stringify({mode:'blob',responseId:1,requestURL:url,...data}),worker:()=>w,page:()=>null,timestamp:()=>123};}
function recorder(){return createWorkerConsoleRecorder({mode:'blob',fileHashes:{'assets/useQuery-BBUeMcK7.js':hash}});}
test('fresh/digest pairs within SAME public Worker object only',()=>{const r=recorder(),w=worker();r.receive(message(w,{disposition:'fresh',bytes:7}));r.receive(message(w,{disposition:'digest-complete',bytes:7,sha256:hash}));const x=r.finish();assert.equal(x.records[0].validation,'BYTE_PARITY_ONLY_ENGINE_IDENTITY_UNKNOWN');assert.equal(x.gaps.length,0);assert.equal(x.records[0].targetId,null);assert.equal(x.earlyRecordCoverage,'UNKNOWN');});
test('same URL different Worker cannot cross-pair',()=>{const r=recorder();r.receive(message(worker(),{disposition:'fresh',bytes:7}));r.receive(message(worker(),{disposition:'digest-complete',bytes:7,sha256:hash}));assert.ok(r.finish().gaps.some(x=>x.includes('Unpaired')));});
test('wrong mode invalidates record',()=>{const r=recorder();r.receive(message(worker(),{mode:'stream',disposition:'fresh'}));assert.ok(r.finish().gaps.some(x=>x.includes('Arm mode')));});
test('wrong digest invalidates parity',()=>{const r=recorder(),w=worker();r.receive(message(w,{disposition:'fresh',bytes:7}));r.receive(message(w,{disposition:'digest-complete',bytes:7,sha256:'b'.repeat(64)}));assert.ok(r.finish().gaps.some(x=>x.includes('mismatch')));});
test('post-clone fallback stays INVALID',()=>{const r=recorder();r.receive(message(worker(),{disposition:'post-clone-fallback'}));assert.equal(r.finish().records[0].validation,'INVALID_POST_CLONE');});
test('missing worker identity is UNKNOWN gap',()=>{const r=recorder();r.receive(message(null,{disposition:'fresh'}));assert.ok(r.finish().gaps.includes('missing-public-worker-identity'));});
test('nonstatic records are refused without body extraction',()=>{const r=recorder();r.receive(message(worker(),{requestURL:'http://localhost:5196/api/private',body:'never retained'}));assert.equal(r.finish().records.length,0);});
test('missing digest remains an observation gap',()=>{const r=recorder();r.receive(message(worker(),{disposition:'fresh',bytes:7}));assert.ok(r.finish().gaps.some(x=>x.startsWith('unpaired-fresh:')));});
test('read-only derivative verifier detects changed/missing/additional/symlink files',()=>{
 const temp=mkdtempSync(join(root,'test-only-'));try{
  const manifest={};for(const side of ['old','new']){const dir=join(temp,side+'-dist');mkdirSync(dir);for(let i=0;i<329;i++)writeFileSync(join(dir,String(i)),String(i));writeFileSync(join(dir,'sw.js'),'worker');manifest[side]={sha256:fileMap(dir)};}
  assert.equal(verifyPair(temp,manifest).new.files,330);
  const target=join(temp,'new-dist','0');writeFileSync(target,'changed');assert.throws(()=>verifyPair(temp,manifest));writeFileSync(target,'0');
  rmSync(target);assert.throws(()=>verifyPair(temp,manifest));writeFileSync(target,'0');
  writeFileSync(join(temp,'new-dist','extra'),'x');assert.throws(()=>verifyPair(temp,manifest));rmSync(join(temp,'new-dist','extra'));
  symlinkSync(target,join(temp,'new-dist','linked'));assert.throws(()=>verifyPair(temp,manifest));
 }finally{rmSync(temp,{recursive:true});}
});

test('unknown hashed URL cannot pair undefined digests into a false pass',()=>{const r=recorder(),w=worker();const requestURL='http://localhost:5196/assets/unknown-Ab12Cd34.js';r.receive(message(w,{requestURL,disposition:'fresh',bytes:0}));r.receive(message(w,{requestURL,disposition:'digest-complete',bytes:0}));assert.equal(r.finish().records.length,0);assert.ok(r.finish().gaps.every(x=>x.includes('Unenrolled')));});
