import {expect,test,type Page} from '@playwright/test';
import {useSupabaseFixtures} from './support/supabaseFixtures';
const note=(id:string,audience:number[],title:string)=>({id,audience,published_on:'2026-09-21',kind:'fix',title_en:title,title_es:'Fotos guardadas correctamente',body_en:'Photos now show whether they are waiting or saved. These details wrap to fit your phone.',body_es:'Las fotos muestran si están pendientes o guardadas. Toca el enlace para ver tus fotos.',href:'/photos'});
const shared=note('2026-09-21-photos',[0,1,2,3],'Photo uploads are clearer');
const team=note('2026-09-21-team-reports',[1,2,3],'Crew hours reports');
const manager=note('2026-09-21-leave-review',[2,3],'Supervisor leave review');
async function access(page:Page,allowed=true){await page.route('**/rest/v1/rpc/can_read_app_update',r=>r.fulfill({json:allowed}));}
async function feed(page:Page,rows:unknown[]){await access(page);await page.route('**/rest/v1/app_release_notes*',r=>r.fulfill({json:rows}));}
// Emulate persisted receipts from a previous installed build while retaining
// the notes already read. The compiled build is constant within this test run.
async function olderBuildReceipt(page:Page){await page.evaluate(()=>{for(const key of Object.keys(localStorage)){if(key.startsWith('forge.updates.read.')){const ids=JSON.parse(localStorage.getItem(key)!);localStorage.setItem(key,JSON.stringify([...ids.filter((id:string)=>!id.startsWith('build:')),'build:previous-version']));}}});}
test('popup opens once per build, preserves role privacy and retains Settings history',async({page})=>{
 await useSupabaseFixtures(page,{role:'installer'});await access(page);let rows=[shared,team,manager];await page.route('**/rest/v1/app_release_notes*',r=>r.fulfill({json:rows}));await page.goto('/ask');
 const popup=page.getByRole('dialog',{name:'What’s new in Forge'});await expect(popup).toBeVisible();await expect(popup).toContainText(shared.title_en);await expect(popup).not.toContainText(team.title_en);await expect(popup).not.toContainText(manager.title_en);await expect(popup.getByText(shared.body_en)).toBeVisible();
 await popup.getByRole('button',{name:'Got it'}).click();await page.reload();await expect(page.locator('.ask-input')).toBeVisible();await expect(popup).toHaveCount(0);
 rows=[...rows,note('2026-09-21-voice',[0,1,2,3],'Voice recording improved')];await page.reload();await expect(page.locator('.ask-input')).toBeVisible();await expect(popup).toHaveCount(0);
 await olderBuildReceipt(page);await page.reload();await expect(popup).toContainText('Voice recording improved');await expect(popup).not.toContainText(shared.title_en);
 await popup.getByRole('link',{name:'Read updates again in Settings'}).click();await expect(popup).toHaveCount(0);const history=page.getByRole('region',{name:'App update history'});await expect(history).toContainText(shared.title_en);await expect(history).not.toContainText(manager.title_en);
 await page.reload();await expect(history).toBeVisible();await expect(popup).toHaveCount(0);
});
test('another-role-only release shows the generic notice once without exposing details',async({page})=>{
 await useSupabaseFixtures(page,{role:'installer'});await feed(page,[team,manager]);await page.goto('/ask');const popup=page.getByRole('dialog',{name:'What’s new in Forge'});await expect(popup).toContainText('Different Role Update');await expect(popup).not.toContainText(manager.title_en);await expect(popup).not.toContainText(team.title_en);
 await page.keyboard.press('Escape');await expect(popup).toHaveCount(0);await page.reload();await expect(page.locator('.ask-input')).toBeVisible();await expect(popup).toHaveCount(0);
 await olderBuildReceipt(page);await page.reload();await expect(popup).toContainText('Different Role Update');
});
test('owner preview does not acknowledge the real owner’s update',async({page})=>{
 await page.setViewportSize({width:1440,height:960});await useSupabaseFixtures(page,{role:'owner'});await feed(page,[shared,team,manager]);await page.addInitScript(()=>sessionStorage.setItem('infinity.viewAsRole','installer'));await page.goto('/ask');const popup=page.getByRole('dialog',{name:'What’s new in Forge'});await expect(popup).not.toContainText(manager.title_en);await popup.getByRole('button',{name:'Got it'}).click();await page.getByRole('button',{name:'Owner',exact:true}).click();await expect(popup).toContainText(manager.title_en);
 await expect.poll(async()=>{const b=await popup.boundingBox();return Boolean(b&&b.x>=0&&b.y>=0&&b.x+b.width<=1440&&b.y+b.height<=960);}).toBe(true);
 await page.screenshot({path:'e2e/test-results/app-updates-desktop.png',fullPage:true,style:'.pwa-banner-wrong-project { visibility: hidden; }'});
});
test('Spanish dark phone popup is readable and keyboard dismissible',async({page})=>{
 await page.setViewportSize({width:375,height:812});await page.emulateMedia({colorScheme:'dark'});await useSupabaseFixtures(page,{role:'installer',language:'es'});await feed(page,[shared,manager]);await page.goto('/ask');const popup=page.getByRole('dialog',{name:'Novedades de Forge'});await expect(popup).toBeVisible();await expect(popup.getByText(shared.body_es)).toBeVisible();await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
 await page.screenshot({path:'e2e/test-results/app-updates-phone-es.png',fullPage:true,style:'.pwa-banner-wrong-project { visibility: hidden; }'});await popup.getByRole('button',{name:'Entendido'}).focus();await page.keyboard.press('Enter');await expect(popup).toHaveCount(0);
});
test('a missing feed never blocks work or incorrectly claims another role update',async({page})=>{
 await useSupabaseFixtures(page,{role:'installer'});await page.route('**/rest/v1/app_release_notes*',r=>r.fulfill({status:404,json:{code:'PGRST205',message:'Not deployed'}}));await page.goto('/ask');await expect(page.locator('.ask-input input')).toBeVisible();await expect(page.getByRole('dialog',{name:'What’s new in Forge'})).toHaveCount(0);
});
test('denied accounts receive no popup even when a stale note exists',async({page})=>{
 await useSupabaseFixtures(page,{role:'owner'});await feed(page,[shared]);await access(page,false);await page.goto('/ask');await expect(page.locator('.ask-input input')).toBeVisible();await expect(page.getByRole('dialog',{name:'What’s new in Forge'})).toHaveCount(0);
});
