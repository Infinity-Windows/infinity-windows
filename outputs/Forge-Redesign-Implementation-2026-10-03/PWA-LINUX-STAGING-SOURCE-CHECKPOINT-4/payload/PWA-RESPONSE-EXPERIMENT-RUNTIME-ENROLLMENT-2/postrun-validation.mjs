// Read-only post-run gate. This does not classify the engine failure mechanism.
import {readFileSync,readdirSync,lstatSync} from 'node:fs';
import {join} from 'node:path';
import {assertBrowserAndCategories,assertSingleListedCase} from './experiment-gates.mjs';
export function validateEvidence(e,pins,arm){
 const invalid=[];const require=(ok,reason)=>{if(!ok)invalid.push(reason);};
 require(!e.collectionError,'evidence collection failure');
 for(const phase of ['before','after']){
  const original=e['original-'+phase],derived=e['derived-'+phase];
  require(!!original,'missing original-'+phase);require(!!derived,'missing derived-'+phase);
  for(const side of ['old','new']){
   require(original?.profile==='current-f9'&&original?.bundles?.[side]?.files===330&&original?.bundles?.[side]?.manifestSha256===pins.originalCompact[side],'invalid original-'+phase+' '+side);
   require(derived?.derived?.[side]?.files===330,'invalid derivative count '+phase+' '+side);
  }
  require(derived?.arm?.index===arm.index&&derived?.arm?.mode===arm.mode&&derived?.arm?.runDir===arm.runDir,'derived arm mismatch '+phase);
  require(derived?.derived?.new?.workerSha256===pins.variants[arm.mode].workerSha256&&derived?.expectedNewWorker===pins.variants[arm.mode].workerSha256,'derived worker mismatch '+phase);
  require(derived?.derived?.old?.workerSha256===pins.originalOldWorkerSha256&&derived?.expectedOldWorker===pins.originalOldWorkerSha256,'old worker mismatch '+phase);
 }
 require(!!e['harness-exit'],'missing harness-exit');
 require(e['harness-exit']?.interrupted===true&&[null,0].includes(e['harness-exit']?.code)&&[null,'SIGTERM'].includes(e['harness-exit']?.signal),'unexpected harness exit');
 try{assertSingleListedCase(e.list);}catch(error){invalid.push(String(error));}
 require(e.testExit?.status!==undefined&&Number.isInteger(e.testExit.status),'missing normal test exit');
 try{assertSingleListedCase(e.report);}catch(error){invalid.push('executed selection: '+String(error));}
 const trace=e.trace;
 require(!!trace,'missing engine receipt');
 require(trace?.complete===true&&trace?.started===true&&trace?.completion?.dataLossOccurred===false&&trace?.bytes>0&&e.traceFileBytes===trace?.bytes,'incomplete or lossy engine trace');
 require(trace?.responseExperimentMode===arm.mode,'engine arm mismatch');
 require(JSON.stringify(trace?.selected)===JSON.stringify(pins.traceCategories),'trace category order mismatch');
 try{assertBrowserAndCategories(trace?.version??{},trace?.inventory?.categories??[],pins);}catch(error){invalid.push(String(error));}
 require(!trace?.observationErrors?.length,'observation failed');
 require(!e.armInvalid,'ARM-INVALID artifact present');
 require(!!e.console&&Array.isArray(e.console.records)&&Array.isArray(e.console.gaps),'missing or malformed worker console receipt');
 require(!e.console?.records?.some(r=>r.validation==='INVALID_POST_CLONE'),'post-clone fallback invalidates arm');
 require(!e.console?.gaps?.length,'worker console gaps require invalid/inconclusive handling');
 return {captureValid:invalid.length===0,status:invalid.length?'ARM_INVALID':'CAPTURE_COMPLETE_MECHANISM_UNASSESSED',invalid,originalTestExit:e.testExit??null,mechanism:'UNASSESSED',engineRequestIdentity:'UNKNOWN',earlyRecordCoverage:'UNKNOWN',baselineSignature:'UNASSESSED'};
}
export function collectEvidence(runDir){
 const e={};const read=(name)=>{try{return JSON.parse(readFileSync(join(runDir,name),'utf8'));}catch{return null;}};
 for(const key of ['original-before','original-after','derived-before','derived-after','harness-exit'])e[key]=read(key+'.json');
 e.list=read('list-preflight.json');e.report=read('test-report.json');e.testExit=read('test-exit.json');
 const found={};function walk(dir){for(const name of readdirSync(dir)){const path=join(dir,name),stat=lstatSync(path);if(stat.isSymbolicLink())throw Error('Evidence symlink refused');if(stat.isDirectory())walk(path);else(found[name]??=[]).push(path);}}
 try{walk(join(runDir,'evidence'));}catch(error){e.collectionError=String(error);}
 for(const [key,name]of Object.entries({trace:'browser-engine-receipt.json',console:'worker-console-records.json'})){const paths=found[name]??[];if(paths.length===1)try{e[key]=JSON.parse(readFileSync(paths[0],'utf8'));}catch{};}
 const traces=found['browser-engine-trace.json']??[];if(traces.length===1)e.traceFileBytes=lstatSync(traces[0]).size;
 e.armInvalid=(found['ARM-INVALID.json']??[]).length>0;return e;
}
