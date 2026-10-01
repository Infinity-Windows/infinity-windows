import { test, expect } from '@playwright/test';
import { useSupabaseFixtures, jobFixtures, TEST_USER } from './support/supabaseFixtures';
import { json, dayISO, TINY_PNG_BASE64 } from './support/specHelpers';
const JOB=jobFixtures().find(x=>x.jobCode==='BLACK22')!;
const PROJECT={id:JOB.projectId,job_code:'BLACK22',name:'Black Desert',address:null,status:'active'};
const LOG='00000000-0000-4000-8000-000000000060';
function row(date=dayISO(0)) {return {id:LOG,project_id:JOB.projectId,project:PROJECT,job_name:null,log_date:date,revision:4,headline:'West openings finished',notes:'Installed W01 through W12; W13 and W14 remain.',day_flow:'smooth',reflection:null,weather:'Clear',customer_visible:false,filed_by:TEST_USER.id,filer:{display_name:'Fixture installer'},created_at:`${date}T18:00:00Z`,updated_at:`${date}T18:00:00Z`,work_stages:['frames','glass'],stage_progress:{frames:75,glass:50},covers:'windows',delays:[],safety_status:'none_reported',weather_impact:'none',missing_tomorrow:[],tomorrow_stages:['glass'],tomorrow_crew_expected:2,tomorrow_plan:'Finish W13 and W14',units_today:3,units_to_date:12,units_remaining:2,units_remaining_detail:'W13 and W14 on the north wall'};}
async function fixtures(page,lang='en',fresh=false) {
 await useSupabaseFixtures(page,{role:'owner',language:lang});
 await page.route('**/rest/v1/projects**',r=>json(r,[PROJECT],1));
 await page.route('**/rest/v1/daily_logs**',r=>{
  const u=new URL(r.request().url());const select=u.searchParams.get('id');
  const single=(r.request().headers()['accept']||'').includes('object');
  let logs=fresh?[]:[row(),{...row(dayISO(-1)),id:'00000000-0000-4000-8000-000000000061',stage_progress:{frames:80,glass:50},units_today:4,units_to_date:9,units_remaining:5}, {...row(dayISO(-2)),id:'00000000-0000-4000-8000-000000000062',project_id:null,project:null,job_name:'Archived historical job',work_stages:[],stage_progress:{},units_today:null,units_to_date:null,units_remaining:null,units_remaining_detail:null}];
  if(select)logs=logs.filter(l=>`eq.${l.id}`===select);
  for(const date of u.searchParams.getAll('log_date')){if(date.startsWith('eq.'))logs=logs.filter(l=>l.log_date===date.slice(3));if(date.startsWith('gte.'))logs=logs.filter(l=>l.log_date>=date.slice(4));if(date.startsWith('lte.'))logs=logs.filter(l=>l.log_date<=date.slice(4));}
  const project=u.searchParams.get('project_id');if(project?.startsWith('eq.'))logs=logs.filter(l=>l.project_id===project.slice(3));
  const total=logs.length;const range=r.request().headers()['range'];if(range){const [a,b]=range.split('-').map(Number);logs=logs.slice(a,b+1);}else{const offset=Number(u.searchParams.get('offset')??0);const limit=Number(u.searchParams.get('limit')??1000);logs=logs.slice(offset,offset+limit);}
  return json(r,single?(logs[0]??null):logs,total);
 });
 await page.route('**/rest/v1/attachments**',r=>json(r,fresh?[]:[{id:'00000000-0000-4000-8000-000000000063',project_id:JOB.projectId,daily_log_id:LOG,kind:'photo',storage_path:`install-media/${JOB.projectId}/daily-logs/${LOG}/${TEST_USER.id}/fixture.jpg`,created_by:TEST_USER.email,created_at:new Date().toISOString(),taken_at:null,lat:null,lng:null}],fresh?0:1));
 await page.route('**/storage/v1/**',r=>{
  if(r.request().method()==='POST' && r.request().url().includes('/sign/'))return json(r,{signedURL:'/object/sign/install-media/fixture.jpg?token=fixture'});
  return r.fulfill({status:200,contentType:'image/png',body:Buffer.from(TINY_PNG_BASE64,'base64')});
 });
}
for(const language of ['en','es'])for(const width of [390,1280])test(`owner can read progress and history on ${width}px ${language}`,async({page},info)=>{
 await page.setViewportSize({width,height:900});await fixtures(page,language);await page.goto('/daily-logs');
 await expect(page.getByRole('heading',{name:language==='en'?'Daily Logs':'Registros diarios',exact:true})).toBeVisible();
 // Main tab must contain unit readings and actual remaining identifiers, not just notes.
 const list=page.locator('.daily-logs-page');
 await expect(list.getByText(language==='en'?'Completed today':'Completadas hoy',{exact:false}).first()).toBeVisible();
 await expect(list.getByText(language==='en'?'Completed to date':'Completadas hasta la fecha',{exact:false}).first()).toBeVisible();
 await expect(list.getByText(language==='en'?'Remaining':'Restantes',{exact:false}).first()).toBeVisible();
 await expect(list.getByText('W13 and W14 on the north wall',{exact:false}).first()).toBeVisible();
 await expect(list.getByText('Archived historical job',{exact:false}).first()).toBeVisible();
 await expect(list.getByText(language==='en'?'Not reported':'No reportado',{exact:false}).first()).toBeVisible();
 expect(await page.locator('body').evaluate(el=>el.scrollWidth<=innerWidth+1)).toBe(true);
 await page.screenshot({path:info.outputPath(`list-${width}-${language}.png`),fullPage:true,style:'.pwa-banner-wrong-project{display:none}'});
 await page.goto(`/daily-logs?log=${LOG}`);
 await expect(page.locator('.daily-log-receipt')).toBeVisible();
 await expect(page.getByText('W13 and W14 on the north wall',{exact:true})).toBeVisible();
 await expect(page.locator('.daily-log-receipt img')).toHaveCount(1);
 await expect(page.locator('.daily-log-receipt').getByText(/-5/)).toBeVisible();
 await page.screenshot({path:info.outputPath(`report-${width}-${language}.png`),fullPage:true,style:'.pwa-banner-wrong-project{display:none}'});
});
test('brand-new daily log offers both photo sources before the first save and retains drafts',async({page},info)=>{
 await page.setViewportSize({width:390,height:844});await fixtures(page,'en',true);
 await page.goto(`/projects/${JOB.projectId}?tab=logs`);await page.getByRole('button',{name:/Log today/}).click();
 const dialog=page.getByRole('dialog');await expect(dialog).toBeVisible();
 await expect(dialog.getByRole('button',{name:'Take one',exact:true})).toBeAttached();
 await expect(dialog.getByRole('button',{name:'Choose',exact:true})).toBeAttached();
 const camera=dialog.locator('input[type=file][capture]');const library=dialog.locator('input[type=file]:not([capture])');
 await expect(camera).toHaveCount(1);expect(await camera.getAttribute('capture')).toBe('environment');await expect(library).toHaveCount(1);
 await dialog.getByLabel('Completed to date',{exact:true}).fill('12');await dialog.getByLabel('Remaining',{exact:true}).fill('0');
 await page.reload();await page.getByRole('button',{name:/Log today/}).click();
 await page.getByRole('button',{name:/Resume/}).click();
 await expect(page.getByRole('dialog').getByLabel('Completed to date',{exact:true})).toHaveValue('12');
 await expect(page.getByRole('dialog').getByLabel('Remaining',{exact:true})).toHaveValue('0');
 await page.screenshot({path:info.outputPath('new-log-phone.png'),style:'.pwa-banner-wrong-project{display:none}'});
});
