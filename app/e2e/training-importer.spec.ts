// Synthetic-only importer acceptance. Fixture server cannot reach production.
import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { TEST_USER, useSupabaseFixtures as setupSupabaseFixtures } from "./support/supabaseFixtures";
const video = readFileSync(fileURLToPath(new URL("./fixtures/training/synthetic-portrait.mp4", import.meta.url)));
const vtt = Buffer.from("WEBVTT\n\n00:00.000 --> 00:07.000\nSynthetic training narration.\n");
const transcript = Buffer.from(JSON.stringify({language:"en",segments:[{startSeconds:0,endSeconds:7,text:"Synthetic training narration."}]}));
const entry = {
  slug:"installer", title:"Synthetic installer tour",minRole:"installer",language:"en",contentStatus:"proposal",durationSeconds:8,
  videoFile:"tour.mp4",captionsFile:"tour.vtt",transcriptFile:"transcript.json",chapters:[{seconds:0,title:"Synthetic overview",status:"proposal"}],
};
const manifest = Buffer.from(JSON.stringify({version:1,videos:[entry]}));
async function chooseFiles(page:Page) {
  await page.locator('.training-importer input[type="file"]').nth(0).setInputFiles({name:"role-videos-manifest.json",mimeType:"application/json",buffer:manifest});
  await page.locator('.training-importer input[type="file"]').nth(1).setInputFiles([
    {name:"tour.mp4",mimeType:"video/mp4",buffer:video},
    {name:"tour.vtt",mimeType:"text/vtt",buffer:vtt},
    {name:"transcript.json",mimeType:"application/json",buffer:transcript},
  ]);
}
async function openTraining(page:Page,role:"owner"|"foreman"|"installer"="owner",language:"en"|"es"="en") {
  await setupSupabaseFixtures(page,{role,language});
  await page.route("**/rest/v1/app_training_videos*",r=>r.fulfill({json:[]}));
  await page.goto("/learn");
  await page.locator(".hub-tab",{hasText:language==="en"?"Using Forge":"Usar Forge"}).click();
}

test("importer is unavailable to installer and foreman, including direct role preview",async({page})=>{
  for(const role of ["installer","foreman"] as const) {
    await openTraining(page,role);
    await expect(page.locator(".training-importer")).toHaveCount(0);
  }
});

test("owner reviews local synthetic MP4 before upload; lost publication reply retries same reservation",async({page})=>{
  await page.setViewportSize({width:390,height:844});
  await openTraining(page);
  let reserves=0, publishes=0, committed=false;
  const requests:string[]=[];
  const stored=new Map<string,Buffer>();
  let assets:Array<{kind:string,path:string,bytes:number,mime:string}>=[];
  const reservation=()=>({id:"10000000-0000-4000-8000-000000000001",slug:"installer",language:"en",version:1,state:committed?"published":"reserved",expiresAt:"2099-01-01T00:00:00Z",assets});
  await page.route("**/rest/v1/rpc/app_training_import_*",async route=>{
    const fn=route.request().url().split('/').pop();
    const body=route.request().postDataJSON();
    if(fn==="app_training_import_reserve") {
      reserves++; requests.push(body.p_request_id);
      assets=["video","captions"].map(kind=>({kind,path:`installer/en/v1/${kind==='video'?'walkthrough.mp4':'captions.vtt'}`,bytes:body.p_entry[kind].bytes,mime:body.p_entry[kind].mime}));
      return route.fulfill({json:reservation()});
    }
    if(fn==="app_training_import_status") return route.fulfill({json:[{...reservation(),expired:false,assets:assets.map(a=>({...a,present:stored.has(a.path),ownedByYou:stored.has(a.path),storedBytes:stored.get(a.path)?.length??null,storedMime:a.mime}))}]});
    if(fn==="app_training_import_publish") {
      publishes++; committed=true;
      if(publishes===1) return route.abort('connectionfailed');
      return route.fulfill({json:[{id:reservation().id,slug:'installer',version:1,active:true,alreadyPublished:true}]});
    }
    return route.fulfill({status:400,json:{message:'unexpected fixture RPC'}});
  });
  await page.route("**/storage/v1/object/app-training/**",async route=>{
    const path=decodeURIComponent(route.request().url().split('/app-training/')[1]);
    if(route.request().method()==='POST') {
      stored.set(path,route.request().postDataBuffer()!);
      return route.fulfill({json:{Key:`app-training/${path}`}});
    }
    return route.fulfill({body:stored.get(path)??Buffer.alloc(0),contentType:path.endsWith('.mp4')?'video/mp4':'text/vtt'});
  });
  await page.route("**/storage/v1/object/authenticated/app-training/**",route=>{
    const path=decodeURIComponent(route.request().url().split('/app-training/')[1]);
    return route.fulfill({body:stored.get(path)??Buffer.alloc(0),contentType:path.endsWith('.mp4')?'video/mp4':'text/vtt'});
  });
  await chooseFiles(page);
  await expect(page.locator('.ti-preview')).toContainText('Synthetic installer tour');
  await expect(page.locator('.ti-publish')).toBeEnabled();
  expect(reserves).toBe(0); expect(stored.size).toBe(0);
  await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
  await page.locator('.ti-publish').click();
  await expect(page.locator('.ti-alert')).toContainText(/confirm|connection|check/i);
  expect(committed).toBe(true);
  await expect(page.locator('.ti-alert')).not.toContainText('Nothing was published');
  await page.locator('.ti-publish').click();
  await expect(page.locator('.training-importer')).toContainText('already published');
  expect(new Set(requests).size).toBe(1);
  expect(stored.size).toBe(2);
  expect(publishes).toBe(2);
});

