// A phone carrying yesterday's service worker into today's deploy (run with
// `npx playwright test --config playwright.pwa.config.ts`).
//
// This is the test that would have caught 2026-09-25. #664 fixed the offline
// cold start and passed every check in the repo, because every check looked
// at ONE build: the dev server, a fresh browser profile on the new build, the
// bundle on disk. What broke only existed between two builds. A phone whose
// worker still held the previous build loaded that build's index.html and
// entry from the worker's copy, and the entry asked the NETWORK for one file
// the worker had never saved — a file the new deploy no longer had. Black
// screen, on every phone and laptop with the app installed, and because the
// app could not start it could not notice the new build and update itself
// either. The harness (e2e/support/pwaHarness.ts) serves the build phones
// are running today (origin/master) and this tree from one origin, so the
// first test walks exactly that path: install the old worker, deploy the new
// build, let the browser cache expire, reopen.
//
// The other two are the "new version" banner coming back after Refresh, which
// the owner hit about seven times that afternoon, after the rollback. Both
// are shapes where the new worker takes over but the page is never reloaded
// onto it, so the banner's ten-second fallback offers Refresh again, and
// Refresh has nothing left to post to. They were reproduced here first and
// fixed in PwaBanners.tsx; see the notes on each.

import { expect, test, type Page, type Worker } from "@playwright/test";
import { preparePwaEngineTrace } from "./support/pwaEngineTrace";
import {
  cutTheNetwork,
  expireBrowserCache,
  failedAppFiles,
  harnessState,
  nudgeUpdateCheck,
  runningEntry,
  serveBuild,
  serviceWorkerReady,
  signInButton,
  updateBanner,
} from "./support/pwa";

/** Count page loads from now on, to prove a switch happened once and only once. */
function countLoads(page: Page): { loads: () => number } {
  let n = 0;
  page.on("load", () => {
    n += 1;
  });
  return { loads: () => n };
}

/**
 * Count the page's own document navigations from now on, including one that
 * another navigation cancels (it never fires `load`, so countLoads misses
 * it). The switch to a new build must be ONE navigation. On 2026-09-28 it
 * was two: the page reloaded itself when the new worker took control, the
 * worker navigated it as well, the second cancelled the first, and three of
 * the new entry's imports were aborted along the way. The new build never
 * started, and the app stayed blank until it was reopened. That race is
 * lost only sometimes, but both navigations happen every time, so counting
 * them fails every time.
 */
function countNavigations(page: Page): { navigations: () => string[] } {
  const seen: string[] = [];
  page.on("request", (req) => {
    if (req.isNavigationRequest() && req.frame() === page.mainFrame()) seen.push(req.url());
  });
  return { navigations: () => [...seen] };
}

/** After the switch: the new build stays, nothing reloads again, no banner returns. */
async function expectSettledOn(page: Page, entry: string, loads: () => number) {
  const after = loads();
  await page.waitForTimeout(15_000);
  expect(loads(), "the page reloaded again after switching").toBe(after);
  await expect(updateBanner(page), "the update banner came back after the switch").toHaveCount(0);
  expect(await runningEntry(page)).toBe(entry);
  await expect(signInButton(page)).toBeVisible();
}

