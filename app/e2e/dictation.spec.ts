import {expect, test, type Page} from "@playwright/test";
import {jobFixtures, useSupabaseFixtures as installSupabaseFixtures} from "./support/supabaseFixtures";
import {json} from "./support/specHelpers";
const job = jobFixtures().find(j => j.jobCode === "BLACK22")!;

async function setupDictationFixture(page: Page, language: "en" | "es" = "en", denied = false) {
  await page.setViewportSize({width:390,height:844});
  await installSupabaseFixtures(page, {role:"installer", language});
  await page.route("**/rest/v1/projects**", route => json(route, [{id:job.projectId,job_code:"BLACK22",name:"Black Desert",status:"active"}],1));
  await page.addInitScript(({denied}) => {
    let stopped = 0;
    Object.defineProperty(window,"stoppedMicrophoneTracks",{get:()=>stopped});
    Object.defineProperty(navigator,"mediaDevices",{configurable:true,value:{getUserMedia:async()=>{
      if(denied)throw new DOMException("Denied","NotAllowedError");
      return {getTracks:()=>[{stop:()=>stopped++}]};
    }}});
    Object.defineProperty(window, "OfflineAudioContext", {configurable:true,value:class {
      decodeAudioData() { return Promise.resolve({length:1600, duration:0.1, sampleRate:16000, numberOfChannels:1,getChannelData:()=>new Float32Array(1600)}); }
    }});
    class Recorder {
      static isTypeSupported(type:string){return type === "audio/mp4";}
      state="inactive";mimeType="audio/mp4";
      ondataavailable: ((e:{data:Blob})=>void)|null=null;
      onstop: (()=>void)|null=null;
      start(){this.state="recording";}
      stop(){this.state="inactive";queueMicrotask(()=>{this.ondataavailable?.({data:new Blob(["fixture audio"],{type:this.mimeType})});this.onstop?.();});}
    }
    Object.defineProperty(window,"MediaRecorder",{configurable:true,value:Recorder});
  },{denied});
  await page.goto(`/projects/${job.projectId}?tab=logs`);
  await page.getByRole("button",{name:language === "en" ? "+ Log today" : "+ Anotar el día",exact:true}).click();
  const notes=page.getByLabel(language === "en" ? "Notes" : "Notas",{exact:true});
  await expect(notes).toBeVisible();
  return {notes, control: notes.locator("..").locator(".dictation-controls"), dialog:page.getByRole("dialog")};
}

test("dictation appends to the latest text and saves through the normal report form",async({page})=>{
  const {notes,control,dialog}=await setupDictationFixture(page);
  await notes.fill("Typed first.");
  let finish:()=>void=()=>{};
  let arrived=false;
  let requestBody="";
  await page.route("**/functions/v1/transcribe-description",async route=>{
    requestBody=route.request().postData()??""; arrived=true;
    await new Promise<void>(resolve=>{finish=resolve;});
    await json(route,{text:"Installed four doors."});
  });
  const saves:Record<string,unknown>[]=[];
  await page.route("**/rest/v1/rpc/file_daily_log",route=>{saves.push(route.request().postDataJSON());return json(route,null);});
  await control.getByRole("button",{name:"Dictate",exact:true}).click();
  await control.getByRole("button",{name:/Stop & transcribe/}).click();
  await expect.poll(()=>arrived).toBe(true);
  expect(requestBody).toContain("audio/wav");
  expect(requestBody).toContain('name="language"');
  await notes.fill("Updated while transcribing.");
  finish();
  await expect(notes).toHaveValue("Updated while transcribing.\nInstalled four doors.");
  expect(saves).toHaveLength(0);
  expect(await page.evaluate(()=>Reflect.get(window,"stoppedMicrophoneTracks"))).toBeGreaterThan(0);
  await dialog.getByRole("button",{name:"Save",exact:true}).click();
  await expect.poll(()=>saves.length).toBe(1);
  expect(saves[0].p_notes).toBe("Updated while transcribing.\nInstalled four doors.");
});

test("failed transcription retains the clip for retry without losing typed text",async({page})=>{
  const {notes,control}=await setupDictationFixture(page);
  await notes.fill("Typed note.");let calls=0;
  await page.route("**/functions/v1/transcribe-description",route=>++calls===1
    ? route.fulfill({status:502,contentType:"application/json",body:JSON.stringify({error:"transcription_failed"})})
    : json(route,{text:"Retry worked."}));
  await control.getByRole("button",{name:"Dictate",exact:true}).click();
  await control.getByRole("button",{name:/Stop & transcribe/}).click();
  await expect(control.getByRole("button",{name:"Retry transcription"})).toBeVisible();
  await expect(notes).toHaveValue("Typed note.");
  await expect(control.locator("audio")).toBeVisible();
  await expect(control.getByRole("link", {name: "Save audio"})).toHaveAttribute("download", "forge-recording.mp4");
  const audioDownload = page.waitForEvent("download");
  await control.getByRole("link", {name: "Save audio"}).click();
  expect((await audioDownload).suggestedFilename()).toBe("forge-recording.mp4");
  await control.getByRole("button",{name:"Retry transcription"}).click();
  await expect(notes).toHaveValue("Typed note.\nRetry worked.");
});

test("cancelling stops the microphone without sending audio",async({page})=>{
  const {notes,control}=await setupDictationFixture(page);let calls=0;
  await page.route("**/functions/v1/transcribe-description",route=>{calls++;return json(route,{text:"Should not insert"});});
  await notes.fill("Keep me.");
  await control.getByRole("button",{name:"Dictate",exact:true}).click();
  await control.getByRole("button",{name:"Cancel recording",exact:true}).click();
  await expect(control.getByRole("button",{name:"Dictate",exact:true})).toBeVisible();
  await expect(notes).toHaveValue("Keep me.");expect(calls).toBe(0);
  expect(await page.evaluate(()=>Reflect.get(window,"stoppedMicrophoneTracks"))).toBeGreaterThan(0);
});

test("denied microphone permission leaves typing available",async({page})=>{
  const {notes,control}=await setupDictationFixture(page,"en",true);
  await control.getByRole("button",{name:"Dictate",exact:true}).click();
  await expect(control.getByText(/Allow microphone access/)).toBeVisible();
  await notes.fill("Still able to type.");await expect(notes).toHaveValue("Still able to type.");
});

test("Spanish dictation uses the selected language and adds the returned words",async({page})=>{
  const {notes,control}=await setupDictationFixture(page,"es");let body="";
  await page.route("**/functions/v1/transcribe-description",route=>{body=route.request().postData()??"";return json(route,{text:"Instalamos cuatro puertas."});});
  await control.getByRole("button",{name:"Dictar",exact:true}).click();
  await control.getByRole("button",{name:/Detener y transcribir/}).click();
  await expect(notes).toHaveValue("Instalamos cuatro puertas.");
  expect(body).toMatch(/name="language"\r\n\r\nes/);
});
