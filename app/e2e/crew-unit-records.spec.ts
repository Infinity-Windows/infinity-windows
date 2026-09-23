import { expect, test, type Page } from '@playwright/test';
import { useSupabaseFixtures as installFixtures, jobFixtures, TEST_USER } from './support/supabaseFixtures';
import { hideWrongProjectBanner } from './support/specHelpers';
test.setTimeout(60000);
async function setup(page: Page, role: 'foreman' | 'installer' = 'foreman') {
  await installFixtures(page,{role}); await hideWrongProjectBanner(page);
  const job=jobFixtures()[0].projectId;
  await page.route('**/rest/v1/profiles**',async r=>{
    if(!new URL(r.request().url()).searchParams.get('select')?.includes('is_partner')) return r.fallback();
    return r.fulfill(counted([
      {id:'00000000-0000-4000-8000-000000000002',display_name:'Fixture Installer',role:'installer',active:true,is_partner:false},
      {id:'00000000-0000-4000-8000-000000000003',display_name:'Fixture Helper',role:'installer',active:true,is_partner:false},
      {id:TEST_USER.id,display_name:'Fixture Foreman',role,active:true,is_partner:false}
    ]));
  });
  const units: Record<string,unknown>[]=[];
  const records: Record<string,unknown>[]=[];
  const requests: Record<string,any>[]=[];
  let offline=false;
  const counted=(rows:unknown[])=>({json:rows,headers:{'access-control-expose-headers':'content-range', ...{'content-range':`0-${Math.max(0,rows.length-1)}/${rows.length}`}}});
  for(const table of ['custom_work_sessions','custom_work_types','custom_work_history']) await page.route(`**/rest/v1/${table}**`,r=>r.fulfill(counted([])));
  await page.route('**/rest/v1/custom_work_units**',r=>r.fulfill(counted(units)));
  await page.route('**/rest/v1/crew_work_records**',r=>r.fulfill(counted(records)));
  await page.route('**/rest/v1/rpc/record_crew_work',r=>{
    const body=r.request().postDataJSON();requests.push(body);
    if(offline) return r.abort('internetdisconnected');
    const data=body.p_data;
    if(!records.some(x=>x.id===body.p_id)) {
      units.push({...data.unit,created_by:TEST_USER.id,revision:1});
      records.push({id:body.p_id,project_id:job,unit_id:data.unit.id,filed_by:TEST_USER.id,...data,created_at:new Date().toISOString(),people:data.people.map((profile_id:string)=>({profile_id}))});
    }
    return r.fulfill({json:data.unit.id});
  });
  const otherMutations:string[]=[];
  page.on('request',r=>{if(r.method()==='POST' && /custom_work_command|clock_in|finish_unit/.test(r.url()))otherMutations.push(r.url());});
  return {job,units,records,requests,otherMutations,setOffline:(v:boolean)=>{offline=v;}};
}
async function build(page:Page,job:string) {
  await page.goto(`/current-work?job=${job}`);
  await page.getByRole('button',{name:/Record crew work/}).click();
  const form=page.locator('.cw-crew-records');
  await form.getByRole('combobox',{name:'Unit',exact:true}).selectOption('new');
  await form.getByRole('button',{name:'Build unit details'}).click();
  await form.getByLabel('Unit number / name').fill('Crew-16');
  await form.getByLabel('Type',{exact:true}).fill('Bifold door');
  await form.getByRole('combobox',{name:'Frame material',exact:true}).selectOption('Aluminum');
  await form.getByRole('button',{name:'Continue to crew & work date'}).click();
  await form.getByLabel('Work / assignment date').fill('2026-09-18');
  const people=form.locator('.cw-crew-picker input[type=checkbox]');
  await people.nth(0).check();await people.nth(1).check();
  await form.getByLabel('Work completed / instructions').fill('Crew installed together Friday. Filed from foreman notes.');
  return form;
}
test('foreman builds and credits two people without clocking anybody in; survives reload',async({page})=>{
  const state=await setup(page);
  const form=await build(page,state.job);
  await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.screenshot({path:'e2e/test-results/crew-unit-phone.png',fullPage:true});
  await form.getByLabel('Entire installation finished (all visits)').check();
  await form.getByRole('button',{name:'Save crew record',exact:true}).click();
  await expect.poll(()=>state.records.length).toBe(1);
  expect(state.requests[0].p_data.people).toHaveLength(2);
  expect(state.requests[0].p_data.work_date).toBe('2026-09-18');
  expect(state.requests[0].p_data.whole_complete).toBe(true);
  expect(state.otherMutations).toEqual([]);
  await page.reload();
  await page.getByText(/Crew assignments & filed work/).click();
  await expect(page.locator('.cw-crew-history')).toContainText('Crew-16');
  await expect(page.locator('.cw-crew-history')).toContainText('Filed by');
  await page.setViewportSize({width:1440,height:1000});
  await page.screenshot({path:'e2e/test-results/crew-unit-desktop.png',fullPage:true});
});
test('connection loss keeps the same record ID and crew assignment for retry',async({page})=>{
  const state=await setup(page);const form=await build(page,state.job);
  state.setOffline(true);
  await form.getByRole('button',{name:'Save crew record',exact:true}).click();
  await expect(form).toContainText('awaiting sync');
  const first=state.requests[0].p_id;
  state.setOffline(false);await page.reload();
  await expect.poll(()=>state.records.length).toBe(1);
  expect(state.requests.every(r=>r.p_id===first)).toBe(true);
  expect(state.otherMutations).toEqual([]);
});
test('ordinary installer cannot see the record-for-crew action',async({page})=>{
  const state=await setup(page,'installer');await page.goto(`/current-work?job=${state.job}`);
  await expect(page.getByRole('heading',{name:'Current Work',exact:true})).toBeVisible();
  await expect(page.getByRole('button',{name:/Record crew work/})).toHaveCount(0);
});
