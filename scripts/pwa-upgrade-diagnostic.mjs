// Isolated observer for the existing first PWA upgrade test. Never edits the
// source checkout, routes requests, changes storage, or relaxes assertions.
// Run with Node 22 after npm ci and Playwright Chromium installation in app/.
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import assert from 'node:assert/strict';

// This prefix is prepended ONLY to the disposable NEW built worker. It observes
// the original promise; it never substitutes a promise/Response, reads a body,
// extends an event lifetime or changes production source.
const responseProbe = String.raw`
;(() => {
  const prefix = '[forge-pwa-response-probe] ';
  const ids = new WeakMap();
  let sequence = 0;
  const emit = (kind, detail) => {
    try { console.debug(prefix + JSON.stringify({ kind, at: Date.now(), monotonicMs: performance.now(), ...detail })); }
    catch (_) { /* Diagnostic logging must not alter the response. */ }
  };
  const detail = event => {
    try {
      const url = new URL(event.request.url);
      if (url.origin !== self.location.origin || !/\.js$/.test(url.pathname)) return null;
      if (!ids.has(event)) ids.set(event, ++sequence);
      return { fetchId: ids.get(event), path: url.pathname, clientId: event.clientId,
        resultingClientId: event.resultingClientId, destination: event.request.destination,
        mode: event.request.mode };
    } catch (_) { return null; }
  };
  const errorDetail = error => {
    try { return { name: String(error?.name || typeof error), message: String(error?.message || error).slice(0, 500) }; }
    catch (_) { return { name: 'unreadable-error' }; }
  };
  self.addEventListener('fetch', event => {
    const info = detail(event);
    if (info) emit('fetch-enter', info);
  });
  const descriptor = Object.getOwnPropertyDescriptor(FetchEvent.prototype, 'respondWith');
  const native = descriptor.value;
  Object.defineProperty(FetchEvent.prototype, 'respondWith', {
    ...descriptor,
    value: function (...args) {
      let returned;
      // The first operation forwards the ORIGINAL argument list immediately.
      // A native synchronous exception is rethrown unchanged.
      try { returned = Reflect.apply(native, this, args); }
      catch (error) {
        const info = detail(this);
        if (info) emit('native-respondWith-throw', { ...info, error: errorDetail(error) });
        throw error;
      }
      try {
        const info = detail(this);
        if (info) {
          emit('respondWith-called', info);
          const fulfilled = response => {
            try { emit('response-fulfilled', { ...info, status: response.status, type: response.type,
              responsePath: response.url ? new URL(response.url).pathname : '', bodyUsed: response.bodyUsed }); }
            catch (error) { emit('metadata-error', { ...info, error: errorDetail(error) }); }
          };
          const rejected = error => emit('response-rejected', { ...info, error: errorDetail(error) });
          const value = args[0];
          if (value instanceof Promise) {
            // Attach a side observer to the already-passed native Promise.
            // Do not assimilate arbitrary thenables a second time.
            Reflect.apply(Promise.prototype.then, value, [fulfilled, rejected]);
          } else if (value instanceof Response) {
            fulfilled(value);
          } else {
            emit('unobserved-argument-type', { ...info, valueType: typeof value });
          }
        }
      } catch (_) { /* Never replace a successful native result with a probe failure. */ }
      return returned;
    },
  });
  emit('probe-ready', { scope: self.location.origin, observation: 'promise-settlement-only-not-body-delivery' });
})();
`;

