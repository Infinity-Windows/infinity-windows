// Bounded four-arm controller; import is pure. Future invocation needs source enrollment.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {readFileSync,writeFileSync,mkdirSync,existsSync,realpathSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {performance} from 'node:perf_hooks';
import {createHash} from 'node:crypto';
import {cleanRoot,cleanEnvironment,linuxPlan,R} from './bindings.mjs';
export function classifyArm({child,outcome,testExit,validation,report}){
 if(child.error||child.signal||child.timedOut||![0,1].includes(child.code))return {continue:false,reason:'runner launch/signal/budget failure',originalTestExit:testExit?.status??null};
 if(!outcome||!testExit||!validation||!report)return {continue:false,reason:'missing outcome/evidence',originalTestExit:testExit?.status??null};
 const originalTestExit=testExit.status;
 if(testExit.error||testExit.signal||![0,1].includes(originalTestExit)||outcome.originalTestExit!==originalTestExit||outcome.originalSignal!==null||outcome.validationExit!==0||outcome.validRuntimeEvidence!==true||validation.captureValid!==true||validation.invalid?.length||report.errors?.length)return {continue:false,reason:'invalid setup/capture/validation',originalTestExit};
 const results=[];function walk(s){for(const spec of s.specs??[])for(const t of spec.tests??[])results.push(...(t.results??[]));for(const c of s.suites??[])walk(c);}for(const s of report.suites??[])walk(s);
 if(results.length!==1||results[0].retry!==0)return {continue:false,reason:'missing or retried test result',originalTestExit};
 const r=results[0];const failures=r.errors??(r.error?[r.error]:[]);
 const assertion=failures.length>0&&failures.every(e=>/\bexpect\(/.test(String(e.message??'').replace(/\x1b\[[0-9;]*m/g,'')));
 if(!((originalTestExit===0&&child.code===0&&r.status==='passed')||(originalTestExit===1&&child.code===1&&r.status==='failed'&&assertion)))return {continue:false,reason:'non-assertion failure or exit inconsistency',originalTestExit};
 return {continue:true,reason:originalTestExit?'complete assertion failure':'complete pass',originalTestExit};
}
// performance.now() is measured from the Node process timeOrigin, including main preflight.
// Inner deadline1470s precedes outer watchdog1495s TERM /1500s KILL by25/30s.
export const INNER_BUDGET_MS=1470000;
export function createLifecycle({write,now=()=>performance.now(),originMs=0,signals=process,onStop=()=>{}}){
 let latest={originMs,elapsedMs:now()-originMs,results:[],completed:false,phase:'driver-start',stopReason:null},terminal=null;
 const snapshot=value=>({...value,originMs,elapsedMs:now()-originMs});
 const save=value=>{if(terminal)return terminal;latest=snapshot({...latest,...value});write(latest);return latest;};
 const abort=(reason='watchdog',signal='SIGTERM')=>{if(terminal)return terminal;terminal=snapshot({...latest,completed:false,stopReason:reason,signal,terminal:true});write(terminal);onStop(terminal);return terminal;};
 const term=()=>abort('watchdog','SIGTERM'),interrupt=()=>abort('interrupted','SIGINT');
 signals.on('SIGTERM',term);signals.on('SIGINT',interrupt);
 save(latest);
 return {save,abort,get stopped(){return terminal!==null;},get receipt(){return terminal??latest;},dispose(){signals.removeListener('SIGTERM',term);signals.removeListener('SIGINT',interrupt);}};
}
export async function runBlock({arms,invoke,readResult,save,now=()=>performance.now(),originMs=0,budgetMs=INNER_BUDGET_MS,lifecycle}){
 assert.equal(budgetMs,INNER_BUDGET_MS);assert.deepEqual(arms.map(a=>a.mode),['baseline','blob','baseline','stream']);
 const start=originMs,deadline=originMs+budgetMs,results=[];let stopReason=null;
 const persist=value=>lifecycle?lifecycle.save(value):save(value);
 const stopped=()=>lifecycle?.stopped;
 const checkStop=()=>{if(stopped()){stopReason=lifecycle.receipt.stopReason;return true;}if(now()>=deadline){stopReason='block budget exhausted';return true;}return false;};
 try{
  for(const arm of arms){
   if(checkStop())break;
   //100 seconds reserved:65 teardown +35 validation, all from process origin.
   if(now()>=deadline-100000){stopReason='block budget exhausted before arm';break;}
   persist({start,elapsedMs:now()-start,deadline,results,completed:false,phase:'invoking',armIndex:arm.index,stopReason:null});
   let child;try{child=await invoke(arm,deadline);}catch(error){child={code:null,error:String(error)};}
   if(stopped()){stopReason=lifecycle.receipt.stopReason;break;}
   persist({start,elapsedMs:now()-start,deadline,results,completed:false,phase:'validating',armIndex:arm.index,stopReason:null});
   let evidence;try{evidence=await readResult(arm);}catch(error){evidence={readError:String(error)};}
   // Give pending process signals an event-loop turn before any acceptance/final write.
   await new Promise(resolve=>setImmediate(resolve));
   if(stopped()){stopReason=lifecycle.receipt.stopReason;break;}
   const verdict=classifyArm({child,...evidence});results.push({index:arm.index,mode:arm.mode,child,...verdict});
   if(checkStop())break;
   persist({start,elapsedMs:now()-start,deadline,results,completed:false,phase:'arm-complete',stopReason:verdict.continue?null:verdict.reason});
   if(!verdict.continue){stopReason=verdict.reason;break;}
  }
 }finally{
  checkStop();persist({start,elapsedMs:now()-start,deadline,budgetMs,results,stopReason,completed:results.length===4&&!stopReason,phase:'final'});
 }
 return {results,stopReason,completed:results.length===4&&!stopReason&&!stopped()};
}
export function spawnBounded(node,args,{cwd,env,deadline,logBase}){
 return new Promise(resolveResult=>{
  let child,timedOut=false,error=null,done=false;
  try{child=spawn(node,args,{cwd,env,stdio:['ignore','pipe','pipe'],detached:true});}catch(e){resolveResult({code:null,error:String(e)});return;}
  const output={stdout:[],stderr:[]};let bytes=0;
  function group(signal){try{process.kill(-child.pid,signal);}catch(e){if(e.code!=='ESRCH')error=String(e);}}
  for(const key of ['stdout','stderr'])child[key].on('data',b=>{bytes+=b.length;if(bytes>64*1024*1024){error='driver output overflow';group('SIGTERM');}else output[key].push(b);});
  const term=setTimeout(()=>{timedOut=true;group('SIGTERM');},Math.max(0,deadline-performance.now()-100000));
  const kill=setTimeout(()=>{timedOut=true;group('SIGKILL');},Math.max(0,deadline-performance.now()-35000));
  const abort=()=>{error='parent interrupted';group('SIGTERM');};process.once('SIGTERM',abort);process.once('SIGINT',abort);
  child.once('error',e=>{error=String(e);});
  child.once('close',(code,signal)=>{if(done)return;done=true;clearTimeout(term);clearTimeout(kill);process.removeListener('SIGTERM',abort);process.removeListener('SIGINT',abort);for(const key of ['stdout','stderr'])writeFileSync(logBase+'.'+key+'.txt',Buffer.concat(output[key]),{flag:'wx'});resolveResult({code,signal,error,timedOut});});
 });
}
// Async source-only gate keeps the process-level watchdog listener live during validation.
function gateCommand(executable,args){return new Promise((ok,reject)=>{
 const child=spawn(executable,args,{stdio:['ignore','pipe','pipe']});let stdout='',stderr='',error=null;
 const timer=setTimeout(()=>{error=Error('preflight timeout');child.kill('SIGKILL');},30000);
 child.stdout.on('data',b=>{stdout+=b;if(stdout.length>1024*1024){error=Error('preflight output overflow');child.kill('SIGKILL');}});
 child.stderr.on('data',b=>{stderr+=b;if(stderr.length>1024*1024){error=Error('preflight stderr overflow');child.kill('SIGKILL');}});
 child.once('error',e=>{error=e;});child.once('close',(code,signal)=>{clearTimeout(timer);if(error||code!==0||signal)reject(error??Error('preflight failed '+stderr));else ok(stdout.trim());});
});}
async function main(){
 const [scratch,unique]=process.argv.slice(2);cleanRoot(scratch);assert(/^[A-Za-z0-9_-]+$/.test(unique));
 const runs=join(scratch,'PWA-RESPONSE-EXPERIMENT-RUNS-'+unique);assert(!existsSync(runs));mkdirSync(runs);
 // Installed before environment, plan, Python, source or postrun validation. Kept until process exit.
 const lifecycle=createLifecycle({write:r=>writeFileSync(join(runs,'BLOCK-RECEIPT.json'),JSON.stringify(r,null,2)),onStop:()=>{process.exitCode=1;}});
 try{
  cleanEnvironment(process.env);assert.equal(process.platform,'linux');assert.equal(process.arch,'x64');assert.equal(process.version,'v22.23.1');
  const read=p=>JSON.parse(readFileSync(p));const runtime=join(scratch,R);const expected=linuxPlan(read(join(runtime,'RUN-PLAN.json')),scratch,realpathSync(process.execPath),unique);const plan=read(join(scratch,'provenance/LINUX-RUN-PLAN.json'));assert.deepEqual(plan,expected);
  const resolution=read(join(scratch,'provenance/RESOLUTION-RECEIPT.json'));assert.equal(resolution.node.nodePath,realpathSync(process.execPath));
  const ready=read(join(scratch,'provenance/READY.json'));assert.equal(ready.unique,unique);assert.equal(ready.ready,true);assert.equal(ready.setupCompleted,true);
  lifecycle.save({...lifecycle.receipt,setup:ready,phase:'preflight'});
  const hash=p=>createHash('sha256').update(readFileSync(p)).digest('hex');assert.equal(ready.resolutionSha256,hash(join(scratch,'provenance/RESOLUTION-RECEIPT.json')));
  const python=resolution.node.python3Path;assert.equal(realpathSync(python),python);
  assert.equal(await gateCommand('python3',['-c','import os,sys;print(os.path.realpath(sys.executable))']),python);
  assert.equal(await gateCommand(python,['--version']),resolution.node.python3Version);
  const preflight=async()=>{assert(!lifecycle.stopped,'watchdog stopped driver');await gateCommand(python,[join(dirname(fileURLToPath(import.meta.url)),'verify-stage.py'),scratch]);assert.equal(ready.resolutionSha256,hash(join(scratch,'provenance/RESOLUTION-RECEIPT.json')));assert(!lifecycle.stopped,'watchdog stopped driver');};
  await preflight();
  const {collectEvidence,validateEvidence}=await import(pathToFileURL(join(runtime,'postrun-validation.mjs')));const pins=read(join(runtime,'RUNTIME-PINS.json'));
  const result=await runBlock({arms:plan.arms,lifecycle,invoke:async(arm,deadline)=>{await preflight();assert(!lifecycle.stopped,'watchdog stopped driver');return spawnBounded(process.execPath,[plan.entrypoint],{cwd:runtime,env:{...process.env,...arm.env},deadline,logBase:join(runs,String(arm.index).padStart(2,'0')+'-runner')});},readResult:async arm=>{await preflight();
   const rd=arm.env.IW_PWA_RUN_DIR,validation=validateEvidence(collectEvidence(rd),pins,{index:arm.index,mode:arm.mode,runDir:rd});
   return {outcome:read(join(rd,'RUN-OUTCOME.json')),testExit:read(join(rd,'test-exit.json')),validation,report:read(join(rd,'test-report.json'))};
  }});process.exitCode=result.completed&&!lifecycle.stopped?0:1;
 }catch(error){lifecycle.abort(lifecycle.stopped?lifecycle.receipt.stopReason:'driver setup/validation failure',lifecycle.stopped?lifecycle.receipt.signal:null);process.exitCode=1;process.stderr.write(String(error)+'\n');}
}
if(process.argv[1]&&resolvePath(process.argv[1])===fileURLToPath(import.meta.url))await main();
function resolvePath(p){return fileURLToPath(pathToFileURL(p));}
