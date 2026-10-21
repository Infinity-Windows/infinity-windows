// Pure Linux binding helpers. No config, package, browser or harness imports.
import assert from 'node:assert/strict';
import {resolve,join,isAbsolute,dirname} from 'node:path';
import {lstatSync,existsSync,realpathSync} from 'node:fs';
export const R='PWA-RESPONSE-EXPERIMENT-RUNTIME-ENROLLMENT-2';
export const P='PWA-F9-WORKER-PARITY-REHEARSAL-1';
export function cleanRoot(root){
 assert(isAbsolute(root)&&resolve(root)===root&&!root.startsWith('/Users/'),'absolute Linux canonical root required');
 for(let p=root;;p=dirname(p)){if(existsSync(p)||(()=>{try{return lstatSync(p).isSymbolicLink();}catch{return false;}})())assert(!lstatSync(p).isSymbolicLink(),'symlink ancestor');if(dirname(p)===p)break;}
 return root;
}
export function cleanEnvironment(env){
 for(const k of ['NODE_PATH','NODE_OPTIONS','NODE_PRESERVE_SYMLINKS'])assert(!(k in env),k+' must be unset');
 return {NODE_PATH:null,NODE_OPTIONS:null,NODE_PRESERVE_SYMLINKS:null,preserveSymlinks:false,preserveSymlinksMain:false};
}
export function rebindPins(original,scratch){
 cleanRoot(scratch);const root=join(scratch,'dependencies/app/node_modules');const next=structuredClone(original);const diffs=[];
 const suffix=p=>{assert(p.includes('/node_modules/'));const s=p.split('/node_modules/');assert.equal(s.length,2);assert(!s[1].split('/').some(x=>['.','..',''].includes(x)));return s[1];};
 next.playwrightCLI=join(root,suffix(original.playwrightCLI));diffs.push({pointer:'/playwrightCLI',before:original.playwrightCLI,after:next.playwrightCLI});
 assert.equal(Object.keys(original.runtimeSources).length,7);next.runtimeSources={};
 for(const [old,hash]of Object.entries(original.runtimeSources)){const key=join(root,suffix(old));assert(!(key in next.runtimeSources));next.runtimeSources[key]=hash;diffs.push({pointer:'/runtimeSources (key)',before:old,after:key,sha256:hash});}
 assert.deepEqual({...next,playwrightCLI:original.playwrightCLI,runtimeSources:original.runtimeSources},original);
 return {pins:next,diffs};
}
export function linuxPlan(original,scratch,node,unique){
 cleanRoot(scratch);assert(isAbsolute(node));assert(/^[A-Za-z0-9_-]+$/.test(unique));const plan=structuredClone(original);
 plan.entrypoint=join(scratch,R,'run-arm.mjs');
 for(const [i,arm] of plan.arms.entries()){
  assert.equal(arm.index,i+1);assert.equal(arm.mode,['baseline','blob','baseline','stream'][i]);
  arm.argv=[node,plan.entrypoint];arm.env.IW_PWA_CACHE=join(scratch,P,'derived-pairs',arm.mode);
  arm.env.IW_PWA_RUN_DIR=join(scratch,'PWA-RESPONSE-EXPERIMENT-RUNS-'+unique,String(i+1).padStart(2,'0')+'-'+arm.mode);
 }
 return plan;
}