test("Spanish owner importer is readable at320px and rejects incomplete local files before server traffic",async({page})=>{
  await page.setViewportSize({width:320,height:740});
  await openTraining(page,'owner','es');
  let mutations=0;
  await page.route('**/rest/v1/rpc/app_training_import_*',route=>{mutations++;return route.fulfill({status:500,json:{}})});
  await page.locator('.training-importer input[type="file"]').nth(0).setInputFiles({name:'role-videos-manifest.json',mimeType:'application/json',buffer:manifest});
  await page.locator('.training-importer input[type="file"]').nth(1).setInputFiles({name:'tour.mp4',mimeType:'video/mp4',buffer:video});
  await expect(page.locator('.ti-problems')).toBeVisible();
  await expect(page.locator('.ti-publish')).toHaveCount(0);
  await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
  expect(mutations).toBe(0);
});


test("account change drops the selected private package and ignores the old reservation reply",async({page})=>{
  await openTraining(page);
  let release:()=>void=()=>{},arrived=false,uploads=0;
  await page.route("**/rest/v1/rpc/app_training_import_reserve",async route=>{
    const body=route.request().postDataJSON(); arrived=true;
    await new Promise<void>(resolve=>release=resolve);
    await route.fulfill({json:{id:"10000000-0000-4000-8000-000000000002",slug:"installer",language:"en",version:1,state:"reserved",expiresAt:"2099-01-01T00:00:00Z",assets:["video","captions"].map(kind=>({kind,path:`installer/en/v1/${kind==='video'?'walkthrough.mp4':'captions.vtt'}`,bytes:body.p_entry[kind].bytes,mime:body.p_entry[kind].mime}))}}).catch(()=>{});
  });
  await page.route("**/storage/v1/object/app-training/**",route=>{uploads++;return route.fulfill({json:{}})});
  await chooseFiles(page);await expect(page.locator('.ti-publish')).toBeEnabled();
  await page.locator('.ti-publish').click();await expect.poll(()=>arrived).toBe(true);
  const id="00000000-0000-4000-8000-0000000000b2";
  const user={...TEST_USER,id};
  const session={access_token:"fixture-owner-B",refresh_token:"fixture-refresh-B",token_type:"bearer",expires_in:3600,expires_at:2066000000,user};
  await page.route("**/auth/v1/user",route=>route.fulfill({json:user}));
  await page.route("**/rest/v1/profiles*",route=>route.fulfill({json:route.request().headers().accept?.includes('pgrst.object')?{id,role:'owner',display_name:'Synthetic owner B',active:true,language:'en'}:[{id,role:'owner',display_name:'Synthetic owner B',active:true,language:'en'}]}));
  await page.evaluate(newSession=>{
    const key='sb-e2efixture-auth-token';const proto=Object.getPrototypeOf(localStorage),before=proto.getItem;
    proto.getItem=function(this:Storage,k:string){return this===localStorage&&k===key?JSON.stringify(newSession):before.call(this,k)};
    localStorage.setItem(key,JSON.stringify(newSession));
    const channel=new BroadcastChannel(key);channel.postMessage({event:'SIGNED_IN',session:newSession});setTimeout(()=>channel.close(),500);
  },session);
  await expect.poll(()=>page.evaluate(async()=>{
    const browserModule='/src/lib/supabase.ts';const {supabase}=await import(browserModule);return (await supabase.auth.getSession()).data.session?.user.id;
  })).toBe(id);
  await expect(page.locator('.ti-picker-summary').first()).not.toContainText('role-videos-manifest.json');
  await expect(page.locator('.ti-preview')).toHaveCount(0);
  release(); await expect(page.locator('.ti-publish')).toHaveCount(0);
  expect(uploads).toBe(0);
});