if (process.argv.includes('--check-probe')) {
  const logs = [];
  const calls = [];
  const listeners = {};
  class ProbeResponse {
    status = 200; type = 'basic'; url = 'http://localhost:5298/assets/a.js?discard=query'; bodyUsed = false;
    get body() { throw new Error('Probe must never access body'); }
    clone() { throw new Error('Probe must never clone response'); }
  }
  class ProbeEvent {
    request = { url: 'http://localhost:5298/assets/a.js?discard=query', destination: 'script', mode: 'cors' };
    clientId = 'client'; resultingClientId = '';
    respondWith(...args) {
      calls.push({ receiver: this, args, logsBeforeNative: logs.length });
      if (this.nativeError) throw this.nativeError;
      return 'native-result';
    }
    waitUntil() { throw new Error('Probe must not extend lifetime'); }
  }
  runInNewContext(responseProbe, { FetchEvent: ProbeEvent, Response: ProbeResponse, Promise, URL,
    self: { location: { origin: 'http://localhost:5298' }, addEventListener: (kind, fn) => { listeners[kind] = fn; } },
    performance: { now: () => 1 }, console: { debug: text => logs.push(JSON.parse(text.slice(text.indexOf('{')))) } });
  const event = new ProbeEvent();
  listeners.fetch(event);
  const response = new ProbeResponse();
  const value = Promise.resolve(response);
  const before = logs.length;
  assert.equal(event.respondWith(value), 'native-result');
  assert.equal(calls[0].receiver, event);
  assert.equal(calls[0].args[0], value);
  assert.equal(calls[0].logsBeforeNative, before);
  await Promise.resolve();
  assert.equal(logs.find(log => log.kind === 'response-fulfilled').responsePath, '/assets/a.js');
  assert.equal(response.bodyUsed, false);
  const rejection = new Error('fixture rejection');
  event.respondWith(Promise.reject(rejection));
  await Promise.resolve();
  assert.equal(logs.find(log => log.kind === 'response-rejected').error.message, rejection.message);
  const nativeError = new Error('native failure');
  const throwing = new ProbeEvent(); throwing.nativeError = nativeError;
  assert.throws(() => throwing.respondWith(value), error => error === nativeError);
  let assimilations = 0;
  event.respondWith({ then() { assimilations++; } });
  assert.equal(assimilations, 0);
  assert.ok(logs.some(log => log.kind === 'unobserved-argument-type'));
  assert.ok(logs.every(log => !JSON.stringify(log).includes('discard=query')));
  console.log('Response probe checks passed: original receiver/argument/result, immediate native call, fulfillment/rejection, unchanged native throw, no body/lifetime access, no extra thenable assimilation, query omission.');
  process.exit(0);
}

const repo = resolve(process.env.PWA_DIAGNOSTIC_REPO || '.');
const out = resolve(process.env.PWA_DIAGNOSTIC_OUT || 'pwa-upgrade-diagnostic-output');
const oldRef = process.env.PWA_DIAGNOSTIC_OLD_REF;
const newRef = process.env.PWA_DIAGNOSTIC_NEW_REF;
for (const [name, value] of Object.entries({ oldRef, newRef })) {
  if (!/^[a-f0-9]{40}$/.test(value || '')) throw new Error(`${name} must be a full pinned commit SHA`);
}
const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
if (git('rev-parse', 'HEAD') !== newRef) throw new Error('Candidate HEAD differs from pinned newRef');
git('cat-file', '-e', `${oldRef}^{commit}`);
const port = Number(process.env.IW_MAP_PORT || 5298);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid dedicated port');
if (existsSync(out)) throw new Error('Output directory must be new; never overwrite another diagnostic run');
mkdirSync(out, { recursive: true });
const work = mkdtempSync(join(tmpdir(), 'forge-pwa-observer-'));
const app = join(repo, 'app');
const modules = join(app, 'node_modules');
const cache = join(work, 'cache');
mkdirSync(cache);
symlinkSync(modules, join(work, 'node_modules'), 'dir');
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const source = readFileSync(join(app, 'e2e/upgrade-path.pwa.ts'), 'utf8');
const originalImport = 'import { expect, test, type Page, type Worker } from "@playwright/test";';
const observerImport = 'import { expect, test, type Page, type Worker } from "./observer";';
if (source.split(originalImport).length !== 2) throw new Error('Expected exactly one known Playwright import');
const generated = source.replace(originalImport, observerImport);
if (generated.replace(observerImport, originalImport) !== source) throw new Error('Spec assertions changed');
const tests = join(work, 'tests');
mkdirSync(tests);
const spec = join(tests, 'upgrade-path.pwa.ts');
writeFileSync(spec, generated);
mkdirSync(join(tests, 'support'));
writeFileSync(join(tests, 'support/pwa.ts'), readFileSync(join(app, 'e2e/support/pwa.ts')));

