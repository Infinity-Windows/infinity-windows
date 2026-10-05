// Dormant characterization only. No imports from application runtime.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';

export const CASES = Object.freeze([
  {id:'original-raw-blob', kind:'Blob', bytes:[0,255,7], type:''},
  {id:'same-bytes-typed-blob', kind:'Blob', bytes:[0,255,7], type:'application/octet-stream'},
  {id:'same-bytes-raw-file', kind:'File', bytes:[0,255,7], type:''},
  {id:'same-bytes-typed-file', kind:'File', bytes:[0,255,7], type:'application/octet-stream'},
  {id:'uint8-control', kind:'Uint8Array', bytes:[0,255,7], type:null},
  {id:'arraybuffer-control', kind:'ArrayBuffer', bytes:[0,255,7], type:null},
  {id:'old-unit-review-photo-seed', kind:'Blob', bytes:[11,29,53], type:'', oldPhoto:true},
  {id:'old-activity-photo-bytes', kind:'Blob', bytes:[0,1,254,255], type:'image/png'},
]);
export const PLAN = Object.freeze({mode:'source-only-until-explicit-execution', contexts:['ephemeral','persistent'], cases:CASES, total:16,
  scope:'IndexedDB seed primitives and byte roundtrip, not the full native journal suites',
  options:{headless:true,viewport:{width:390,height:844},deviceScaleFactor:2},
  fullNative103:'HOLD', realSafari:'HOLD', transport:'HOLD'});
export const errorView = error => ({name:error?.name??typeof error,message:error?.message??String(error),stack:error?.stack??null});
export async function closeResources(item, context, browser) {
  try {await context?.close();} catch(error) {item.cleanupErrors.push(errorView(error));}
  try {await browser?.close();} catch(error) {item.cleanupErrors.push(errorView(error));}
}
export function applyReadResult(item, spec, read) {
  item.read=read;
  if(!read.ok) {item.status='observed_read_failure';return;}
  try {assertRoundtrip(spec,read.row);item.status='byte_roundtrip_verified';}
  catch(error) {item.validationError=errorView(error);item.status='observed_roundtrip_mismatch';}
}
export function reportStatus(cases) {
  if(cases.length!==PLAN.total || cases.some(x=>x.primaryError||x.cleanupErrors.length)) return 'partial_or_infrastructure_failure';
  if(cases.some(x=>!['byte_roundtrip_verified','observed_write_failure'].includes(x.status))) return 'inconclusive_read_or_validation_failure';
  return 'characterization_complete_not_suite_pass';
}
export function reportIdentity(scriptPath, pinsPath) {
  const hash=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  return {scriptSha256:hash(scriptPath),sourcePinsSha256:hash(pinsPath)};
}
export function loadDeclaredPlaywright(require, scopedRequire=createRequire) {
  const {webkit}=require('@playwright/test');
  // Resolve metadata through each declared dependency, not npm hoisting.
  const testPackage=require.resolve('@playwright/test/package.json');
  const testRequire=scopedRequire(testPackage);
  const playwrightPackage=testRequire.resolve('playwright/package.json');
  const packageFile=scopedRequire(playwrightPackage).resolve('playwright-core/package.json');
  return {webkit,packageFile,testPackage};
}
export function caseBrowserIdentity(browser, context, metadata) {
  const available=browser??context.browser();
  return {...metadata,reportedVersion:available?.version()??null,
    reportedVersionSource:browser?'launched-browser':available?'context-browser':'unavailable-context-browser-null'};
}
export function args(argv) {
  if (!argv.length || (argv.length===1 && argv[0]==='--check-plan')) return {execute:false};
  if(argv.length!==5 || argv[0]!=='--execute-linux-probe' || argv[1]!=='--checkout' || argv[3]!=='--output') throw Error('exact_arguments_required');
  if(!path.isAbsolute(argv[2])||!path.isAbsolute(argv[4])) throw Error('absolute_paths_required');
  return {execute:true, checkout:argv[2], output:argv[4]};
}
export function validateOutput(checkout, output) {
  const root=fs.realpathSync(checkout), parent=fs.realpathSync(path.dirname(output));
  const resolved=path.join(parent,path.basename(output));
  if(fs.existsSync(resolved)||resolved===root||resolved.startsWith(root+path.sep)) throw Error('unused_output_outside_checkout_required');
  return {root,output:resolved};
}
export function assertRoundtrip(spec, row) {
  const expected={bytes:spec.bytes,kind:spec.kind,type:spec.type,name:spec.kind==='File'?'original.bin':null,lastModified:spec.kind==='File'?1700000000123:null,
    marker:spec.oldPhoto?'Keep original':'original Ω\r\n tap +06:00'};
  if(JSON.stringify(row)!==JSON.stringify(expected)) throw Error('roundtrip_mismatch:'+JSON.stringify({expected,actual:row}));
}

