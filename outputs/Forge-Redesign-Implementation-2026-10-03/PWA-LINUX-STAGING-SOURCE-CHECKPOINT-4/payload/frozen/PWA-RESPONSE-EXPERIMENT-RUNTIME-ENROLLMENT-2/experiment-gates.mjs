// Read-only predicates/verification, safe to import for no-contact tests.
import { readFileSync, readdirSync, lstatSync, realpathSync, openSync, closeSync, existsSync } from 'node:fs';
import { join, resolve, isAbsolute, relative, sep, dirname } from 'node:path';
import { createHash } from 'node:crypto';
export function assertBrowserAndCategories(version, available, pins) {
  for (const field of ['protocolVersion','product','revision','userAgent','jsVersion'])
    if(version[field]!==pins.browser[field]) throw Error('Browser mismatch: '+field);
  for(const category of pins.traceCategories)if(!available.includes(category))throw Error('Missing A703 category: '+category);
  return [...pins.traceCategories]; // Exact saved order, not regex-expanded inventory.
}
export function assertRunEnvironment(env,pins) {
  const index=Number(env.IW_PWA_RUN_INDEX);const mode=pins.order[index-1];
  if(!Number.isInteger(index)||index<1||index>4||env.IW_PWA_RESPONSE_MODE!==mode)throw Error('Wrong fixed arm/order');
  for(const [k,v]of Object.entries(pins.flags))if(env[k]!==v)throw Error('Required passive flag '+k);
  if(env.IW_MAP_PORT!=='5196'||env.IW_PWA_DROP)throw Error('Unexpected port/drop mutation');
  if(env.PLAYWRIGHT_DISABLE_SERVICE_WORKER_CONSOLE)throw Error('Worker console disabled');
  if(!env.IW_PWA_RUN_DIR||!isAbsolute(env.IW_PWA_RUN_DIR))throw Error('Run output must be explicit absolute path');
  return {index,mode,runDir:resolve(env.IW_PWA_RUN_DIR)};
}
export function fileMap(root) {
 const result={};function walk(dir,rel=''){
  for(const name of readdirSync(dir).sort()){
   const path=join(dir,name),key=rel?rel+'/'+name:name,stat=lstatSync(path);
   if(stat.isSymbolicLink())throw Error('Symlink refused: '+key);
   if(stat.isDirectory())walk(path,key);else if(stat.isFile())result[key]=createHash('sha256').update(readFileSync(path)).digest('hex');else throw Error('Non-file refused');
  }
 }walk(root);return result;
}
export function verifyPair(pair,manifest) {
 const result={};for(const side of ['old','new']){
  const map=fileMap(join(pair,side+'-dist'));const expected=manifest[side].sha256;
  if(JSON.stringify(Object.keys(map).sort())!==JSON.stringify(Object.keys(expected).sort()))throw Error('Archive file set mismatch: '+side);
  for(const [name,hash]of Object.entries(map))if(hash!==expected[name])throw Error('Archive hash mismatch: '+side+'/'+name);
  if(Object.keys(map).length!==330)throw Error('Expected 330 files');
  result[side]={files:330,workerSha256:map['sw.js'],path:realpathSync(join(pair,side+'-dist'))};
 }return result;
}

export const CASE_TITLE='a download that broke halfway does not leave Refresh doing nothing afterwards';
export const CASE_GREP=/(?:^|\s)upgrade-path\.pwa\.ts a download that broke halfway does not leave Refresh doing nothing afterwards$/;
export function shellQuote(value){return "'"+String(value).replaceAll("'", "'\"'\"'")+"'";}
export function assertSingleListedCase(report){
 const entries=[];
 function walk(suite){for(const spec of suite.specs??[])for(const test of spec.tests??[])entries.push({title:spec.title,file:spec.file,projectId:test.projectId});for(const child of suite.suites??[])walk(child);}
 for(const suite of report.suites??[])walk(suite);
 if(report.errors?.length||entries.length!==1||entries[0].title!==CASE_TITLE||!/(?:^|[/\\])upgrade-path\.pwa\.ts$/.test(entries[0].file??''))throw Error('Preflight must list exactly one unchanged interrupted-download case');
 return entries[0];
}
export function readPinnedManifest(path,pin){
 const bytes=readFileSync(path);
 if(createHash('sha256').update(bytes).digest('hex')!==pin.manifestSha256)throw Error('Derivative manifest transport hash mismatch');
 const manifest=JSON.parse(bytes.toString('utf8'));
 if(manifest.new.sha256['sw.js']!==pin.workerSha256)throw Error('Variant worker hash mismatch');
 return manifest;
}
function canonicalFuture(path){let ancestor=resolve(path),tail=[];while(!existsSync(ancestor)){tail.unshift(ancestor.slice(dirname(ancestor).length+1));ancestor=dirname(ancestor);}return resolve(realpathSync(ancestor),...tail);}
function within(parent,child){const r=relative(parent,child);return r===''||(!r.startsWith('..'+sep)&&r!=='..'&&!isAbsolute(r));}
export function assertOutputPath(here,arm,protectedRoots){
 const outputParts=relative(dirname(here),arm.runDir).split(sep);
 if(outputParts.length!==2||!/^PWA-RESPONSE-EXPERIMENT-RUNS-[A-Za-z0-9_-]+$/.test(outputParts[0])||outputParts[1]!==String(arm.index).padStart(2,'0')+'-'+arm.mode)throw Error('Run directory must be a fresh named run sibling with fixed arm basename');
 const target=canonicalFuture(arm.runDir);
 for(const root of protectedRoots){const protectedPath=canonicalFuture(root);if(within(protectedPath,target)||within(target,protectedPath))throw Error('Output overlaps protected artifacts');}
 if(target!==resolve(arm.runDir))throw Error('Symlinked output path refused');
 return target;
}
export function acquireExclusiveLock(runDir,name='owned-harness.lock'){
 if(!['owned-harness.lock','owned-runner.lock'].includes(name))throw Error('Unexpected lock');
 closeSync(openSync(join(runDir,name),'wx')); // Deliberately retained; no run reuse.
}
// Instrumentation errors never replace the unchanged test's own exception.
export async function observationOnly(action,onError){try{return await action();}catch(error){try{await onError(error);}catch{}return undefined;}}
