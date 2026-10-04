import { expect, test, type Page } from "@playwright/test";
import { PROJECT, UNIT, setupRoute } from "./support/selectedJobRouteFixture";
import { TEST_USER } from "./support/supabaseFixtures";
const SESSION="00000000-0000-4000-8000-000000000311";
const at="2026-10-04T12:00:00.000Z";
async function fixture(page:Page,entry="/") {
 const unexpected=await setupRoute(page,true,'/e2e/support/selected-job-unit-entry.html');
 const writes:Record<string,unknown>[]=[];
 await page.route('https://**/*',async route=>{
  const request=route.request(),url=new URL(request.url()),endpoint=url.pathname.split('/').pop();
  const list=(rows:unknown[])=>route.fulfill({contentType:'application/json',headers:{'content-range':rows.length?`0-${rows.length-1}/${rows.length}`:'*/0','access-control-expose-headers':'content-range'},body:JSON.stringify(rows)});
  if(endpoint==='custom_work_sessions')return list([{id:SESSION,profile_id:TEST_USER.id,project_id:PROJECT,unit_id:UNIT,started_at:at,ended_at:null,stage:'Installing',participation:'install',shift_id:'00000000-0000-4000-8000-000000000302',kind:'unit',note:null}]);
  if(endpoint==='custom_work_units')return list([{id:UNIT,project_id:PROJECT,opening_id:null,created_by:TEST_USER.id,label:'Unit 42',type_label:'Bifold aluminum',facts:{width_in:72,height_in:96,area_source:'Estimated',components:[{label:'leaf',quantity:3},{label:'frame',quantity:1}],opening_direction:'Left to right',direction_viewpoint:'Outside looking in'},revision:5,created_at:at,updated_at:at}]);
  if(endpoint==='custom_work_types'||endpoint==='crew_work_records')return list([]);
  if(endpoint==='profiles'&&request.headers()['prefer']?.includes('count'))return list([{...TEST_USER,display_name:'Fixture Foreman',role:'foreman',active:true}]);
  if(endpoint==='work_unit_fact_current_read')return route.fulfill({contentType:'application/json',body:JSON.stringify({protocolVersion:1,unitId:UNIT,revision:2,eventKind:'observation',observation:{width:10,height:20,unit:'in',source:'measured',sourceReference:null,estimated:false},widthIn:10,heightIn:20,observationActorId:TEST_USER.id,recordedAt:at})});
  if(endpoint==='custom_work_command'){
   writes.push(request.postDataJSON());
   return route.fulfill({contentType:'application/json',body:JSON.stringify(request.postDataJSON().p_id)});
  }
  if(endpoint?.includes('clock')||endpoint?.includes('punch')){writes.push({unexpectedPayroll:url.pathname});return route.abort();}
  return route.fallback();
 });
 if(entry!=="/")await page.evaluate(path=>window.dispatchEvent(new CustomEvent("fixture-navigate",{detail:path})),entry);
 return {writes,unexpected};
}
test('Add unit opens actual builder for selected job; cancel preserves current activity and clock',async({page})=>{
 const state=await fixture(page);
 await page.getByRole('button',{name:/BLACK22.*Black Desert/}).click();
 await page.getByRole('tab',{name:'Specific',exact:true}).click();
 await page.getByRole('button',{name:'Add unit',exact:true}).click();
 await expect(page.getByLabel('Unit number / name',{exact:true})).toBeVisible();
 await page.screenshot({path:'/Users/emmatimpson/Documents/ChatGPT/Forge Windows and Doors App/outputs/Forge-Selected-Job-Route-2026-10-04/UNIT-ENTRY-PHONE.png'});
 const box=await page.locator('.cw-editor').boundingBox();expect(box).not.toBeNull();expect(box!.x).toBeGreaterThanOrEqual(0);expect(box!.x+box!.width).toBeLessThanOrEqual(page.viewportSize()!.width+1);
 await expect(page.getByRole('combobox',{name:'Job',exact:true})).toHaveValue(PROJECT);
 await expect(page.getByRole('region',{name:'Current activity'})).toContainText('Unit 42');
 await page.getByRole('button',{name:'Cancel',exact:true}).click();
 await expect(page.getByLabel('Unit number / name',{exact:true})).toHaveCount(0);
 await expect(page.getByRole('region',{name:'Current activity'})).toContainText('Unit 42');
 expect(state.writes).toEqual([]);expect(state.unexpected).toEqual([]);
 expect(await page.evaluate(()=>localStorage.getItem('forge-custom-work-v1:00000000-0000-4000-8000-0000000000e2'))).toBeNull();
 expect(await page.evaluate(()=>(window as Window&{__clockDoors?:number}).__clockDoors??0)).toBe(0);
});

