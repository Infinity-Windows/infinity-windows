import {expect,test} from '@playwright/test';
import {useSupabaseFixtures,TEST_USER} from './support/supabaseFixtures';
import {hideWrongProjectBanner,json} from './support/specHelpers';

for(const width of [390,1440])test(`clock dialog stays readable and keyboard focus survives timer ticks at ${width}px`,async({page})=>{
 test.setTimeout(45000);
 await page.setViewportSize({width,height:960});
 await useSupabaseFixtures(page,{role:'installer'});await hideWrongProjectBanner(page);
 const shift={id:'20000000-0000-4000-8000-000000000001',profile_id:TEST_USER.id,project_id:null,cost_code_id:null,clock_in_at:new Date(Date.now()-3*3600000).toISOString(),clock_out_at:null,status:'open',created_at:new Date().toISOString(),break_seconds:0,break_started_at:new Date(Date.now()-31*60000).toISOString(),break_type:'lunch',injured:null,time_confirmed:null};
 await page.route('**/rest/v1/time_shifts**',route=>json(route,route.request().headers().accept?.includes('object')?shift:[shift]));
 await page.addInitScript(()=>localStorage.setItem('infinity.theme','dark'));
 await page.route('**/rest/v1/rpc/server_now',route=>json(route,new Date().toISOString()));
 await page.goto('/my-schedule');
 const trigger=page.getByRole('button',{name:'Open my clock',exact:true});
 await trigger.click();const dialog=page.locator('.clock-sheet');await expect(dialog).toBeVisible();
 const close=dialog.getByRole('button',{name:/close/i});await expect(close).toBeFocused();
 await page.keyboard.press('Shift+Tab');const focused=await page.evaluate(()=>document.activeElement?.outerHTML);
 await page.waitForTimeout(2200); // Observe two live clock ticks, the original focus/scroll regression trigger.
 expect(await page.evaluate(()=>document.activeElement?.outerHTML)).toBe(focused);
 await page.keyboard.press('Tab');await expect(close).toBeFocused();
 const box=(await dialog.boundingBox())!;
 if(width===1440){expect(box.width).toBeGreaterThanOrEqual(630);expect(Math.abs(box.y+box.height/2-480)).toBeLessThan(2)}
 else expect(box.width).toBeLessThanOrEqual(width);
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 await page.screenshot({path:`e2e/test-results/clock-usability-${width}.png`,fullPage:true});
 await page.keyboard.press('Escape');await expect(dialog).toHaveCount(0);await expect(trigger).toBeFocused();
});
