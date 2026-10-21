// Metadata only. No config/spec import and no browser launch. Package import is exact, hash-gated.
import assert from 'node:assert/strict';import {readFileSync,writeFileSync,realpathSync,lstatSync} from 'node:fs';import {join,dirname,resolve} from 'node:path';import {fileURLToPath,pathToFileURL} from 'node:url';import {createHash} from 'node:crypto';import {createRequire} from 'node:module';
const O=dirname(fileURLToPath(import.meta.url));const R='PWA-RESPONSE-EXPERIMENT-RUNTIME-ENROLLMENT-2';
const sha=b=>createHash('sha256').update(b).digest('hex');
export function assertMetadataEnvironment(env,browsersPath){
 for(const key of ['NODE_PATH','NODE_OPTIONS','NODE_PRESERVE_SYMLINKS'])assert(!(key in env),key+' must be unset');
 for(const [key,value]of Object.entries(env)){
  if(['PWA_PACKAGE','PWA_CONTROL','PWA_SCRATCH','PWA_UNIQUE','PWA_PYTHON'].includes(key))continue;
  const canonical=key.toLowerCase().replace(/^npm_(?:package_)?config_/,'');
  if(/^(?:pwdebug|_?pw_|_?pwtest|playwright_|selenium_remote_)/.test(canonical))assert(key==='PLAYWRIGHT_BROWSERS_PATH'&&value===browsersPath,'unexpected launch/browser environment: '+key);
 }
 assert.equal(env.PLAYWRIGHT_BROWSERS_PATH,browsersPath);return Object.fromEntries(Object.entries(env).filter(([k])=>(k.startsWith('PLAYWRIGHT_')||k.startsWith('SELENIUM_'))));
}
export function proveProtocol({config,spec,runner,fixture,core,env,browsersPath}){
 assertMetadataEnvironment(env,browsersPath);
 // Hash guards bind these textual proofs to fully reviewed sources, not arbitrary TS parsing.
 const uncomment=s=>s.replace(/\/\*[\s\S]*?\*\//g,'').replace(/\/\/[^\n]*/g,'');
 assert(!/\b(?:headless|channel|executablePath|browserName|defaultBrowserType|launchOptions|connectOptions|projects|reuseContext)\s*:/.test(uncomment(config)),'config launch override');
 assert(!/\btest\s*\.\s*(?:use|extend)\s*\(|\.launch\s*\(|\.connect\s*\(/.test(uncomment(spec)),'spec launch override');
 assert(runner.includes("const base=[cli,'test','--config',join(here,'app/playwright.pwa.config.ts'),'--reporter=json'];"),'runner CLI protocol changed');
 assert(runner.includes("const test=call(base,'test-report');"));
 for(const exact of ['defaultBrowserType: ["chromium",','headless: [({ launchOptions }, use) => use(launchOptions.headless ?? true)','channel: [({ launchOptions }, use) => use(launchOptions.channel)','launchOptions: [{},','options.headless = headless;','options.channel = channel;','playwright._defaultLaunchOptions = options;','const browser = await playwright[browserName].launch();'])assert(fixture.includes(exact),'fixture default protocol changed: '+exact);
 assert(core.includes('return options.headless ? "chromium-headless-shell" : "chromium";'),'core executable selector changed');
 assert(core.includes('const registryExecutable = registry.findExecutable(this.getExecutableName(options));'),'registry selection changed');
 return {browserName:'chromium',headless:true,channel:null,executablePathOverride:null,connectOptions:null,executableName:'chromium-headless-shell',proof:'exact pinned config/spec/runner + exact fixture defaults + core registry selector; hostile environment refused'};
}
export async function resolveSelected({protocol,registry,browsers,browsersPath,inspectExecutable}){
 assert.equal(protocol.executableName,'chromium-headless-shell');assert.equal(protocol.headless,true);assert.equal(protocol.channel,null);
 const metadata=browsers.browsers.filter(b=>b.name===protocol.executableName);assert.equal(metadata.length,1);assert.equal(metadata[0].revision,'1234');assert.equal(metadata[0].browserVersion,'151.0.7922.34');
 const executable=registry.findExecutable(protocol.executableName);assert(executable);assert.equal(executable.name,protocol.executableName);assert.equal(executable.browserName,'chromium');
 const path=executable.executablePath('javascript');assert(typeof path==='string');assert(path.startsWith(browsersPath+'/chromium_headless_shell-1234/'),'registry returned wrong full-browser/channel path');
 const inspected=await inspectExecutable(path);assert.equal(inspected.realpath,path);assert.equal(inspected.regular,true);assert.equal(inspected.executable,true);assert(/^[a-f0-9]{64}$/.test(inspected.sha256));
 return {registryName:executable.name,browserName:executable.browserName,selectedExecutable:path,executableSha256:inspected.sha256,registryDescriptor:metadata[0]};
}
async function main(){
 const [scratch,output]=process.argv.slice(2);assert.equal(process.platform,'linux');assert.equal(process.arch,'x64');assert.equal(process.version,'v22.23.1');assert(!process.execArgv.some(x=>x.includes('preserve-symlinks')));
 const runtime=join(scratch,R),dep=join(scratch,'dependencies/app/node_modules');const pins=JSON.parse(readFileSync(join(runtime,'RUNTIME-PINS.json'))),extra=JSON.parse(readFileSync(join(O,'PROTOCOL-SOURCE-PINS.json'))),source=JSON.parse(readFileSync(join(scratch,'provenance/SOURCE-FILES.json')));
 const checked=(path,hash)=>{assert.equal(realpathSync(path),path);assert(lstatSync(path).isFile());const b=readFileSync(path);assert.equal(sha(b),hash,'metadata source hash mismatch: '+path);return b.toString('utf8');};
 const config=checked(join(runtime,'app/playwright.pwa.config.ts'),source['app/playwright.pwa.config.ts'].sha256),spec=checked(join(runtime,'app/e2e/upgrade-path.pwa.ts'),source['app/e2e/upgrade-path.pwa.ts'].sha256),runner=checked(join(runtime,'run-arm.mjs'),source['run-arm.mjs'].sha256);
 const fixture=checked(join(dep,'playwright/lib/index.js'),extra['playwright/lib/index.js'].sha256),browserBytes=checked(join(dep,'playwright-core/browsers.json'),extra['playwright-core/browsers.json'].sha256);
 const bundle=join(dep,'playwright-core/lib/coreBundle.js'),core=checked(bundle,pins.runtimeSources[bundle]);assert.equal(pins.runtimeSources[bundle],'3258d1cf334c6afc95f22aa9c292436cb976b391e0437f1359c83b84f0cb9d66');
 const browsersPath=realpathSync(process.env.PLAYWRIGHT_BROWSERS_PATH);assert.equal(process.env.PLAYWRIGHT_BROWSERS_PATH,browsersPath);
 const protocol=proveProtocol({config,spec,runner,fixture,core,env:process.env,browsersPath});
 // No public chromium.executablePath(): that resolves the full browser, not selected headless shell.
 const loaded=createRequire(import.meta.url)(bundle);const registry=loaded.registry.registry;assert(registry&&typeof registry.findExecutable==='function');
 const selected=await resolveSelected({protocol,registry,browsers:JSON.parse(browserBytes),browsersPath,inspectExecutable:async path=>{const s=lstatSync(path);return {realpath:realpathSync(path),regular:s.isFile()&&!s.isSymbolicLink(),executable:(s.mode&0o111)!==0,sha256:sha(readFileSync(path))};}});
 const result={protocol,...selected,platform:process.platform,arch:process.arch,nodeVersion:process.version,coreBundlePath:bundle,coreBundleSha256:sha(Buffer.from(core)),protocolSourcePins:extra,configSha256:source['app/playwright.pwa.config.ts'].sha256,specSha256:source['app/e2e/upgrade-path.pwa.ts'].sha256,runnerSha256:source['run-arm.mjs'].sha256,browsersJsonSha256:sha(Buffer.from(browserBytes)),playwrightEnvironment:assertMetadataEnvironment(process.env,browsersPath),browserLaunched:false,runtimeIdentityAuthority:'Browser.getVersion five fields in each unchanged arm'};
 writeFileSync(output,JSON.stringify(result,null,2)+'\n',{flag:'wx'});
}
if(process.argv[1]&&fileURLToPath(pathToFileURL(process.argv[1]))===fileURLToPath(import.meta.url))await main();
