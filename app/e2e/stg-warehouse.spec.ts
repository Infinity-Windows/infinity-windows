import { expect, test } from '@playwright/test';
import { useSupabaseFixtures } from './support/supabaseFixtures';
import { hideWrongProjectBanner, json } from './support/specHelpers';
const job='11111111-1111-4111-8111-111111111111';
const pkg='22222222-2222-4222-8222-222222222222';
async function configureWarehouseFixtures(page: Parameters<typeof useSupabaseFixtures>[0], capabilities: string[] = ['receive','move','checkout']) {
  await hideWrongProjectBanner(page);
  await page.route('**/rest/v1/rpc/is_partner_user',route=>json(route,true,null));
  await page.route('**/rest/v1/rpc/stg_job_list',route=>json(route,[{id:job,name:'STG Riverside',job_code:'RIV01',status:'active',progress_percent:20,window_start:null,window_end:null}],null));
  let status='minted';
  await page.route('**/rest/v1/rpc/stg_warehouse',route=>json(route,{capabilities,finalized_at:null,packages:[{id:pkg,serial:'PKG-000123',short_code:'ABC234',project_id:job,status,container_id:null,location_id:null,version:null,mark:'12',part_type:'frame',part_index:1,part_total:2,area:null,delivery_id:null}],containers:[],deliveries:[],supplies:[],history:[],undoable:[]},null));
  await page.route('**/rest/v1/rpc/stg_warehouse_command',route=>{const body=route.request().postDataJSON();expect(body.p_project).toBe(job);expect(body.p_input.packages).toEqual([pkg]);status='received';return json(route,{command:body.p_command,count:1},null);});
}
for (const width of [390,1280]) test(`partner warehouse selection and receiving at ${width}px`,async({page})=>{
  await page.setViewportSize({width,height:900});await useSupabaseFixtures(page,{role:'installer'});await configureWarehouseFixtures(page);await page.goto('/warehouse');
  await expect(page).toHaveURL(/\/stg\/?$/);await page.getByRole('button',{name:'Warehouse',exact:true}).click();
  await expect(page.getByText('Window 12',{exact:true})).toBeVisible();
  await page.getByRole('checkbox').check();await page.getByRole('button',{name:'Receive selected',exact:true}).click();
  await expect(page.getByRole('status')).toContainText('Saved');
  await expect(page.getByText('received · No container',{exact:true})).toBeVisible();
  await expect(page.getByRole('link',{name:'Payroll',exact:true})).toHaveCount(0);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.screenshot({path:`e2e/__screenshots__/stg-warehouse-${width}.png`,fullPage:true});
});
test('viewing-only partner sees inventory without mutation controls',async({page})=>{
  await useSupabaseFixtures(page,{role:'installer'});await configureWarehouseFixtures(page,[]);await page.goto('/stg');await page.getByRole('button',{name:'Warehouse',exact:true}).click();
  await expect(page.getByText('Viewing access.',{exact:false})).toBeVisible();
  await expect(page.getByRole('button',{name:'Receive selected'})).toHaveCount(0);
});
test('missing partner deployment is a setup error, not an empty job list',async({page})=>{
  await useSupabaseFixtures(page,{role:'installer'});await configureWarehouseFixtures(page);await page.route('**/rest/v1/rpc/stg_job_list',route=>route.fulfill({status:404,contentType:'application/json',body:JSON.stringify({code:'PGRST202',message:'missing'})}));
  await page.goto('/stg');await expect(page.getByText('Partner access is not ready. Ask the office to finish the portal setup.')).toBeVisible();
  await expect(page.getByText('No jobs yet',{exact:true})).toHaveCount(0);
});
test('an interrupted command survives reload and keeps its retry ID',async({page})=>{
  await useSupabaseFixtures(page,{role:'installer'});await configureWarehouseFixtures(page);let attempts=0;const ids:string[]=[];
  await page.route('**/rest/v1/rpc/stg_warehouse_command',route=>{
    const body=route.request().postDataJSON();ids.push(body.p_command);attempts++;
    return attempts===1?route.abort('internetdisconnected'):json(route,{command:body.p_command,count:1},null);
  });
  await page.goto('/stg');await page.getByRole('button',{name:'Warehouse',exact:true}).click();
  await page.getByRole('checkbox').check();await page.getByRole('button',{name:'Receive selected',exact:true}).click();
  await expect(page.getByText('Not sent yet (1)',{exact:true})).toBeVisible();
  await page.reload();await page.getByRole('button',{name:'Warehouse',exact:true}).click();
  await expect(page.getByText('Saved warehouse actions',{exact:true})).toBeVisible();
  expect(ids).toHaveLength(2);expect(ids[1]).toBe(ids[0]);
});
test('an interrupted package photo survives reload',async({page})=>{
  await useSupabaseFixtures(page,{role:'installer'});await configureWarehouseFixtures(page);let uploads=0;const paths:string[]=[];
  await page.route('**/rest/v1/rpc/stg_warehouse_photos',route=>json(route,[],null));
  await page.route('**/storage/v1/object/install-media/**',route=>{
    uploads++;paths.push(route.request().url());
    return uploads===1?route.abort('internetdisconnected'):json(route,{Key:'photo'},null);
  });
  await page.route('**/rest/v1/rpc/stg_attach_warehouse_photo',route=>json(route,null,null));
  await page.goto('/stg');await page.getByRole('button',{name:'Warehouse',exact:true}).click();await page.getByRole('checkbox').check();
  await page.locator('input[type=file]:not([capture])').setInputFiles({name:'condition.png',mimeType:'image/png',buffer:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aB1cAAAAASUVORK5CYII=','base64')});
  await expect(page.getByRole('button',{name:'Retry photo',exact:true})).toBeVisible();
  await page.reload();await page.getByRole('button',{name:'Warehouse',exact:true}).click();await page.getByRole('checkbox').check();
  await page.getByRole('button',{name:'Retry photo',exact:true}).click();
  await expect(page.getByRole('button',{name:'Retry photo',exact:true})).toHaveCount(0);
  expect(paths).toHaveLength(2);expect(paths[1]).toBe(paths[0]);
});
