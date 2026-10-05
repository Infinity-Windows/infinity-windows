// PROPOSED LAUNCH ADAPTER — NOT EXECUTED. Requires actual source enrollment review.
import { readFileSync,writeFileSync,mkdirSync,realpathSync } from 'node:fs';
import { dirname,join,resolve,relative,sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawn,spawnSync } from 'node:child_process';
import { assertRunEnvironment,verifyPair,assertOutputPath,acquireExclusiveLock,readPinnedManifest } from './experiment-gates.mjs';
const here=dirname(fileURLToPath(import.meta.url));
const pins=JSON.parse(readFileSync(join(here,'RUNTIME-PINS.json'),'utf8'));
const arm=assertRunEnvironment(process.env,pins);
const rehearsal=resolve(here,'../PWA-F9-WORKER-PARITY-REHEARSAL-1');
const pair=join(rehearsal,'derived-pairs',arm.mode);
const manifest=readPinnedManifest(join(rehearsal,`DERIVED-${arm.mode}-MANIFEST.json`),pins.variants[arm.mode]);
if(createHash('sha256').update(readFileSync(join(here,'verify-original-archives.py'))).digest('hex')!==pins.originalVerifierSha256)throw Error('Original strict verifier changed');
const originals=resolve(here,'../PWA-F9-CURRENT-FAIL-ARTIFACT/_temp/pwa-current');
assertOutputPath(here,arm,[here,rehearsal,originals]);
if(realpathSync(process.env.IW_PWA_CACHE??'')!==realpathSync(pair))throw Error('IW_PWA_CACHE is not fixed arm pair');
mkdirSync(arm.runDir,{recursive:true});
acquireExclusiveLock(arm.runDir); // A run directory cannot be reused.
function attest(phase){
 const derived=verifyPair(pair,manifest);
 const command=['verify-original-archives.py',originals,join(arm.runDir,`original-${phase}.json`),'current-f9'];
 const r=spawnSync('python3',command,{cwd:here,encoding:'utf8'});
 writeFileSync(join(arm.runDir,`original-${phase}.txt`),r.stdout+r.stderr);
 if(r.status!==0)throw Error('Original strict verifier failed');
 writeFileSync(join(arm.runDir,`derived-${phase}.json`),JSON.stringify({arm,derived,expectedNewWorker:manifest.new.sha256['sw.js'],expectedOldWorker:manifest.old.sha256['sw.js']},null,2));
}
attest('before');
const child=spawn(process.execPath,['--experimental-strip-types',join(here,'app/e2e/support/pwaHarness.ts')],{cwd:join(here,'app'),env:process.env,stdio:'inherit'});
let interrupted=false;
for(const signal of ['SIGTERM','SIGINT'])process.once(signal,()=>{interrupted=true;child.kill(signal);});
child.once('error',error=>{writeFileSync(join(arm.runDir,'harness-error.txt'),String(error));process.exitCode=1;});
child.once('exit',(code,signal)=>{
 try{attest('after');writeFileSync(join(arm.runDir,'harness-exit.json'),JSON.stringify({code,signal,interrupted}));process.exitCode=interrupted?0:(code??1);}
 catch(error){writeFileSync(join(arm.runDir,'after-failure.txt'),String(error));process.exitCode=1;}
});
