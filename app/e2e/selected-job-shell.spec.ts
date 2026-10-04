import { expect, test, type Page } from "@playwright/test";
import { PROJECT, UNIT, setupRoute } from "./support/selectedJobRouteFixture";

test.use({colorScheme:'dark'});

async function chooseJob(page:Page){
 const search=page.getByRole('searchbox');await search.fill('Black');
 await search.press('Tab');await expect(page.getByRole('button',{name:/BLACK22.*Black Desert/})).toBeFocused();
 await page.keyboard.press('Enter');await expect(page.locator('.pav-tile')).toHaveCount(1);
 const codes=page.locator('#sjwr-cost');await codes.focus();await expect(codes).toBeFocused();
 // Native OS picker keystrokes are not replayed reliably by headless macOS.
 await codes.selectOption({label:'100 · Installation'});await expect(codes).not.toHaveValue('');await codes.press('Tab');await expect(codes).not.toBeFocused();
}
async function layoutEvidence(page:Page){return page.evaluate(()=>{
 const rect=(selector:string)=>{const r=document.querySelector(selector)!.getBoundingClientRect();return {x:r.x,y:r.y,right:r.right,bottom:r.bottom,width:r.width,height:r.height};};
 const clock=rect('.pav-clock'),sync=rect('.sync-strip'),dock=rect('.tabbar');
 const overlapping=clock.x<sync.right&&clock.right>sync.x&&clock.y<sync.bottom&&clock.bottom>sync.y;
 return {clock,sync,dock,overlapping,scrollWidth:document.documentElement.scrollWidth,viewport:innerWidth,height:innerHeight,dockPosition:getComputedStyle(document.querySelector('.tabbar')!).position};
 });}
for(const viewport of [{width:320,height:740},{width:390,height:844},{width:844,height:390}]){
 test(`actual shell ${viewport.width} EN/ES: badges, fixed dock, keyboard and real navigation doors`,async({page})=>{
  await page.setViewportSize(viewport);const unexpected=await setupRoute(page,true);
  await expect(page.locator('.sync-strip .sync-pill')).toContainText('Photos 5');
  await chooseJob(page);
  for(const lang of ['en','es']){
   if(lang==='es'){await page.evaluate(()=>dispatchEvent(new Event('fixture-language')));await page.evaluate(()=>scrollTo(0,0));}
   for(const position of ['top','middle','bottom']){
    await page.evaluate(p=>scrollTo(0,p==='top'?0:p==='middle'?document.body.scrollHeight/2:document.body.scrollHeight),position);
    const e=await layoutEvidence(page);await test.info().attach(`geometry-${lang}-${position}`,{body:JSON.stringify(e),contentType:'application/json'});
    if(process.env.FORGE_SHELL_ARTIFACTS)await page.screenshot({path:`${process.env.FORGE_SHELL_ARTIFACTS}/shell-${viewport.width}-${lang}-${position}.png`,fullPage:false});expect(e.scrollWidth).toBeLessThanOrEqual(e.viewport+1);
    expect(e.dockPosition).toBe('fixed');expect(e.dock.bottom).toBeCloseTo(e.height,0);expect(e.overlapping).toBe(false);
    await expect(page.getByTestId('clock-badge')).toBeVisible();
   }
  }
  await page.evaluate(()=>scrollTo(0,0));await page.getByTestId('clock-badge').click();
  await page.locator('.pav-clock').click();await page.locator('.pav-actions button').first().click();await page.locator('.pav-actions button').nth(1).click();
  expect(await page.evaluate(()=>(window as Window & {__clockDoors?:number}).__clockDoors)).toBe(4);
  // Actual links/callback doors inside the real shell; feature bodies are markers.
  for(const href of [`/photos?job=${PROJECT}`,'/my-schedule',`/current-work?job=${PROJECT}&unit=${UNIT}`]){
   await page.locator(`.sjwr a[href="${href}"]`).first().click();await expect(page.getByTestId('destination')).toContainText(href);
   expect(await page.locator('.clock-badge-text').evaluate(el=>getComputedStyle(el).whiteSpace)).toBe('nowrap');
   await page.getByRole('link',{name:'Return to Work'}).click();await chooseJob(page);
  }
  await page.locator('.tabbar a[href="/ask"]').click();await expect(page.locator('.persistent-ask')).toContainText('Ask destination fixture');
  await page.getByRole('link',{name:'Return to Work'}).click();await chooseJob(page);
  await page.locator('.sync-strip .sync-pill').click();await expect(page.getByTestId('destination')).toContainText('/stuck');
  expect(unexpected).toEqual([]);
 });
}
test('actual shell hides selected job and unit data when offline or previewing; clock recovery door survives',async({page})=>{
 const unexpected=await setupRoute(page,true);await chooseJob(page);
 await page.context().setOffline(true);await expect(page.locator('.pav')).toHaveCount(0);await expect(page.getByTestId('sjwr-picker')).not.toContainText('BLACK22');
 await page.getByTestId('clock-badge').click();expect(await page.evaluate(()=>(window as Window & {__clockDoors?:number}).__clockDoors)).toBe(1);
 await page.context().setOffline(false);await expect(page.locator('.pav-tile')).toHaveCount(1);
 await page.evaluate(()=>dispatchEvent(new Event('fixture-preview')));await expect(page.locator('.pav')).toHaveCount(0);await expect(page.getByTestId('sjwr-picker')).not.toContainText('BLACK22');
 expect(unexpected).toEqual([]);
});

test('320px stale clock is labelled and reachable with no fabricated live counter or activity authoring',async({page})=>{
 await page.setViewportSize({width:320,height:740});const unexpected=await setupRoute(page,true);await chooseJob(page);
 await page.evaluate(()=>dispatchEvent(new Event('fixture-clock-stale')));await expect(page.locator('.pav-tile')).toHaveCount(0);
 for(const lang of ['en','es']){
  if(lang==='es')await page.evaluate(()=>dispatchEvent(new Event('fixture-language')));
  const badge=page.getByTestId('clock-badge');await expect(badge).toContainText(lang==='en'?'Last confirmed':'Último');
  await expect(page.locator('.ws-clock-timer')).toHaveCount(0);
  const before=await badge.textContent();await page.waitForTimeout(1100);expect(await badge.textContent()).toBe(before);
  await page.evaluate(()=>scrollTo(0,document.body.scrollHeight));await badge.click();
  const geometry=await page.evaluate(()=>{const el=document.querySelector('.clock-badge-text')!;return {width:el.clientWidth,scroll:el.scrollWidth,supports:CSS.supports('selector(:has(*))')};});
  expect(geometry.supports).toBe(true);expect(geometry.scroll).toBeLessThanOrEqual(geometry.width+1);
  if(process.env.FORGE_SHELL_ARTIFACTS)await page.screenshot({path:`${process.env.FORGE_SHELL_ARTIFACTS}/shell-320-${lang}-stale.png`,fullPage:false});
 }
 expect(unexpected).toEqual([]);
});

test('forced phone display at desktop width preserves clock/photo separation',async({page})=>{
 await page.setViewportSize({width:1440,height:900});const unexpected=await setupRoute(page,true);
 await page.evaluate(()=>{document.documentElement.dataset.displayLayout='phone';});await chooseJob(page);
 const geometry=await layoutEvidence(page);expect(geometry.overlapping).toBe(false);expect(geometry.dockPosition).toBe('fixed');expect(geometry.dock.bottom).toBeCloseTo(geometry.height,0);
 expect(unexpected).toEqual([]);
});