// Runs inside the browser. All request errors are observed without cancellation;
// only terminal transaction completion/abort settles the write/read promise.
export async function browserCase({spec,phase}) {
  const errors=[], view=e=>e?{name:e.name,message:e.message,code:e.code??null}:null;
  const name=spec.oldPhoto?'wops-write-outbox':'blob-probe-'+spec.id;
  const store=spec.oldPhoto?'entries':'commands'; let db,stage='open';
  const done=tx=>new Promise((resolve,reject)=>{
    tx.onerror=e=>{const r=e.target;errors.push({stage,event:'error',source:r.source?.name??null,requestError:view(r.error),transactionError:view(tx.error),durability:tx.durability});};
    tx.onabort=()=>{errors.push({stage,event:'abort',transactionError:view(tx.error),durability:tx.durability});reject(tx.error??Error('abort_without_error'));};
    tx.oncomplete=()=>resolve();
  });
  try {
    db=await new Promise((resolve,reject)=>{const r=indexedDB.open(name,spec.oldPhoto?2:1);r.onupgradeneeded=()=>{r.result.createObjectStore(store,{keyPath:'id'});if(spec.oldPhoto)r.result.createObjectStore('metadata',{keyPath:'id'});};r.onerror=()=>reject(r.error);r.onblocked=()=>reject(Error('open_blocked'));r.onsuccess=()=>resolve(r.result);});
    if(phase==='write') {
      stage='write';const bytes=new Uint8Array(spec.bytes);
      const value=spec.kind==='Blob'?new Blob([bytes],{type:spec.type}):spec.kind==='File'?new File([bytes],'original.bin',{type:spec.type,lastModified:1700000000123}):spec.kind==='Uint8Array'?bytes:bytes.buffer;
      const tx=db.transaction(store,'readwrite'), finished=done(tx);
      const row=spec.oldPhoto?{id:'original-photo',photoBlob:value,note:'Keep original'}:{id:'original',blob:value,marker:'original Ω\r\n tap +06:00'};
      tx.objectStore(store).add(row);await finished;
      return {ok:true,phase,errors,version:db.version,stores:[...db.objectStoreNames]};
    }
    stage='read';const tx=db.transaction(store,'readonly'),finished=done(tx);let saved;
    const r=tx.objectStore(store).get(spec.oldPhoto?'original-photo':'original');r.onsuccess=()=>{saved=r.result;};
    await finished;stage='materialize';if(!saved)throw Error('missing_original_row');
    const value=spec.oldPhoto?saved.photoBlob:saved.blob;
    const kind=value instanceof File?'File':value instanceof Blob?'Blob':value instanceof Uint8Array?'Uint8Array':value instanceof ArrayBuffer?'ArrayBuffer':'unknown';
    const bytes=[...new Uint8Array(value instanceof Blob?await value.arrayBuffer():value instanceof Uint8Array?value.buffer:value)];
    return {ok:true,phase,errors,version:db.version,stores:[...db.objectStoreNames],row:{bytes,kind,type:value instanceof Blob?value.type:null,name:value instanceof File?value.name:null,lastModified:value instanceof File?value.lastModified:null,marker:spec.oldPhoto?saved.note:saved.marker}};
  } catch(error) {return {ok:false,phase,stage,error:view(error),errors};}
  finally {db?.close();}
}

