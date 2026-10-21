// Future reviewed probe: copy this exact file into staged app before invoking.
// It resolves package metadata; it never imports Playwright/config/spec.
import assert from 'node:assert/strict';
import {readFileSync,realpathSync,lstatSync,writeFileSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
const app=dirname(fileURLToPath(import.meta.url)),runtime=dirname(app),scratch=dirname(runtime);
assert.equal(runtime,join(scratch,'PWA-RESPONSE-EXPERIMENT-RUNTIME-ENROLLMENT-2'));
assert.equal(process.platform,'linux');assert.equal(process.arch,'x64');assert.equal(process.version,'v22.23.1');
for(const k of ['NODE_OPTIONS','NODE_PATH','NODE_PRESERVE_SYMLINKS'])assert(!(k in process.env),k+' must be unset');
assert(!process.execArgv.some(a=>a.includes('preserve-symlinks')));
const hash=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
const dep=join(scratch,'dependencies/app/node_modules');assert.equal(realpathSync(dep),dep);assert(lstatSync(join(app,'node_modules')).isSymbolicLink());assert.equal(realpathSync(join(app,'node_modules')),dep);
const binary=JSON.parse(readFileSync(join(scratch,'provenance/NODE-BINARY-RECEIPT.json')));
assert.equal(binary.nodeVersion,process.version);assert.equal(binary.nodePath,realpathSync(process.execPath));assert.equal(binary.binarySha256,hash(process.execPath));
assert.equal(binary.distributionUrl,'https://nodejs.org/dist/v22.23.1/node-v22.23.1-linux-x64.tar.xz');
assert.equal(binary.checksumUrl,'https://nodejs.org/dist/v22.23.1/SHASUMS256.txt');
assert.equal(hash(binary.distributionPath),binary.distributionSha256);assert.equal(hash(binary.checksumPath),binary.checksumFileSha256);
const lines=readFileSync(binary.checksumPath,'utf8').split('\n').filter(l=>l.endsWith('  node-v22.23.1-linux-x64.tar.xz'));
assert.equal(lines.length,1);assert.equal(lines[0].split(/\s+/)[0],binary.distributionSha256);
assert.equal(binary.extractedNodeSha256,binary.binarySha256);assert.equal(binary.experimentalStripTypesAccepted,true);
const pins=JSON.parse(readFileSync(join(runtime,'RUNTIME-PINS.json'))),req=createRequire(import.meta.url),resolutions={};
for(const name of ['@playwright/test','playwright','playwright-core']){
 const expected=join(dep,name),esm=realpathSync(fileURLToPath(import.meta.resolve(name))),cjs=realpathSync(req.resolve(name));
 const esmPackage=realpathSync(fileURLToPath(import.meta.resolve(name+'/package.json'))),cjsPackage=realpathSync(req.resolve(name+'/package.json'));
 assert.equal(dirname(esmPackage),expected);assert.equal(dirname(cjsPackage),expected);assert(esm.startsWith(expected+'/')&&cjs.startsWith(expected+'/'));
 assert.equal(JSON.parse(readFileSync(esmPackage)).version,'1.62.0');assert.equal(hash(esmPackage),pins.runtimeSources[esmPackage]);
 resolutions[name]={esm,cjs,esmPackage,cjsPackage,packageRoot:expected,packageSha256:hash(esmPackage)};
}
for(const [file,want]of Object.entries(pins.runtimeSources)){assert.equal(realpathSync(file),file);assert(file.startsWith(dep+'/'));assert.equal(hash(file),want);}
const cli=join(dep,'playwright/cli.js');assert.equal(pins.playwrightCLI,cli);assert.equal(realpathSync(cli),cli);
const result={node:binary,environment:{NODE_PATH:null,NODE_OPTIONS:null,NODE_PRESERVE_SYMLINKS:null,preserveSymlinks:false},resolutions,playwrightCLI:cli,runtimeSources:pins.runtimeSources,platform:process.platform,arch:process.arch};
writeFileSync(join(scratch,'provenance/RESOLUTION-RECEIPT.json'),JSON.stringify(result,null,2),{flag:'wx'});
