import { writeFile } from "node:fs/promises";
import type { Page, TestInfo } from "@playwright/test";
import { preparePwaEngineTrace } from "./pwaEngineTrace";

/** Passive capture for the existing five-second shell-lookup test. No app or
 * worker byte changes, response interception, cache edits or timing treatment. */
export async function prepareSlowReloadEvidence(page: Page, info: TestInfo) {
  const cdp=await page.context().newCDPSession(page);
  await cdp.send("Network.enable");
  const engine=await preparePwaEngineTrace(page,cdp,info,"Archived retained slow-shell case; observation starts before serving new build");
  const network:unknown[]=[],tracked=new Set<string>();
  cdp.on("Network.requestWillBeSent",e=>{
    if(e.type!=="Document"&&!/\.(js|css)(\?|$)/.test(e.request.url))return;
    tracked.add(e.requestId);network.push({event:"request",at:Date.now(),timestamp:e.timestamp,
      id:e.requestId,loader:e.loaderId,type:e.type,url:e.request.url,initiator:e.initiator});
  });
  cdp.on("Network.responseReceived",e=>{if(tracked.has(e.requestId))network.push({event:"response",at:Date.now(),timestamp:e.timestamp,id:e.requestId,status:e.response.status,worker:e.response.fromServiceWorker});});
  cdp.on("Network.loadingFinished",e=>{if(tracked.has(e.requestId))network.push({event:"finished",at:Date.now(),timestamp:e.timestamp,id:e.requestId});});
  cdp.on("Network.loadingFailed",e=>{if(tracked.has(e.requestId))network.push({event:"failed",at:Date.now(),timestamp:e.timestamp,id:e.requestId,error:e.errorText,canceled:e.canceled,type:e.type});});
  const errors:unknown[]=[];
  page.on("pageerror",e=>errors.push({at:Date.now(),message:e.message,stack:e.stack}));
  // Dedicated diagnostic key only. These listeners observe document events;
  // they do not wrap or suppress any update/worker methods or events.
  await page.addInitScript(()=>{
    const key="forge-diagnostic-slow-shell-events";
    const note=(event:string,detail:unknown=null)=>{
      try {
        const rows=JSON.parse(sessionStorage.getItem(key)||"[]") as unknown[];
        rows.push({at:Date.now(),event,detail});sessionStorage.setItem(key,JSON.stringify(rows.slice(-200)));
      } catch { /* Failure to record must not change application behavior. */ }
    };
    const state=()=>({boot:document.documentElement.dataset.forgeBootStarted,
      empty:sessionStorage.getItem("wops-empty-boot-diagnostic"),reload:sessionStorage.getItem("wops-update-reload-diagnostic"),
      entry:document.querySelector<HTMLScriptElement>('script[type="module"][src]')?.src,
      children:document.getElementById("root")?.childElementCount});
    note("document-start");
    window.addEventListener("load",()=>note("load",state()));
    window.addEventListener("beforeunload",()=>note("beforeunload",state()));
    navigator.serviceWorker.addEventListener("controllerchange",()=>{
      const worker=navigator.serviceWorker.controller;
      note("controllerchange",{url:worker?.scriptURL,state:worker?.state});
      worker?.addEventListener("statechange",()=>note("controller-state",{url:worker.scriptURL,state:worker.state}));
    });
    window.addEventListener("error",event=>{
      const target=event.target;
      note("error",event instanceof ErrorEvent?{message:event.message}:{tag:target instanceof Element?target.tagName:null,
       url:target instanceof HTMLScriptElement?target.src:target instanceof HTMLLinkElement?target.href:null});
    },true);
    window.addEventListener("unhandledrejection",event=>note("unhandledrejection",String(event.reason)));
  });
  return {
    start:()=>engine.start(),
    async finish(){
      let documentEvents:unknown=null;
      try {documentEvents=await page.evaluate(()=>({events:JSON.parse(sessionStorage.getItem("forge-diagnostic-slow-shell-events")||"[]"),
        empty:sessionStorage.getItem("wops-empty-boot-diagnostic"),reload:sessionStorage.getItem("wops-update-reload-diagnostic"),
        boot:document.documentElement.dataset.forgeBootStarted,rootChildren:document.getElementById("root")?.childElementCount}));}
      catch(error){documentEvents={captureError:String(error)};}
      try {
        const path=info.outputPath("slow-shell-document-network.json");
        await writeFile(path,JSON.stringify({scope:"unchanged archived slow-shell case; original5000ms CacheStorage fault only",documentEvents,network,errors},null,2));
        await info.attach("slow-shell-document-network",{path,contentType:"application/json"});
      } finally {await engine.finish();await cdp.detach();}
    },
  };
}