export async function main(argv=process.argv.slice(2)) {
  const parsed=args(argv);if(!parsed.execute){console.log(JSON.stringify(PLAN,null,2));return;}
  if(process.platform!=='linux') throw Error('linux_only_no_local_webkit');
  const {root,output}=validateOutput(parsed.checkout,parsed.output);
  fs.mkdirSync(output);const result={status:'partial',plan:PLAN,host:{platform:process.platform,release:os.release(),arch:process.arch,node:process.version},cases:[],primaryError:null,cleanupErrors:[]};
  const persist=()=>{const target=path.join(output,'result.json');fs.writeFileSync(target+'.tmp',JSON.stringify(result,null,2)+'\n');fs.renameSync(target+'.tmp',target);};
  persist();
  try {
    result.probeIdentity=reportIdentity(fileURLToPath(import.meta.url),fileURLToPath(new URL('./source-pins.json',import.meta.url)));persist();
    const pins=JSON.parse(fs.readFileSync(new URL('./source-pins.json',import.meta.url),'utf8'));
    const digest=b=>crypto.createHash('sha256').update(b).digest('hex');
    for(const [relative,expected] of Object.entries(pins.pins)) if(digest(fs.readFileSync(path.join(root,relative)))!==expected)throw Error('source_pin_mismatch:'+relative);
    result.sourcePins=pins;persist();
    const require=createRequire(path.join(root,'app/package.json'));
    const {webkit,packageFile,testPackage}=loadDeclaredPlaywright(require);
    result.declaredTestPackageVersion=JSON.parse(fs.readFileSync(testPackage,'utf8')).version;
    result.playwright=JSON.parse(fs.readFileSync(packageFile,'utf8')).version;
    const browserManifest=fs.readFileSync(path.join(path.dirname(packageFile),'browsers.json'));
    result.browsers=JSON.parse(browserManifest);
    result.browserManifestSha256=digest(browserManifest);
    result.webkitManifest=result.browsers.browsers.find(x=>x.name==='webkit');
    if(!result.webkitManifest)throw Error('missing_webkit_manifest_identity');
    if(result.playwright!=='1.62.0'||result.declaredTestPackageVersion!=='1.62.0')throw Error('reviewed_playwright_version_required');
    result.executable=webkit.executablePath();persist();
    for(const mode of PLAN.contexts) for(const spec of CASES) {
      const item={id:spec.id,mode,status:'partial',primaryError:null,cleanupErrors:[]};result.cases.push(item);persist();
      let browser,context;
      try {
        const options={viewport:PLAN.options.viewport,deviceScaleFactor:PLAN.options.deviceScaleFactor};
        if(mode==='persistent')context=await webkit.launchPersistentContext(path.join(output,'profile-'+spec.id),{headless:true,...options});
        else {browser=await webkit.launch({headless:true});context=await browser.newContext(options);}
        item.browserIdentity=caseBrowserIdentity(browser,context,{playwrightVersion:result.playwright,engineManifest:result.webkitManifest,manifestSha256:result.browserManifestSha256,executablePath:result.executable});
        await context.route('**/*',route=>route.request().url()==='http://localhost:5183/blob-probe'?route.fulfill({contentType:'text/html',body:'<!doctype html><meta charset="utf-8"><title>Isolated Blob characterization</title>'}):route.abort());
        const page=context.pages()[0]??await context.newPage();
        await page.goto('http://localhost:5183/blob-probe');
        item.environment=await page.evaluate(()=>({userAgent:navigator.userAgent,origin:location.origin,secure:isSecureContext}));
        item.write=await page.evaluate(browserCase,{spec,phase:'write'});persist();
        if(item.write.ok) {
          await page.reload();item.read=await page.evaluate(browserCase,{spec,phase:'read'});persist();
          applyReadResult(item,spec,item.read);
        } else item.status='observed_write_failure';
      } catch(error){item.primaryError=errorView(error);item.status='infrastructure_failure';}
      finally {
        // Keep created profiles as evidence; never remove an existing directory.
        await closeResources(item,context,browser);
        persist();
      }
    }
    result.status=reportStatus(result.cases);
  } catch(error){result.primaryError=errorView(error);}
  finally {persist();}
  if(result.status!=='characterization_complete_not_suite_pass')process.exitCode=1;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(error=>{console.error(errorView(error));process.exitCode=1;});
