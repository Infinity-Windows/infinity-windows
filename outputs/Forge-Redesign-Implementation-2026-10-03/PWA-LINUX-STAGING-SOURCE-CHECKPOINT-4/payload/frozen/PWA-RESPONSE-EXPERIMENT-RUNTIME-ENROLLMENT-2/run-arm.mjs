// HELD: no invocation until actual peers enroll this exact frozen package.
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {assertRunEnvironment,assertOutputPath,acquireExclusiveLock,assertSingleListedCase} from './experiment-gates.mjs';
const here=dirname(fileURLToPath(import.meta.url));
const pins=JSON.parse(readFileSync(join(here,'RUNTIME-PINS.json'),'utf8'));
const arm=assertRunEnvironment(process.env,pins);
if(process.version!==pins.nodeVersion)throw Error('Wrong pinned Node version');
const rehearsal=resolve(here,'../PWA-F9-WORKER-PARITY-REHEARSAL-1');
assertOutputPath(here,arm,[here,rehearsal,resolve(here,'../PWA-F9-CURRENT-FAIL-ARTIFACT')]);
mkdirSync(arm.runDir,{recursive:true});acquireExclusiveLock(arm.runDir,'owned-runner.lock');
for(const [path,hash] of Object.entries(pins.runtimeSources))if(createHash('sha256').update(readFileSync(path)).digest('hex')!==hash)throw Error('Pinned Playwright source changed: '+path);
const cli=pins.playwrightCLI;const base=[cli,'test','--config',join(here,'app/playwright.pwa.config.ts'),'--reporter=json'];
const childEnv={...process.env};delete childEnv.PLAYWRIGHT_JSON_OUTPUT_NAME;delete childEnv.PLAYWRIGHT_JSON_OUTPUT_DIR;delete childEnv.PLAYWRIGHT_JSON_OUTPUT_FILE;
function call(args,name){const r=spawnSync(process.execPath,args,{cwd:join(here,'app'),env:childEnv,encoding:'utf8',maxBuffer:32*1024*1024});writeFileSync(join(arm.runDir,name+'.json'),r.stdout??'');writeFileSync(join(arm.runDir,name+'.stderr.txt'),r.stderr??'');writeFileSync(join(arm.runDir,name+'-exit.json'),JSON.stringify({status:r.status,signal:r.signal,error:r.error?String(r.error):null}));return r;}
// --list loads config only during an approved future run. Its saved JSON must show one case.
const listing=call([...base,'--list'],'list-preflight');
if(listing.status!==0)throw Error('List preflight failed; no browser arm');
assertSingleListedCase(JSON.parse(listing.stdout));
const test=call(base,'test-report');
writeFileSync(join(arm.runDir,'test-exit.json'),JSON.stringify({status:test.status,signal:test.signal,error:test.error?String(test.error):null}));
// Always validate after normal Playwright exit, including assertion failure. Never replace its report.
const validation=spawnSync(process.execPath,[join(here,'validate-run.mjs')],{cwd:here,env:childEnv,encoding:'utf8'});
writeFileSync(join(arm.runDir,'postrun-validation.stdout.txt'),validation.stdout??'');writeFileSync(join(arm.runDir,'postrun-validation.stderr.txt'),validation.stderr??'');
writeFileSync(join(arm.runDir,'RUN-OUTCOME.json'),JSON.stringify({originalTestExit:test.status,originalSignal:test.signal,validationExit:validation.status,validRuntimeEvidence:validation.status===0},null,2));
process.exitCode=test.status===0&&validation.status===0?0:1;