test('explicit Save details records the selected job and dimensions without starting another activity',async({page})=>{
 const state=await fixture(page,`/current-work?job=${PROJECT}&new_unit=1`);
 await page.getByLabel('Unit number / name',{exact:true}).fill('Unit 43');
 await page.getByLabel('Frame width (inches)',{exact:true}).fill('72');
 await page.getByLabel('Frame height (inches)',{exact:true}).fill('96');
 await page.locator('.cw-editor-helpful summary').click();
 await page.getByRole('combobox',{name:'Measurement source',exact:true}).selectOption('Estimated');
 await page.getByRole('button',{name:'Save details',exact:true}).click();
 await expect.poll(()=>state.writes.length).toBe(1);
 expect(state.writes[0]).toMatchObject({p_action:'unit',p_data:{project_id:PROJECT,label:'Unit 43',facts:{width_in:72,height_in:96,area_source:'Estimated'}}});
 await expect(page.getByRole('region',{name:'Current activity'})).toContainText('Unit 42');
 await expect(page.getByLabel('Unit number / name',{exact:true})).toHaveCount(0);
 expect(await page.evaluate(()=>(window as Window&{__clockDoors?:number}).__clockDoors??0)).toBe(0);
 expect(state.unexpected).toEqual([]);
});
test('editing an existing unit preserves captured components and voice facts',async({page})=>{
 const state=await fixture(page,`/current-work?job=${PROJECT}&unit=${UNIT}`);
 await page.getByRole('button',{name:'Edit unit details',exact:true}).click();
 await expect(page.getByLabel('Also recorded')).toContainText('3 × leaf, 1 × frame');
 await page.getByLabel('Frame width (inches)',{exact:true}).fill('73');
 await page.getByRole('button',{name:'Save details',exact:true}).click();
 await expect.poll(()=>state.writes.length).toBe(1);
 expect(state.writes[0]).toMatchObject({p_action:'unit',p_data:{id:UNIT,revision:5,facts:{width_in:73,height_in:96,area_source:'Estimated',components:[{label:'leaf',quantity:3},{label:'frame',quantity:1}],opening_direction:'Left to right',direction_viewpoint:'Outside looking in'}}});
 expect(state.unexpected).toEqual([]);
});
test('malformed or ambiguous create links never open a new draft or write',async({page})=>{
 for(const query of ['job=bad&new_unit=1',`job=${PROJECT}&new_unit=1&new_unit=1`,`job=${PROJECT}&new_unit=1&unit=${UNIT}`,`job=${PROJECT}&new_unit=1&opening=${UNIT}`,`job=${PROJECT}&new_unit=true`]){
  const state=await fixture(page,`/current-work?${query}`);
  await expect(page.getByRole('heading',{name:'Current Work',exact:true})).toBeVisible();
  await expect(page.getByText('This new unit link is invalid. Choose a job and use Add unit.')).toBeVisible();
  await expect(page.getByLabel('Unit number / name',{exact:true})).toHaveCount(0);
  expect(state.writes).toEqual([]);
 }
});
test('a draft cannot save offline or in role preview; cancel still works',async({page})=>{
 const state=await fixture(page,`/current-work?job=${PROJECT}&new_unit=1`);
 await expect(page.getByLabel('Unit number / name',{exact:true})).toBeVisible();
 await page.evaluate(()=>{Object.defineProperty(navigator,'onLine',{configurable:true,value:false});window.dispatchEvent(new Event('offline'));});
 await page.getByRole('button',{name:'Save details',exact:true}).click();
 await expect(page.getByRole('alert').filter({hasText:'Return to your selected job'})).toBeVisible();
 expect(state.writes).toEqual([]);
 await page.evaluate(()=>{Object.defineProperty(navigator,'onLine',{configurable:true,value:true});window.dispatchEvent(new Event('online'));window.dispatchEvent(new Event('fixture-preview'));});
 await page.getByRole('button',{name:'Save details',exact:true}).click();
 expect(state.writes).toEqual([]);
 await page.getByRole('button',{name:'Cancel',exact:true}).click();
 await expect(page.getByLabel('Unit number / name',{exact:true})).toHaveCount(0);
});
test('actual dimension editor rejects zero/missing source; estimates stay unverified with matched revisions',async({page})=>{
 const state=await fixture(page,'/dimensions');
 await expect(page.getByText('Recorded original observation (not verified)',{exact:true})).toBeVisible();
 await page.getByRole('button',{name:'Enter dimensions',exact:true}).click();
 await page.getByLabel('Width',{exact:true}).fill('0');
 await page.getByLabel('Height',{exact:true}).fill('20');
 await page.getByRole('combobox',{name:'Dimension source',exact:true}).selectOption('measured');
 await page.getByRole('button',{name:'Save dimension request',exact:true}).click();
 await expect(page.getByRole('alert').filter({hasText:'Enter positive decimal dimensions'})).toBeVisible();
 expect(await page.evaluate(()=>(window as Window&{__dimensionIntents?:unknown[]}).__dimensionIntents??[])).toEqual([]);
 await page.getByLabel('Width',{exact:true}).fill('10');
 await page.getByRole('combobox',{name:'Dimension source',exact:true}).selectOption('');
 await page.getByRole('button',{name:'Save dimension request',exact:true}).click();
 expect(await page.evaluate(()=>(window as Window&{__dimensionIntents?:unknown[]}).__dimensionIntents??[])).toEqual([]);
 await page.getByRole('combobox',{name:'Dimension source',exact:true}).selectOption('estimated');
 await expect(page.getByText('This estimate is excluded from trusted averages until verified.',{exact:true})).toBeVisible();
 await page.getByRole('button',{name:'Save dimension request',exact:true}).click();
 await expect(page.getByText('Save request stored. Refresh to check the current unit; server confirmation is pending.',{exact:true})).toBeVisible();
 expect(await page.evaluate(()=>(window as Window&{__dimensionIntents?:unknown[]}).__dimensionIntents)).toEqual([expect.objectContaining({id:UNIT,project_id:PROJECT,revision:5,expected_fact_revision:2})]);
 await expect(page.getByRole('button',{name:'Save dimension request',exact:true})).toBeDisabled();
 expect(state.writes).toEqual([]);expect(state.unexpected).toEqual([]);
});
test('dimension cancel, preview and offline never produce an intent',async({page})=>{
 await fixture(page,'/dimensions');
 await page.getByRole('button',{name:'Enter dimensions',exact:true}).click();
 await page.getByLabel('Width',{exact:true}).fill('12');
 await page.getByRole('button',{name:'Cancel',exact:true}).click();
 await expect(page.getByLabel('Width',{exact:true})).toHaveCount(0);
 await page.evaluate(()=>window.dispatchEvent(new Event('fixture-preview')));
 await expect(page.getByText('Current dimensions are unavailable here.',{exact:true})).toBeVisible();
 await expect(page.getByRole('button',{name:'Enter dimensions',exact:true})).toHaveCount(0);
 await page.evaluate(()=>{window.dispatchEvent(new Event('fixture-preview'));Object.defineProperty(navigator,'onLine',{configurable:true,value:false});window.dispatchEvent(new Event('offline'));});
 await expect(page.getByText('Current dimensions are unavailable here.',{exact:true})).toBeVisible();
 expect(await page.evaluate(()=>(window as Window&{__dimensionIntents?:unknown[]}).__dimensionIntents??[])).toEqual([]);
});