// Separate CDP sessions are observers. In particular, never use Fetch.enable,
// request interception, debugger pauses, cache disabling or SW stop commands.
const observer = String.raw`
import { test as base, expect } from '@playwright/test';
import { createWriteStream } from 'node:fs';
import { join } from 'node:path';
export { expect };
export type { Page, Worker } from '@playwright/test';
export const test = base.extend({
  page: async ({ page, context, browser }, use, testInfo) => {
    const path = join(process.env.PWA_DIAGNOSTIC_OUT!, 'cdp-events.ndjson');
    const stream = createWriteStream(path, { flags: 'wx' });
    let seq = 0;
    const log = (scope: string, event: string, params: unknown) => stream.write(JSON.stringify({
      seq: ++seq, observedAt: Date.now(), scope, event, params,
    }) + '\n');
    stream.on('error', error => console.error('Diagnostic output error', error));
    const pageSession = await context.newCDPSession(page);
    const browserSession = await browser.newBrowserCDPSession();
    const workerSessions = new Set<string>();
    let workerCommand = 0;
    const pageEvents = [
      'Network.requestWillBeSent', 'Network.requestWillBeSentExtraInfo',
      'Network.responseReceived', 'Network.responseReceivedExtraInfo',
      'Network.requestServedFromCache', 'Network.loadingFinished', 'Network.loadingFailed',
      'Page.frameRequestedNavigation', 'Page.frameScheduledNavigation',
      'Page.frameNavigated', 'Page.frameStartedLoading', 'Page.frameStoppedLoading',
      'Page.lifecycleEvent', 'Runtime.exceptionThrown', 'Runtime.consoleAPICalled',
      'ServiceWorker.workerRegistrationUpdated', 'ServiceWorker.workerVersionUpdated',
      'ServiceWorker.workerErrorReported',
    ];
    for (const event of pageEvents) pageSession.on(event as never, params => log('page', event, params));
    browserSession.on('Target.receivedMessageFromTarget', ({ sessionId, message, targetId }) => {
      if (!workerSessions.has(sessionId)) return;
      log('worker', 'protocol', { sessionId, targetId, message: JSON.parse(message) });
    });
    browserSession.on('Target.detachedFromTarget', params => log('browser', 'Target.detachedFromTarget', params));
    browserSession.on('Target.targetInfoChanged', params => log('browser', 'Target.targetInfoChanged', params));
    browserSession.on('Target.targetDestroyed', params => log('browser', 'Target.targetDestroyed', params));
    // Discover then attach on a separate observer session, without pausing.
    // Browser-level autoAttach requires flattened sessions, which Playwright's
    // public CDPSession cannot address. Explicit attach supports message routing.
    // The short unobserved attachment interval is logged, not hidden.
    browserSession.on('Target.targetCreated', ({ targetInfo }) => {
      if (targetInfo.type !== 'service_worker') return;
      log('browser', 'Target.targetCreated', { targetInfo });
      void (async () => {
        const { sessionId } = await browserSession.send('Target.attachToTarget', {
          targetId: targetInfo.targetId, flatten: false,
        });
        workerSessions.add(sessionId);
        log('browser', 'worker-observer-attached', { sessionId, targetInfo });
        for (const method of ['Network.enable', 'Runtime.enable']) {
          await browserSession.send('Target.sendMessageToTarget', {
            sessionId, message: JSON.stringify({ id: ++workerCommand, method }),
          });
        }
      })().catch(error => log('observer', 'worker-enable-error', String(error)));
    });
    try {
      await pageSession.send('Network.enable');
      await pageSession.send('Page.enable');
      await pageSession.send('Page.setLifecycleEventsEnabled', { enabled: true });
      await pageSession.send('Runtime.enable');
      await pageSession.send('ServiceWorker.enable');
      await browserSession.send('Target.setDiscoverTargets', { discover: true });
      log('observer', 'ready-before-first-navigation', { browser: browser.version(), test: testInfo.title });
      await use(page);
    } finally {
      log('observer', 'test-finished', { status: testInfo.status, expectedStatus: testInfo.expectedStatus });
      await browserSession.detach().catch(error => log('observer', 'detach-error', String(error)));
      await pageSession.detach().catch(error => log('observer', 'detach-error', String(error)));
      await new Promise<void>((resolve, reject) => { stream.once('error', reject); stream.end(resolve); });
      await testInfo.attach('raw-page-worker-cdp', { path, contentType: 'application/x-ndjson' });
    }
  },
});
`;
writeFileSync(join(tests, 'observer.ts'), observer);
const config = `import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: ${JSON.stringify(tests)}, testMatch: 'upgrade-path.pwa.ts',
  grep: /a phone on the previous build opens/, workers: 1, fullyParallel: false,
  retries: 0, repeatEach: 1, timeout: 240000, expect: { timeout: 30000 },
  outputDir: ${JSON.stringify(join(out, 'test-results'))}, reporter: [['list']],
  use: { browserName: 'chromium', baseURL: 'http://localhost:${port}',
    viewport: { width: 390, height: 844 }, deviceScaleFactor: 2,
    serviceWorkers: 'allow', trace: 'on', video: 'off',
    launchOptions: { args: [${JSON.stringify('--log-net-log=' + join(out, 'netlog.json'))}] },
  },
  webServer: {
    command: ${JSON.stringify(`${JSON.stringify(process.execPath)} --experimental-strip-types ${JSON.stringify(join(app, 'e2e/support/pwaHarness.ts'))}`)},
    cwd: ${JSON.stringify(app)}, url: 'http://localhost:${port}/',
    reuseExistingServer: false, timeout: 30000, stdout: 'ignore', stderr: 'pipe',
  },
});`;
writeFileSync(join(work, 'playwright.config.ts'), config);
writeFileSync(join(out, 'spec-observed.ts'), generated);
writeFileSync(join(out, 'observer.ts'), observer);
writeFileSync(join(out, 'playwright.config.ts'), config);
const metadata = {
  oldRef, newRef, port, work, candidateRepo: repo,
  specOriginalSha256: sha256(source), specObservedSha256: sha256(generated),
  specRoundTripIdentical: true, node: process.version, platform: process.platform,
  lockSha256: sha256(readFileSync(join(app, 'package-lock.json'))),
  responseProbe: { enabled: true, newBuiltWorkerOnly: true, promiseOutcomeIsNotBodyDelivery: true },
  limitations: ['CDP attachment does not pause workers; earliest worker events may precede Network.enable.',
    'Worker CDP reports outbound fetches, not every cache-served FetchEvent response. NetLog complements it.',
    'The isolated new built worker has a respondWith promise-settlement side observer; successful settlement does not prove body delivery.',
    'Observer and NetLog overhead may change timing. A pass does not disprove earlier failures.'],
};
writeFileSync(join(out, 'metadata.json'), JSON.stringify(metadata, null, 2));
if (process.argv.includes('--prepare-only')) {
  console.log(`Prepared observer at ${work}; no browser/build started.`);
  process.exit(0);
}
const oldSource = join(work, 'old-source');
mkdirSync(oldSource);
const tar = join(work, 'old.tar');
execFileSync('git', ['-C', repo, 'archive', '--format=tar', '-o', tar, oldRef]);
execFileSync('tar', ['-xf', tar, '-C', oldSource]);
symlinkSync(modules, join(oldSource, 'app/node_modules'), 'dir');
metadata.builds = {};
for (const [name, src, ref] of [['old', join(oldSource, 'app'), oldRef], ['new', app, newRef]]) {
  const dist = join(cache, `${name}-dist`);
  const buildId = `${name}-${ref.slice(0, 7)}`;
  execFileSync(join(modules, '.bin/vite'), ['build', '--outDir', dist, '--emptyOutDir'], {
    cwd: src, stdio: 'inherit', env: { ...process.env, VITE_BASE: '/',
      VITE_SUPABASE_URL: 'https://e2efixture.supabase.co',
      VITE_SUPABASE_ANON_KEY: 'sb_publishable_e2e_fixture_not_a_secret', VITE_BUILD_ID: buildId },
  });
  const html = readFileSync(join(dist, 'index.html'), 'utf8');
  const entry = /<script type="module" crossorigin src="\/(assets\/index-[\w-]+\.js)"/.exec(html)?.[1];
  if (!entry) throw new Error(`Missing ${name} entry`);
  metadata.builds[name] = { buildId, entry, htmlSha256: sha256(html),
    entrySha256: sha256(readFileSync(join(dist, entry))),
    workerSha256: sha256(readFileSync(join(dist, 'sw.js'))) };
  if (name === 'new') {
    const originalWorker = readFileSync(join(dist, 'sw.js'), 'utf8');
    writeFileSync(join(out, 'new-sw-original.js'), originalWorker);
    writeFileSync(join(out, 'response-probe.js'), responseProbe);
    // Keep the compiled module byte-for-byte after the labelled prefix. The
    // original hash above remains the baseline; served hash is explicit.
    const observedWorker = responseProbe + '\n' + originalWorker;
    writeFileSync(join(dist, 'sw.js'), observedWorker);
    writeFileSync(join(out, 'new-sw-observed.js'), observedWorker);
    metadata.builds[name].servedWorkerSha256 = sha256(observedWorker);
    metadata.builds[name].responseProbeSha256 = sha256(responseProbe);
  }
  writeFileSync(join(out, `${name}-index.html`), html);
}
writeFileSync(join(out, 'metadata.json'), JSON.stringify(metadata, null, 2));
const result = spawnSync(process.execPath, [join(modules, '@playwright/test/cli.js'), 'test',
  '--config', join(work, 'playwright.config.ts')], {
  cwd: work, stdio: 'inherit', env: { ...process.env, IW_MAP_PORT: String(port),
    IW_PWA_CACHE: cache, IW_PWA_REUSE: '1', PWA_DIAGNOSTIC_OUT: out },
});
metadata.exitCode = result.status;
metadata.signal = result.signal;
metadata.launchError = result.error?.message;
// Collector failures are distinct from product-test failures. Never silently
// call a test pass useful evidence when worker attachment or NetLog failed.
try {
  const events = readFileSync(join(out, 'cdp-events.ndjson'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  const ready = events.find(event => event.event === 'ready-before-first-navigation');
  const firstDocument = events.find(event => event.event === 'Network.requestWillBeSent' && event.params.type === 'Document');
  const workerProtocols = events.filter(event => event.scope === 'worker' && event.event === 'protocol');
  const workerSessions = new Set(workerProtocols.map(event => event.params.sessionId));
  const collectorErrors = events.filter(event => event.event === 'worker-enable-error' ||
    (event.event === 'protocol' && event.params.message.error));
  const netlog = JSON.parse(readFileSync(join(out, 'netlog.json'), 'utf8'));
  const responseOutcomes = workerProtocols.flatMap(event => {
    const message = event.params.message;
    if (message.method !== 'Runtime.consoleAPICalled') return [];
    return (message.params.args || []).flatMap(arg => {
      if (typeof arg.value !== 'string' || !arg.value.startsWith('[forge-pwa-response-probe] ')) return [];
      return [{ sessionId: event.params.sessionId, targetId: event.params.targetId,
        observedAt: event.observedAt, seq: event.seq, ...JSON.parse(arg.value.slice('[forge-pwa-response-probe] '.length)) }];
    });
  });
  writeFileSync(join(out, 'worker-response-outcomes.ndjson'), responseOutcomes.map(row => JSON.stringify(row)).join('\n') + '\n');
  metadata.collector = {
    events: events.length, readyBeforeFirstDocument: Boolean(ready && firstDocument && ready.seq < firstDocument.seq),
    workerSessions: workerSessions.size,
    workerRequests: workerProtocols.filter(event => event.params.message.method === 'Network.requestWillBeSent').length,
    collectorErrors, netlogEvents: netlog.events.length,
    responseProbeEvents: responseOutcomes.length,
    responseFulfilled: responseOutcomes.filter(row => row.kind === 'response-fulfilled').length,
    responseRejected: responseOutcomes.filter(row => row.kind === 'response-rejected').length,
    responseProbeUnobserved: responseOutcomes.filter(row => ['metadata-error', 'unobserved-argument-type'].includes(row.kind)).length,
  };
  metadata.collectorComplete = metadata.collector.readyBeforeFirstDocument && workerSessions.size >= 2 &&
    metadata.collector.workerRequests > 0 && collectorErrors.length === 0 && netlog.events.length > 0 &&
    metadata.collector.responseFulfilled > 0 && metadata.collector.responseProbeUnobserved === 0;
} catch (error) {
  metadata.collectorComplete = false;
  metadata.collectorError = String(error);
}
writeFileSync(join(out, 'metadata.json'), JSON.stringify(metadata, null, 2));
console.log('Diagnostic capture:', JSON.stringify({ testExitCode: result.status,
  collectorComplete: metadata.collectorComplete, collector: metadata.collector, collectorError: metadata.collectorError }));
process.exit(result.status === 0 && metadata.collectorComplete ? 0 : (result.status || 1));
