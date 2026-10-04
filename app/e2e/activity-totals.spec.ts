import {expect,test,type Page} from "@playwright/test";
import corpus from "../src/lib/workActivityTotals/__fixtures__/sourceMatchedWire.json" with { type: "json" };
declare global { interface Window { activityTotalsFixture:{select:(unit:string|null)=>void;check:()=>void;hold:()=>void} } }
type FixtureWindow=Window;
const general=corpus.calls[0].result.totals!;
const eligible=corpus.calls.find(c=>c.result.totals?.cohort?.eligible===true)!.result;
async function fixture(page:Page,index=0,lang="en"){
 const calls:Record<string,unknown>[]=[];const unexpected:string[]=[];
 await page.route('https://**/*',async r=>{
  const url=new URL(r.request().url());const endpoint=url.pathname.split('/').pop();
  if(url.hostname==='fonts.googleapis.com'&&url.pathname==='/css2')return r.fulfill({contentType:'text/css',body:''});
  if(endpoint==='work_activity_totals_read'){calls.push(r.request().postDataJSON());return r.fulfill({contentType:'application/json',body:JSON.stringify(corpus.calls[index].result)});}
  if(endpoint==='profiles')return r.fulfill({contentType:'application/json',body:JSON.stringify({id:corpus.calls[index].result.totals?.actorId??general.actorId,role:'owner',retired_at:null})});
  if(endpoint==='user')return r.fulfill({contentType:'application/json',body:JSON.stringify({id:corpus.calls[index].result.totals?.actorId??general.actorId})});
  unexpected.push(endpoint??'unknown');return r.abort();
 });
 // Supabase getSession is actual auth API with synthetic valid session only.
 await page.addInitScript(({owner})=>{localStorage.setItem('sb-e2efixture-auth-token',JSON.stringify({access_token:'fixture-token',refresh_token:'fixture-refresh',expires_at:4102444800,expires_in:3600,token_type:'bearer',user:{id:owner}}));},{owner:corpus.calls[index].result.totals?.actorId??general.actorId});
 await page.goto(`/e2e/support/activity-totals.html?lang=${lang}&index=${index}`);
 return {calls,unexpected};
}
test('actual read transport preserves full general time and included machine subset',async({page})=>{
 const state=await fixture(page);await expect(page.getByRole('heading',{name:'Recorded activity totals'})).toBeVisible();await expect(page.getByText('Machine time is included in activity time.')).toBeVisible();
 expect(state.calls[0]).toEqual({p_project_id:general.projectId,p_unit_id:null});expect(state.unexpected).toEqual([]);
 const before=Number((await page.getByLabel('Tile totals').textContent())!.split('/')[0]);await expect.poll(async()=>Number((await page.getByLabel('Tile totals').textContent())!.split('/')[0])).toBeGreaterThan(before);
});
test('source-matched eligible unit rate uses verified same-unit labor and area',async({page})=>{
 const index=corpus.calls.findIndex(c=>c.result.totals?.cohort?.eligible===true),state=await fixture(page,index);
 await page.evaluate(unit=>(window as FixtureWindow).activityTotalsFixture.select(unit),eligible.totals!.unitId);
 await expect(page.getByText(/hours per100 sq ft/)).toBeVisible();await expect(page.getByText(/same eligible unit/)).toBeVisible();expect(state.unexpected).toEqual([]);
});
test('unavailable and partial remain distinct without trusted rate or fake zero',async({page})=>{
 const index=corpus.calls.findIndex(c=>c.result.totals?.complete===false),raw=corpus.calls[index].result;
 await fixture(page,index);if(raw.totals?.unitId)await page.evaluate(unit=>(window as FixtureWindow).activityTotalsFixture.select(unit),raw.totals.unitId);
 await expect(page.getByText(/Partial — known subtotal/).first()).toBeVisible();await expect(page.getByText(/hours per100 sq ft/)).toHaveCount(0);
});
test('late response cannot restore totals after the live parent closes',async({page})=>{
 let release!:(()=>void);const wait=new Promise<void>(done=>release=done);await fixture(page);
 await page.route('**/rest/v1/rpc/work_activity_totals_read',async r=>{await wait;await r.fulfill({contentType:'application/json',body:JSON.stringify(corpus.calls[0].result)});});
 await page.evaluate(()=>(window as FixtureWindow).activityTotalsFixture.check());await page.waitForTimeout(50);await page.evaluate(()=>(window as FixtureWindow).activityTotalsFixture.hold());release();
 await expect(page.getByText('Totals are unavailable. Check the current records.')).toBeVisible();await expect(page.getByText('Authorized payroll reconciliation')).toHaveCount(0);
});
for(const lang of ['en','es'])for(const width of [320,390])test(`${lang} totals at ${width}px stay readable`,async({page})=>{
 await page.setViewportSize({width,height:420});await fixture(page,0,lang);await expect(page.getByText(lang==='en'?'Machine time is included in activity time.':'El tiempo de máquina ya está incluido en la actividad.')).toBeVisible();
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);const button=page.getByRole('button',{name:lang==='en'?'Check totals':'Revisar totales'});expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(44);
});
