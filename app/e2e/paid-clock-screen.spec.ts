import {expect,test,type Page} from "@playwright/test";
import {FIXTURE_AUTH_KEY,FIXTURE_SESSION,TEST_USER} from "./support/supabaseFixtures";
import {json} from "./support/specHelpers";
import type {PaidClockRecord} from "../src/lib/paidClock/storage";
const OWNER=TEST_USER.id,SHIFT="00000000-0000-4000-8000-000000000901";
const current=()=>({id:SHIFT,profile_id:OWNER,project_id:null,cost_code_id:null,client_id:null,
  clock_in_at:new Date(Date.now()-3_600_000).toISOString(),clock_out_at:null,break_seconds:0,
  break_started_at:null,break_type:null,injured:null,time_confirmed:null,status:"open",created_at:new Date().toISOString(),
  note:null,injury_note:null,job_mode:null,review_reason:null,projects:null,cost_codes:null});
async function open(page:Page,shift:ReturnType<typeof current>|null,closeOnOut=false,classic=false){
  let currentShift=shift;
  const writes:{rpc:string;args:Record<string,unknown>}[]=[];
  await page.addInitScript(({key,session})=>localStorage.setItem(key,JSON.stringify(session)),{key:FIXTURE_AUTH_KEY,session:FIXTURE_SESSION});
  await page.route("**/*",route=>new URL(route.request().url()).hostname==="localhost"?route.continue():route.abort());
  await page.route("**/rest/v1/**",route=>{
    const url=new URL(route.request().url()),rpc=url.pathname.split("/rpc/")[1];
    if(rpc==="work_activity_clock_capability")return json(route,{protocolVersion:1,asOf:new Date().toISOString(),
      clockProtocol:"setup_v1",receiptProtocol:"retained_v1",mode:"active",canAuthorSetup:true,setupReason:null,
      canDispatchExistingSetup:true,canReadOwnReceipts:true,canDispatchPayrollSafety:true},null);
    if(rpc==="work_activity_clock_receipt")return json(route,{protocolVersion:1,availability:"unavailable",receipt:null},null);
    if(rpc==="server_now")return json(route,new Date().toISOString(),null);
    if(rpc && ["clock_in","start_break","end_break","clock_out"].includes(rpc)){
      if(rpc==="clock_out" && closeOnOut)currentShift=null;
      writes.push({rpc,args:route.request().postDataJSON()});return json(route,{},null);
    }
    if(url.pathname.endsWith("/time_shifts"))return json(route,currentShift,null);
    return json(route,[],null);
  });
  await page.goto(`/e2e/support/paid-clock-screen.html${classic?"?classic=true":""}`);
  if(!classic)await expect(page.getByTestId("screen-state")).toHaveText(`isolated:ready:${shift?"open":"off"}`);
  return writes;
}
test("a faster server read cannot divert an unactivated Classic account into native recovery",async({page})=>{
  await page.addInitScript(()=>{
    const getAll=IDBIndex.prototype.getAll;
    const held:(()=>void)[]=[];
    Object.assign(window,{releaseNativeInventory:()=>{IDBIndex.prototype.getAll=getAll;for(const run of held)run();}});
    IDBIndex.prototype.getAll=function(...args:Parameters<typeof getAll>){
      const request=getAll.apply(this,args);
      if(this.objectStore.transaction.db.name!=="iw-paid-clock-chain-v1")return request;
      return new Proxy(request,{
        get(target,key){const value=Reflect.get(target,key,target);return typeof value==="function"?value.bind(target):value;},
        set(target,key,value){
          if(key==="onsuccess" && typeof value==="function") {target.onsuccess=event=>{held.push(()=>value.call(target,event));};return true;}
          return Reflect.set(target,key,value,target);
        },
      });
    };
  });
  const writes=await open(page,current(),false,true);
  await expect(page.getByTestId("screen-state")).toHaveText("activation_blocked:ready:open");
  await expect(page.getByRole("button",{name:"Clock out",exact:true})).toHaveCount(0);
  const result=await page.evaluate(async shift=>{
    const flow=window.paidScreen.flow()!;
    return flow.authorSafety({action:"break_end",clientId:crypto.randomUUID(),tappedAt:new Date().toISOString(),
      clockCheckedAt:null,clockSkewMs:null,shiftRef:{kind:"shift",id:shift}});
  },SHIFT);
  expect(result).toMatchObject({kind:"held",reason:"basis_unavailable"});
  await page.evaluate(()=>{(window as unknown as {releaseNativeInventory:()=>void}).releaseNativeInventory();});
  await expect(page.getByTestId("screen-state")).toHaveText("legacy:blocked:");
  expect(await rows(page)).toHaveLength(0);expect(writes).toHaveLength(0);
});
async function rows(page:Page):Promise<PaidClockRecord[]>{return page.evaluate(async()=>{
  // @ts-expect-error Vite serves the actual browser module.
  const store=await import("/src/lib/paidClock/storage.ts");
  // @ts-expect-error Vite serves the actual browser module.
  const auth=await import("/src/lib/signedIn.ts");return store.readPaidClockRecords(auth.signInMark());
});}
test("the original screen saves offline break, resume and out in order without announcing payroll completion",async({page,context})=>{
  const writes=await open(page,current());await context.setOffline(true);
  await expect(page.getByTestId("screen-state")).toHaveText("activation_blocked:stale:open");
  await page.getByRole("button",{name:"Go on break",exact:true}).click();
  await page.getByRole("button",{name:"Rest",exact:true}).click();
  await expect(page.getByRole("button",{name:"Save resume request · break still pending",exact:true})).toBeVisible();
  await page.getByRole("button",{name:"Save resume request · break still pending",exact:true}).click();
  await expect.poll(async()=> (await rows(page)).length).toBe(2);
  await page.getByRole("button",{name:"Clock out",exact:true}).click();
  await expect.poll(async()=> (await rows(page)).length).toBe(3);
  const saved=(await rows(page)).sort((a,b)=>a.sequence-b.sequence);
  expect(saved.map(row=>row.intent.action)).toEqual(["break_start","break_end","clock_out"]);
  expect(saved.map(row=>row.predecessorClientId)).toEqual([null,saved[0].clientId,saved[1].clientId]);
  expect(new Set(saved.map(row=>row.storageGeneration)).size).toBe(1);
  expect(saved.every(row=>row.delivery.status==="queued"&&!row.delivery.everAttempted)).toBe(true);
  expect(saved[2].intent).toMatchObject({breakSeconds:null});expect(writes).toHaveLength(0);
  await expect(page.getByTestId("screen-state")).toHaveText("activation_blocked:stale:open");
  await expect(page.getByTestId("screen-closed")).toHaveText("false");
  await context.setOffline(false);await expect(page.getByTestId("screen-state")).toHaveText("isolated:ready:open");
  expect(writes).toHaveLength(0);
  const after=(await rows(page)).sort((a,b)=>a.sequence-b.sequence);
  expect(after.map(row=>row.intent)).toEqual(saved.map(row=>row.intent));
});
test("Start day needs no job choice and saves only the original setup clock request",async({page})=>{
  const writes=await open(page,null);await page.locator(".clock-btn.primary.big").click();
  await expect.poll(async()=> (await rows(page)).length).toBe(1);
  const saved=(await rows(page))[0];expect(saved.intent).toMatchObject({action:"clock_in",projectId:null,costCodeId:null,setupVersion:1});
  await expect.poll(()=>writes.length).toBe(1);expect(writes[0]).toMatchObject({rpc:"clock_in",args:{p_client_id:saved.clientId,p_tapped_at:saved.intent.tappedAt,p_setup_version:1}});
  await expect(page.locator(".clock-btn.primary.big")).toBeDisabled();
  expect(await page.locator(".clock-project-list,.clock-costcode-list").count()).toBe(0);
});
test("the screen closes after a fresh own off-clock read, while original delivery history stays separate",async({page})=>{
  const writes=await open(page,current(),true);
  await expect(page.getByTestId("screen-closed")).toHaveText("false");
  await page.getByRole("button",{name:"Clock out",exact:true}).click();
  await expect(page.getByTestId("screen-closed")).toHaveText("true");
  await expect(page.getByTestId("screen-state")).toHaveText("isolated:ready:off");
  const saved=(await rows(page))[0];expect(saved.intent.action).toBe("clock_out");
  expect(writes).toHaveLength(1);expect(writes[0]).toMatchObject({rpc:"clock_out",args:{p_client_id:saved.clientId,p_tapped_at:saved.intent.tappedAt}});
  expect(saved.delivery.status).not.toBe("acknowledged");
});
for(const width of [320,390,844])test(`native screen stays readable in English and Spanish at ${width}px`,async({page})=>{
  await page.setViewportSize({width,height:width===844?390:844});await open(page,current());
  for(const lang of ["en","es"] as const){
    await page.evaluate(lang=>window.paidScreen.language(lang),lang);
    await expect(page.getByRole("button",{name:lang==="en"?"Clock out":"Marcar salida",exact:true})).toBeVisible();
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
    await page.getByRole("button",{name:lang==="en"?"Clock out":"Marcar salida",exact:true}).scrollIntoViewIfNeeded();
    const rect=await page.getByRole("button",{name:lang==="en"?"Clock out":"Marcar salida",exact:true}).boundingBox();
    expect(rect!.height).toBeGreaterThanOrEqual(44);
  }
});