test("a phone on the previous build opens the app after a deploy, then switches to the new build, once", async ({
  page,
  context,
  request,
}) => {
  const bootErrors: string[] = [];
  await page.addInitScript(() => {
    (window as Window & { __emptyBootRecoveryAtNavigation?: string | null }).__emptyBootRecoveryAtNavigation =
      sessionStorage.getItem("wops-empty-boot-diagnostic");
    // Persist the first document's timing across a watchdog reload. A later
    // screenshot alone cannot tell whether imports failed during activation
    // or were cancelled by the recovery navigation.
    const timelineKey = "wops-e2e-upgrade-timeline";
    const note = (event: string, detail?: string) => {
      const prior = JSON.parse(sessionStorage.getItem(timelineKey) || "[]") as unknown[];
      prior.push({ at: Date.now(), event, detail });
      sessionStorage.setItem(timelineKey, JSON.stringify(prior.slice(-80)));
    };
    note("document-start", document.URL);
    window.addEventListener("load", () => {
      note("load", JSON.stringify({
        bootStarted: document.documentElement.dataset.forgeBootStarted ?? null,
        controllerState: navigator.serviceWorker?.controller?.state ?? null,
        resources: performance.getEntriesByType("resource")
          .filter((entry) => /\.(js|css)(\?|$)/.test(entry.name))
          .slice(-12)
          .map((entry) => ({ path: new URL(entry.name).pathname, duration: entry.duration })),
      }));
    });
    window.addEventListener("error", (event) => {
      const target = event.target;
      if (target instanceof HTMLScriptElement || target instanceof HTMLLinkElement) {
        note("resource-error", target.getAttribute("src") || target.getAttribute("href") || "unknown");
      } else if (event instanceof ErrorEvent) {
        note("window-error", event.message);
      }
    }, true);
    window.addEventListener("unhandledrejection", (event) => note("unhandled-rejection", String(event.reason)));
    navigator.serviceWorker?.addEventListener("controllerchange", () => {
      const controller = navigator.serviceWorker.controller;
      note("controllerchange", controller?.state || "no-controller");
      controller?.addEventListener("statechange", () => note("controller-state", controller.state));
    });
  });
  page.on("pageerror", (error) => bootErrors.push(`pageerror: ${error.stack ?? error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") bootErrors.push(`console: ${message.text()}`);
  });
  const { builds } = await harnessState(request);
  expect(builds.old.entry, "the two builds are different builds").not.toBe(builds.new.entry);

  // Yesterday: the phone opened Forge and its worker installed the build of
  // the day. Opened once more, so the page is a returning one (registered
  // with a worker already in control — the shape every later open has).
  await serveBuild(request, "old");
  await page.goto("/");
  await expect(signInButton(page)).toBeVisible();
  await serviceWorkerReady(page);
  await page.goto("/");
  await expect(signInButton(page)).toBeVisible();
  expect(await runningEntry(page)).toBe(builds.old.entry);

  // The app is closed. A deploy lands. More than ten minutes pass, so the
  // browser's own cache (max-age=600) is empty: whatever the old worker did
  // not save has to come from today's server.
  await page.goto("about:blank");
  await serveBuild(request, "new");
  await expireBrowserCache(page, context);

  // Today: the phone opens the app. The old worker answers with the old
  // shell, and the old shell has to be able to start.
  const failed = failedAppFiles(page);
  const { loads } = countLoads(page);
  await page.goto("/");
  const started = await signInButton(page)
    .waitFor({ timeout: 30_000 })
    .then(
      () => true,
      () => false,
    );
  expect(
    failed,
    "files the previous build's shell asked today's server for and did not get — the 2026-09-25 black screen",
  ).toEqual([]);
  expect(started, "the previous build's shell never drew its first screen").toBe(true);
  bootErrors.length = 0;

  // Then it notices the new build, downloads it, and — on the sign-in screen,
  // where there is nothing to lose — switches over by itself.
  const navigationTimes: number[] = [];
  page.on("request", (req) => {
    if (req.isNavigationRequest() && req.frame() === page.mainFrame()) navigationTimes.push(Date.now());
  });
  const failedNetwork: { at: number; url: string; error: string; canceled: boolean }[] = [];
  const requestUrls = new Map<string, string>();
  const cdp = await context.newCDPSession(page);
  await cdp.send("Network.enable");
  cdp.on("Network.requestWillBeSent", (event: { requestId: string; request: { url: string } }) => {
    requestUrls.set(event.requestId, event.request.url);
  });
  cdp.on("Network.loadingFailed", (event: { requestId: string; errorText: string; canceled?: boolean }) => {
    const url = requestUrls.get(event.requestId);
    if (url && /\.(js|css)(\?|$)/.test(url)) {
      failedNetwork.push({ at: Date.now(), url: new URL(url).pathname, error: event.errorText, canceled: Boolean(event.canceled) });
    }
  });
  const { navigations } = countNavigations(page);
  await expect
    .poll(() => runningEntry(page), {
      timeout: 120_000,
      message: "the app never switched to the new build",
    })
    .toBe(builds.new.entry);
  try {
    await expect(signInButton(page)).toBeVisible();
  } catch (error) {
    // A script tag only proves HTML parsed. If the new shell is blank, keep
    // the browser evidence that distinguishes a failed import from a stalled
    // mount or a later runtime error.
    const state = await page.evaluate(() => ({
      readyState: document.readyState,
      rootText: document.getElementById("root")?.textContent?.slice(0, 500) ?? null,
      rootChildren: document.getElementById("root")?.childElementCount ?? null,
      entry: document.querySelector<HTMLScriptElement>('script[type="module"][src]')?.src ?? null,
      controller: navigator.serviceWorker.controller?.scriptURL ?? null,
      resources: performance.getEntriesByType("resource")
        .filter((entry) => /\.(js|css)(\?|$)/.test(entry.name))
        .slice(-12)
        .map((entry) => ({ name: entry.name, duration: entry.duration })),
    })).catch((readError) => ({ readError: String(readError) }));
    await test.info().attach("new-build-boot.json", {
      body: JSON.stringify({ state, bootErrors, failedAppFiles: failed }, null, 2),
      contentType: "application/json",
    });
    throw error;
  }

  // Once: no second reload, no banner asking again.
  await expectSettledOn(page, builds.new.entry, loads);
  if (navigations().length !== 1) {
    const emptyBootRecovery = await page.evaluate(() =>
      (window as Window & { __emptyBootRecoveryAtNavigation?: string | null }).__emptyBootRecoveryAtNavigation ?? null,
    );
    const browserTimeline = await page.evaluate(() =>
      JSON.parse(sessionStorage.getItem("wops-e2e-upgrade-timeline") || "[]"),
    );
    await test.info().attach("upgrade-reload-evidence.json", {
      body: JSON.stringify({ navigations: navigations().map((url, i) => ({ url, at: navigationTimes[i] })), emptyBootRecovery, browserTimeline, failedNetwork, bootErrors }, null, 2),
      contentType: "application/json",
    });
  }
  expect(navigations(), "the switch was more than one navigation: two racing reloads can leave the new build blank").toHaveLength(1);

  // And the new worker is the one in charge now: the next open with no
  // signal comes entirely from the new build's copy.
  await cutTheNetwork(page, context);
  const offlineFailed = failedAppFiles(page);
  await page.reload();
  await expect(signInButton(page)).toBeVisible();
  expect(offlineFailed, "files the new build needed offline that its worker did not have").toEqual([]);
  expect(await runningEntry(page)).toBe(builds.new.entry);
});

test("a phone whose very first session sees a deploy switches over, instead of offering Refresh for ever", async ({
  page,
  request,
}) => {
  // The shape: a browser that has never had the app — a laptop opening the
  // site, a phone after "clear site data" — registers its first worker with
  // no worker in control. vite-plugin-pwa remembers that, and when a LATER
  // worker takes over in the same session it does not reload the page
  // (workbox-window reports the takeover as not-an-update). The new worker
  // is in charge, the old shell is still on screen, and the banner's
  // fallback offers Refresh again — which now has nothing to post to.
  const { builds } = await harnessState(request);
  await serveBuild(request, "old");
  await page.goto("/");
  await expect(signInButton(page)).toBeVisible();
  await serviceWorkerReady(page);
  expect(await runningEntry(page)).toBe(builds.old.entry);

  // A deploy lands while the app is open; the person comes back to it.
  await serveBuild(request, "new");
  const { loads } = countLoads(page);
  const { navigations } = countNavigations(page);
  await nudgeUpdateCheck(page);
  await expect
    .poll(() => runningEntry(page), {
      timeout: 120_000,
      message:
        "the new worker took over but the page never reloaded onto it — from here Refresh does nothing and the banner keeps coming back",
    })
    .toBe(builds.new.entry);
  await expectSettledOn(page, builds.new.entry, loads);
  expect(navigations(), "the switch was more than one navigation: two racing reloads can leave the new build blank").toHaveLength(1);
});

test("an in-flight self reload is not cancelled when the new worker's shell lookup takes five seconds", async ({
  page,
  context,
  request,
}) => {
  const { builds } = await harnessState(request);
  await serveBuild(request, "old");
  await page.goto("/");
  await expect(signInButton(page)).toBeVisible();
  await serviceWorkerReady(page);

  // Instrument the newly installed worker before its navigation route runs.
  // A slow response used to hide the first reload from the observer until
  // after the grace period, when the worker started a second navigation.
  const instrumented = new Promise<Worker>((resolve, reject) => {
    context.on("serviceworker", (worker) => {
      void worker.evaluate(() => {
        const probe = self as unknown as { __slowShellLookups: number; registration: ServiceWorkerRegistration };
        probe.__slowShellLookups = 0;
        const original = CacheStorage.prototype.match;
        CacheStorage.prototype.match = async function (request, options) {
          const url = request instanceof Request ? request.url : String(request);
          if (new URL(url, self.location.href).pathname === "/index.html" && probe.registration.active?.state === "activated") {
            probe.__slowShellLookups += 1;
            await new Promise((done) => setTimeout(done, 5_000));
          }
          return original.call(this, request, options);
        };
      }).then(() => resolve(worker), reject);
    });
  });

  await serveBuild(request, "new");
  const { navigations } = countNavigations(page);
  await nudgeUpdateCheck(page);
  const worker = await instrumented;
  await expect.poll(() => runningEntry(page), { timeout: 60_000 }).toBe(builds.new.entry);
  await expect(signInButton(page)).toBeVisible();
  expect(await worker.evaluate(() => (self as unknown as { __slowShellLookups: number }).__slowShellLookups)).toBeGreaterThan(0);
  expect(navigations(), "the worker cancelled an in-flight self reload").toHaveLength(1);
});

test("a second tab on the same URL can reload without suppressing the asking tab", async ({
  page,
  context,
  request,
}) => {
  const { builds } = await harnessState(request);
  await serveBuild(request, "old");
  await page.goto("/");
  await expect(signInButton(page)).toBeVisible();
  await serviceWorkerReady(page);
  const other = await context.newPage();
  await other.goto("/");
  await expect(signInButton(other)).toBeVisible();
  await serviceWorkerReady(other);
  expect(other.url()).toBe(page.url());

  await page.exposeFunction("reloadOtherTab", async () => { await other.reload(); });
  await page.evaluate(() => {
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      void (window as unknown as { reloadOtherTab: () => Promise<void> }).reloadOtherTab();
    }, { once: true });
  });
  await serveBuild(request, "new");
  const { navigations } = countNavigations(page);
  await nudgeUpdateCheck(page);
  await expect.poll(() => runningEntry(page), { timeout: 60_000 }).toBe(builds.new.entry);
  await expect.poll(() => runningEntry(other), { timeout: 60_000 }).toBe(builds.new.entry);
  await expect(signInButton(page)).toBeVisible();
  expect(navigations(), "the asking tab must switch exactly once").toHaveLength(1);
});

test("a download that broke halfway does not leave Refresh doing nothing afterwards", async ({
  page,
  request,
}) => {
  // Four deploys landed within an hour on 2026-09-25. A check that lands
  // while a deploy is half there downloads a worker whose file list names a
  // chunk the server does not have yet, so that install fails. The NEXT
  // check succeeds — but workbox-window stopped watching after the first
  // update it judged external, so vite-plugin-pwa never learns of the second
  // worker and never attaches its reload. The app itself sees the second
  // worker waiting, asks it to take over, it does, and the page stays on the
  // old shell: Refresh, ten seconds, Refresh, ten seconds.
  const causal: unknown[] = [];
  const network: unknown[] = [];
  const activationGateTreatment=process.env.IW_PWA_ACTIVATION_GATE_COMPARE==='1' && test.info().repeatEachIndex%2===1;
  const cdp=await page.context().newCDPSession(page);
  await cdp.send('Network.enable');
  const engineTrace=process.env.IW_PWA_ENGINE_TRACE==='1'
    ? await preparePwaEngineTrace(page,cdp,test.info()) : null;
  const tracked=new Set<string>();
  cdp.on('Network.requestWillBeSent',event=>{
    if(event.type==='Document' || /\.(?:js|css)(?:\?|$)/.test(event.request.url)){
      tracked.add(event.requestId);
      network.push({event:'request',at:Date.now(),timestamp:event.timestamp,requestId:event.requestId,loaderId:event.loaderId,url:event.request.url,type:event.type,
        initiator:{type:event.initiator.type,url:event.initiator.url,line:event.initiator.lineNumber,stack:event.initiator.stack?.callFrames.slice(0,3)}});
    }
  });
  cdp.on('Network.responseReceived',event=>{if(tracked.has(event.requestId))network.push({event:'response',at:Date.now(),requestId:event.requestId,
    timestamp:event.timestamp,status:event.response.status,mimeType:event.response.mimeType,fromServiceWorker:event.response.fromServiceWorker,fromDiskCache:event.response.fromDiskCache,fromPrefetchCache:event.response.fromPrefetchCache});});
  cdp.on('Network.loadingFinished',event=>{if(tracked.has(event.requestId))network.push({event:'finished',at:Date.now(),timestamp:event.timestamp,requestId:event.requestId,encodedDataLength:event.encodedDataLength});});
  cdp.on('Network.loadingFailed',event=>{if(tracked.has(event.requestId))network.push({event:'failed',at:Date.now(),requestId:event.requestId,
    timestamp:event.timestamp,type:event.type,error:event.errorText,canceled:event.canceled,blockedReason:event.blockedReason});});
  page.on('pageerror',error=>causal.push({event:'pageerror',at:Date.now(),message:error.message,stack:error.stack}));
  page.context().on("console", message => {
    if (message.text().startsWith("FORGE-PWA-")) causal.push({event:"console",at:Date.now(),text:message.text(),location:message.location()});
  });
  page.on("request", req => { if(req.isNavigationRequest())causal.push({event:"navigation-request",at:Date.now(),url:req.url()}); });
  await page.addInitScript((gateTreatment:boolean) => {
    const key="wops-e2e-half-download-causal";
    const note=(event:string,detail:unknown=null)=>{
      const old=JSON.parse(sessionStorage.getItem(key)||"[]") as unknown[];
      old.push({event,at:Date.now(),detail});sessionStorage.setItem(key,JSON.stringify(old.slice(-100)));
    };
    note("document-start", {empty:sessionStorage.getItem("wops-empty-boot-diagnostic"),reload:sessionStorage.getItem("wops-update-reload-diagnostic")});
    window.addEventListener("load",()=>note("load",{boot:document.documentElement.dataset.forgeBootStarted,rootChildren:document.getElementById("root")?.childElementCount}));
    window.addEventListener("beforeunload",()=>note("beforeunload",{boot:document.documentElement.dataset.forgeBootStarted,empty:sessionStorage.getItem("wops-empty-boot-diagnostic"),reload:sessionStorage.getItem("wops-update-reload-diagnostic")}));
    // Diagnostic event-delivery treatment only; archived app and worker bytes
    // remain unchanged. Arm only for the successful second update below.
    const gateWindow=window as unknown as {__pwaActivationGateArmed?:boolean};
    let forwarding=false;
    navigator.serviceWorker.addEventListener('controllerchange',event=>{
      if(!gateTreatment || !gateWindow.__pwaActivationGateArmed || forwarding)return;
      gateWindow.__pwaActivationGateArmed=false;
      const controller=navigator.serviceWorker.controller;
      note('gate-native',{url:controller?.scriptURL,state:controller?.state,trusted:event.isTrusted});
      if(!controller || controller.state!=='activating'){note('gate-invalid',{reason:'controller_not_activating'});return;}
      event.stopImmediatePropagation();
      const deadline=setTimeout(()=>{note('gate-invalid',{reason:'activation_timeout',state:controller.state});},8000);
      const changed=()=>{
        if(controller.state==='redundant'){clearTimeout(deadline);controller.removeEventListener('statechange',changed);note('gate-invalid',{reason:'controller_redundant'});return;}
        if(controller.state!=='activated')return;
        clearTimeout(deadline);controller.removeEventListener('statechange',changed);
        if(navigator.serviceWorker.controller!==controller){note('gate-invalid',{reason:'controller_replaced'});return;}
        note('gate-forward',{url:controller.scriptURL,state:controller.state});
        forwarding=true;navigator.serviceWorker.dispatchEvent(new Event('controllerchange'));forwarding=false;
      };
      controller.addEventListener('statechange',changed);changed();
    },true);
    navigator.serviceWorker.addEventListener("controllerchange",()=>{
      const controller=navigator.serviceWorker.controller;
      note("controllerchange",{url:controller?.scriptURL,state:controller?.state});
      controller?.addEventListener('statechange',()=>note('controller-state',{url:controller.scriptURL,state:controller.state}));
    });
    const post=ServiceWorker.prototype.postMessage;
    ServiceWorker.prototype.postMessage=function(message:unknown,options?:Transferable[]|StructuredSerializeOptions){note("post-message",{url:this.scriptURL,type:(message as {type?:unknown})?.type});return Reflect.apply(post,this,[message,options]);};
    window.addEventListener("error",(e:Event)=>{
      const target=e.target;
      const url=target instanceof HTMLScriptElement?target.src:target instanceof HTMLLinkElement?target.href:null;
      const entries=url?performance.getEntriesByName(url).map(entry=>{
        const r=entry as PerformanceResourceTiming & {responseStatus?:number};
        return {name:r.name,start:r.startTime,duration:r.duration,initiator:r.initiatorType,status:r.responseStatus,transferSize:r.transferSize,decodedBodySize:r.decodedBodySize};
      }):[];
      note("window-error",e instanceof ErrorEvent?{message:e.message}:{url,tag:target instanceof Element?target.tagName:null,rel:target instanceof HTMLLinkElement?target.rel:null,entries});
    },true);
    window.addEventListener("unhandledrejection",e=>note("unhandled-rejection",String(e.reason)));
  },activationGateTreatment);
  try {
  const { builds } = await harnessState(request);
  await serveBuild(request, "old");
  await page.goto("/");
  await expect(signInButton(page)).toBeVisible();
  await serviceWorkerReady(page);
  await page.goto("/");
  await expect(signInButton(page)).toBeVisible();

  // Record what the registration sees, so the failed install is observed
  // rather than assumed.
  await page.evaluate(async () => {
    const states: string[] = [];
    (window as unknown as { __swStates: string[] }).__swStates = states;
    const reg = await navigator.serviceWorker.getRegistration();
    reg?.addEventListener("updatefound", () => {
      const sw = reg.installing;
      if (!sw) return;
      states.push("found");
      sw.addEventListener("statechange", () => states.push(sw.state));
    });
  });
  const states = () => page.evaluate(() => (window as unknown as { __swStates: string[] }).__swStates);

  // An update found within a minute of registering is one workbox-window
  // treats as its own; the field's updates come long after, and are not.
  await page.waitForTimeout(61_000);

  // The deploy is half there: the new build, minus one chunk its worker
  // precaches. The download fails and the worker is thrown away.
  await engineTrace?.start();
  await serveBuild(request, "new", [builds.new.entry]);
  await nudgeUpdateCheck(page);
  await expect.poll(states, { timeout: 60_000, message: "the half-deployed worker never failed to install" }).toContain(
    "redundant",
  );
  expect(await runningEntry(page)).toBe(builds.old.entry);

  // The deploy finishes. The next check downloads the whole thing, and the
  // app switches to it — on the sign-in screen, by itself.
  await serveBuild(request, "new");
  if(activationGateTreatment)await page.evaluate(()=>{(window as unknown as {__pwaActivationGateArmed:boolean}).__pwaActivationGateArmed=true;});
  const { loads } = countLoads(page);
  const { navigations } = countNavigations(page);
  await nudgeUpdateCheck(page);
  await expect
    .poll(() => runningEntry(page), {
      timeout: 120_000,
      message:
        "the second worker took over but the page never reloaded onto it — from here Refresh does nothing and the banner keeps coming back",
    })
    .toBe(builds.new.entry);
  await expectSettledOn(page, builds.new.entry, loads);
  if(activationGateTreatment){
    const gate=await page.evaluate(()=>JSON.parse(sessionStorage.getItem('wops-e2e-half-download-causal')||'[]') as {event:string;at:number;detail:{state?:string}}[]);
    expect(gate.filter(e=>e.event==='gate-invalid'),'invalid treatment is not a passing activation gate').toHaveLength(0);
    expect(gate.filter(e=>e.event==='gate-native')).toHaveLength(1);
    const forward=gate.filter(e=>e.event==='gate-forward');expect(forward).toHaveLength(1);expect(forward[0].detail.state).toBe('activated');
    const unload=gate.find(e=>e.event==='beforeunload' && e.at>=forward[0].at);
    expect(unload,'forwarded old-page handler must reload before worker fallback').toBeDefined();
    expect(unload!.at-forward[0].at).toBeLessThan(3000);
  }
  expect(navigations(), "the switch was more than one navigation: two racing reloads can leave the new build blank").toHaveLength(1);
  } finally {
    let documentTimeline: unknown = null;
    try { documentTimeline=await page.evaluate(()=>JSON.parse(sessionStorage.getItem("wops-e2e-half-download-causal")||"[]")); } catch { /* navigation may still be active */ }
    await test.info().attach("half-download-causal",{body:Buffer.from(JSON.stringify({repeatIndex:test.info().repeatEachIndex,activationGateTreatment,htmlPreloadTreatment:process.env.IW_PWA_NO_HTML_MODULEPRELOAD==='1',causal,documentTimeline,network},null,2)),contentType:"application/json"});
    await engineTrace?.finish();
    await cdp.detach();
  }
});
