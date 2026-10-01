import {expect,test,type Page,type Route} from '@playwright/test';
import {jobFixtures,useSupabaseFixtures,TEST_USER} from './support/supabaseFixtures';
import {json,TINY_PNG_BASE64} from './support/specHelpers';
const JOB=jobFixtures().find(j=>j.jobCode==='BLACK22')!;
const PROJECT={id:JOB.projectId,job_code:'BLACK22',name:'Black Desert',address:null,status:'active'};
const offlineAbort=(r:Route)=>r.abort('internetdisconnected');
const LOG='00000000-0000-4000-8000-00000000f00d';
async function usePhotoFixture(page:Page){
 // oxlint-disable-next-line react-hooks/rules-of-hooks -- async Playwright fixture, not a React hook
 await useSupabaseFixtures(page,{role:'installer'});
 await page.route('**/rest/v1/projects**',r=>json(r,[PROJECT],1));
 const saves:Record<string,unknown>[]=[],photos:Record<string,unknown>[]=[],uploads:{path:string;overwrite:string|undefined;type:string;bytes:Buffer|null}[]=[];
 let saved:Record<string,unknown>|null=null;
 await page.route('**/rest/v1/daily_logs**',r=>json(r,saved?[saved]:[],saved?1:0));
 await page.route('**/rest/v1/rpc/file_daily_log',r=>{
  const body=r.request().postDataJSON();saves.push(body);
  saved={id:LOG,revision:1,...Object.fromEntries(Object.entries(body).map(([k,v])=>[k.replace(/^p_/,''),v])),filed_by:TEST_USER.id,created_at:new Date().toISOString(),updated_at:new Date().toISOString()};
  return json(r,saved);
 });
 await page.route('**/storage/v1/object/install-media/**',r=>{
  const h=r.request().headers();uploads.push({path:new URL(r.request().url()).pathname,overwrite:h['x-upsert'],type:h['content-type'],bytes:r.request().postDataBuffer()});
  return json(r,{Key:'ok'});
 });
 await page.route('**/rest/v1/attachments**',r=>{
  if(r.request().method()==='GET'){
   const u=new URL(r.request().url());const client=u.searchParams.get('client_id');const log=u.searchParams.get('daily_log_id');
   const result=photos.filter(p=>(!client||client===`eq.${p.client_id}`)&&(!log||log===`eq.${p.daily_log_id}`));
   return json(r,result,result.length);
  }
  const body=r.request().postDataJSON();for(const p of Array.isArray(body)?body:[body])photos.push({id:'photo-row',...p});
  return json(r,[],0);
 });
 return {saves,photos,uploads};
}
async function open(page:Page){await page.goto(`/projects/${JOB.projectId}?tab=logs`);await page.getByRole('button',{name:'+ Log today',exact:true}).click();return page.getByRole('dialog');}
async function capture(page:Page){const dialog=page.getByRole('dialog');await dialog.locator('input[type=file]:not([capture])').setInputFiles({name:'windows.png',mimeType:'image/png',buffer:Buffer.from(TINY_PNG_BASE64,'base64')});await expect(dialog.locator('.daily-log-photo-grid-pending img')).toHaveCount(1);}
for(const offline of [false,true])test(`pre-save photo survives reload and attaches after ${offline?'offline sync':'online save'}`,async({page,context})=>{
 const f=await usePhotoFixture(page);let dialog=await open(page);await capture(page);
 expect(f.uploads).toHaveLength(0);expect(f.photos).toHaveLength(0);
 await page.reload();await page.getByRole('button',{name:'+ Log today',exact:true}).click();dialog=page.getByRole('dialog');
 await expect(dialog.locator('.daily-log-photo-grid-pending img')).toHaveCount(1);
 await dialog.getByLabel('Notes',{exact:true}).fill('Completed west wall windows');
 if(offline){
  await context.setOffline(true);
  await page.route('**/rest/v1/rpc/file_daily_log',offlineAbort);
 }
 await dialog.getByRole('button',{name:'Save',exact:true}).click();
 await expect(dialog).not.toBeVisible();
 if(offline){expect(f.saves).toHaveLength(0);await page.unroute('**/rest/v1/rpc/file_daily_log',offlineAbort);await context.setOffline(false);}
 await expect.poll(()=>f.photos.length).toBe(1);
 expect(f.photos[0]).toMatchObject({project_id:JOB.projectId,daily_log_id:LOG,created_by:TEST_USER.email,kind:'photo'});
 const client=f.photos[0].client_id;
 expect(f.uploads[0].path).toBe(`/storage/v1/object/install-media/${JOB.projectId}/daily-logs/${LOG}/${TEST_USER.id}/${client}.jpg`);
 expect(f.uploads[0].overwrite).toBe('false');
 expect(f.uploads[0].type).toContain('image/jpeg');
 expect(f.uploads[0].bytes?.subarray(0,2)).toEqual(Buffer.from([255,216]));
});
test('failed durable photo storage stays visible and blocks misleading save',async({page})=>{
 await page.addInitScript(()=>{
  const original=IDBFactory.prototype.open;
  IDBFactory.prototype.open=function(name:string,version?:number){if(name==='wops-daily-log-pending-photos')throw new DOMException('Storage quota','QuotaExceededError');return original.call(this,name,version!);};
 });
 const f=await usePhotoFixture(page);const dialog=await open(page);
 await dialog.locator('input[type=file]:not([capture])').setInputFiles({name:'windows.png',mimeType:'image/png',buffer:Buffer.from(TINY_PNG_BASE64,'base64')});
 await expect(dialog.getByRole('alert').getByRole('button',{name:'Retry',exact:true})).toBeVisible();
 await expect(dialog.getByRole('alert').locator('img')).toHaveCount(1);
 await expect(dialog.getByRole('button',{name:'Save',exact:true})).toBeDisabled();
 expect(f.uploads).toHaveLength(0);expect(f.saves).toHaveLength(0);
 await dialog.getByRole('alert').getByRole('button',{name:'Remove',exact:true}).click();
 await expect(dialog.getByRole('button',{name:'Save',exact:true})).toBeEnabled();
});
