// Future binding operation. No config/list/server/browser calls.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,chmodSync,symlinkSync,existsSync,realpathSync,lstatSync,readdirSync} from 'node:fs';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {cleanRoot,cleanEnvironment,rebindPins,linuxPlan,R,P} from './bindings.mjs';
const [scratch,node,unique]=process.argv.slice(2);cleanRoot(scratch);cleanEnvironment(process.env);assert.equal(process.platform,'linux');assert.equal(process.arch,'x64');assert.equal(process.version,'v22.23.1');assert.equal(realpathSync(node),realpathSync(process.execPath));
const runtime=join(scratch,R),read=p=>JSON.parse(readFileSync(p)),write=(p,v)=>writeFileSync(p,JSON.stringify(v,null,2)+'\n',{flag:'wx'});
const hash=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
function inventory(root){const map={};function walk(dir,rel=''){for(const name of readdirSync(dir).sort()){const p=join(dir,name),r=rel?rel+'/'+name:name,s=lstatSync(p);assert(!s.isSymbolicLink());if(s.isDirectory())walk(p,r);else{assert(s.isFile()&&s.nlink===1);map[r]={bytes:s.size,sha256:hash(p)};}}}walk(root);return map;}
const frozen=read(join(scratch,'provenance/FROZEN-FILES.json')),source=read(join(scratch,'provenance/SOURCE-FILES.json'));
assert.deepEqual(inventory(join(scratch,'frozen',R)),frozen);assert.deepEqual(inventory(runtime),source);
const original=read(join(runtime,'RUNTIME-PINS.json'));const bound=rebindPins(original,scratch);
const dep=join(scratch,'dependencies/app/node_modules');assert.equal(realpathSync(dep),dep);
assert(!existsSync(join(runtime,'app/node_modules')));
const evidence=[];
for(const [name,pin]of Object.entries(original.originalSources)){const path=join(scratch,'source-a703/app',name);assert.equal(hash(path),pin.sha256);evidence.push({historical:pin.sourcePath,linux:path,sha256:pin.sha256,classification:'evidence-only-never-executed'});}
const trace=join(scratch,'provenance/browser-engine-receipt.json');assert.equal(hash(trace),original.traceReceiptSha256);evidence.push({historical:original.traceReceiptPath,linux:trace,sha256:original.traceReceiptSha256,classification:'evidence-only-never-executed'});
const historical=read(join(scratch,'provenance/plan2/ABSOLUTE-PATH-INVENTORY.json'));assert.equal(historical.length,44);
// These 44 occurrences remain in original historical files. Only 8 executable pin fields change.
write(join(scratch,'provenance/LINUX-PATH-BINDINGS.json'),{historicalOccurrences:historical,evidence,pinDiff:bound.diffs,originalRoot:join(scratch,'PWA-F9-CURRENT-FAIL-ARTIFACT/_temp/pwa-current'),derivedRoot:join(scratch,P),allHistoricalDocumentsEvidenceOnly:['RUN-PLAN.json','CHECK-COMMANDS.json','SOURCE-EVIDENCE.json']});
write(join(scratch,'provenance/LINUX-RUN-PLAN.json'),linuxPlan(read(join(runtime,'RUN-PLAN.json')),scratch,realpathSync(node),unique));
// Existing path is the single expressly permitted pin mutation, after full source check.
chmodSync(join(runtime,'RUNTIME-PINS.json'),0o644);
writeFileSync(join(runtime,'RUNTIME-PINS.json'),JSON.stringify(bound.pins,null,2)+'\n');
chmodSync(join(runtime,'RUNTIME-PINS.json'),0o444);
const post=inventory(runtime);for(const [file,pin]of Object.entries(source))if(file!=='RUNTIME-PINS.json')assert.deepEqual(post[file],pin);
write(join(scratch,'provenance/EXECUTION-FILES-BEFORE-LINK.json'),post);
symlinkSync(dep,join(runtime,'app/node_modules'),'dir');
const probe=join(dirname(fileURLToPath(import.meta.url)),'resolution-probe.mjs');writeFileSync(join(runtime,'app/resolution-probe.mjs'),readFileSync(probe),{flag:'wx'});
write(join(scratch,'provenance/EXECUTION-ADDITIONS.json'),{link:{path:join(runtime,'app/node_modules'),target:dep},probe:{path:join(runtime,'app/resolution-probe.mjs'),sha256:hash(probe)},onlyTwoSourceEdits:['app/playwright.pwa.config.ts','start-verified-harness.mjs']});
assert.deepEqual(inventory(join(scratch,'frozen',R)),frozen);
