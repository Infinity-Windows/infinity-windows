import {expect,test,type Page} from '@playwright/test';
import {useSupabaseFixtures} from './support/supabaseFixtures';
const note=(id:string,audience:number[],title:string)=>({id,audience,published_on:'2026-09-21',kind:'fix',title_en:title,title_es:'Fotos guardadas correctamente',body_en:'Photos now show whether they are waiting or saved. These details wrap to fit your phone.',body_es:'Las fotos muestran si están pendientes o guardadas. Toca el enlace para ver tus fotos.',href:'/photos'});
const shared=note('2026-09-21-photos',[0,1,2,3],'Photo uploads are clearer');
const team=note('2026-09-21-team-reports',[1,2,3],'Crew hours reports');
const manager=note('2026-09-21-leave-review',[2,3],'Supervisor leave review');
async function feed(page:Page,rows:unknown[]){await page.route('**/rest/v1/app_release_notes*',r=>r.fulfill({json:rows}));}
test('refresh shows only installer improvements; dismissal persists and later notes still appear',async({page})=>{
 await useSupabaseFixtures(page,{role:'installer'});let rows=[shared,team,manager];await page.route('**/rest/v1/app_release_notes*',r=>r.fulfill({json:rows}));await page.goto('/ask');
 const banner=page.getByRole('region',{name:'What’s new in Forge'});await expect(banner).toBeVisible();await expect(banner).toContainText(shared.title_en);await expect(banner).not.toContainText(team.title_en);await expect(banner).not.toContainText(manager.title_en);
 await banner.getByText(shared.title_en).click();await expect(banner.getByText(shared.body_en)).toBeVisible();await banner.getByRole('button',{name:'Got it'}).click();await expect(banner).toHaveCount(0);await page.reload();await expect(page.locator('.ask-input')).toBeVisible();await expect(banner).toHaveCount(0);
 rows=[...rows,note('2026-09-21-voice',[0,1,2,3],'Voice recording improved')];await page.reload();await expect(banner).toContainText('Voice recording improved');await expect(banner).not.toContainText(shared.title_en);
 await banner.getByRole('link',{name:'Read updates again in Settings'}).click();const history=page.getByRole('region',{name:'App update history'});await expect(history).toContainText(shared.title_en);await expect(history).not.toContainText(manager.title_en);
});
test('owner preview filters manager notes without dismissing the owner’s updates',async({page})=>{
 await page.setViewportSize({width:1440,height:960});await useSupabaseFixtures(page,{role:'owner'});await feed(page,[shared,team,manager]);await page.goto('/ask');const banner=page.getByRole('region',{name:'What’s new in Forge'});await expect(banner).toContainText(manager.title_en);
 await page.getByRole('button',{name:'Installer',exact:true}).click();await expect(banner).not.toContainText(manager.title_en);await banner.getByRole('button',{name:'Got it'}).click();await page.getByRole('button',{name:'Owner',exact:true}).click();await expect(banner).toContainText(manager.title_en);
 await page.screenshot({path:'e2e/test-results/app-updates-desktop.png',fullPage:true,style:'.pwa-banner-wrong-project { visibility: hidden; }'});
});
test('Spanish dark phone update is readable and keyboard dismissible',async({page})=>{
 await page.setViewportSize({width:375,height:812});await page.emulateMedia({colorScheme:'dark'});await useSupabaseFixtures(page,{role:'installer',language:'es'});await feed(page,[shared,manager]);await page.goto('/ask');const banner=page.getByRole('region',{name:'Novedades de Forge'});await expect(banner).toBeVisible();await banner.locator('summary').click();await expect(banner.getByText(shared.body_es)).toBeVisible();await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
 await page.screenshot({path:'e2e/test-results/app-updates-phone-es.png',fullPage:true,style:'.pwa-banner-wrong-project { visibility: hidden; }'});await banner.getByRole('button',{name:'Entendido'}).focus();await page.keyboard.press('Enter');await expect(banner).toHaveCount(0);
});
test('a missing release table never prevents using the app',async({page})=>{
 await useSupabaseFixtures(page,{role:'installer'});await page.route('**/rest/v1/app_release_notes*',r=>r.fulfill({status:404,json:{code:'PGRST205',message:'Not deployed'}}));await page.goto('/ask');await expect(page.locator('.ask-input input')).toBeVisible();await expect(page.getByRole('region',{name:'What’s new in Forge'})).toHaveCount(0);
});
