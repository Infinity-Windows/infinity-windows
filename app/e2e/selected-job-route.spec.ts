import { expect, test } from "@playwright/test";
import { setupRoute } from "./support/selectedJobRouteFixture";

for(const viewport of [{width:320,height:740},{width:390,height:844},{width:844,height:390}]){
 test(`real Work route ${viewport.width} EN/ES fits, totals stay unavailable, clock doors and unit editor remain reachable`,async({page})=>{
  await page.setViewportSize(viewport);const unexpected=await setupRoute(page);
  for(const lang of ['en','es']){
    if(lang==='es')await page.getByRole('button',{name:'EN/ES'}).click();
    await expect(page.locator('.pav-clock')).toBeVisible();
    const geometry=await page.evaluate(()=>({scroll:document.documentElement.scrollWidth,width:innerWidth,clock:document.querySelector('.pav-clock')!.getBoundingClientRect().height}));
    expect(geometry.scroll).toBeLessThanOrEqual(geometry.width+1);expect(geometry.clock).toBeGreaterThanOrEqual(44);
    await page.locator('.pav-clock').click();
    await page.locator('.pav-actions button').first().click();
    await page.locator('.pav-actions button').nth(1).click();
    await expect(page.locator('.pav-tile-times')).not.toContainText('00:00:00');
    await expect(page.locator('a[href*="unit="]')).toHaveCount(1);
    if(process.env.FORGE_ROUTE_ARTIFACTS)await page.screenshot({path:`${process.env.FORGE_ROUTE_ARTIFACTS}/route-${viewport.width}-${lang}.png`,fullPage:true});
  }
  expect(unexpected).toEqual([]);
  expect(await page.evaluate(()=> (window as Window & {__clockDoors?:number}).__clockDoors)).toBe(6);
 });
}
