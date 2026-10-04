import { expect, test, type Page } from "@playwright/test";
import { FIXTURE_AUTH_KEY, FIXTURE_SESSION, TEST_USER } from "./support/supabaseFixtures";
import { json } from "./support/specHelpers";

const PROJECT = "00000000-0000-4000-8000-000000000301";
const SHIFT = "00000000-0000-4000-8000-000000000302";
const SELECTION = "00000000-0000-4000-8000-000000000303";
const MENU = "00000000-0000-4000-8000-000000000304";
const DEFINITION = "00000000-0000-4000-8000-000000000305";
const VERSION = "00000000-0000-4000-8000-000000000306";
const OBSERVATION = "00000000-0000-4000-8000-000000000308";
const UNIT = "00000000-0000-4000-8000-000000000309";
const FACT = "00000000-0000-4000-8000-000000000310";
const utc = (date = new Date()) => date.toISOString().replace("Z", "000Z");
function unitBasis(bindingEpoch = 3) { return { id: UNIT, projectId: PROJECT, openingId: null,
  operationalRevision: 5, incarnationEpoch: 2, bindingEpoch, projectEpoch: 1, openingEpoch: null,
  fact: { id: FACT, revision: 2, eventKind: "observation", originProjectEpoch: 1, originOpeningEpoch: null,
    dimensions: { widthIn: 10, heightIn: 20, source: "measured",
      original: { width: 10, height: 20, unit: "in", source: "measured", sourceReference: null } }, estimated: false },
  eligibleForCapture: true, ineligibleReason: null }; }
async function setupRoute(page: Page) {
  await page.addInitScript(({key, session})=>localStorage.setItem(key,JSON.stringify(session)),{key:FIXTURE_AUTH_KEY,session:FIXTURE_SESSION});
  // Browser-only dependency injection: production release constant stays false
  // on disk. All actual API requests are replayed; no real writes are possible.
  await page.route("**/src/lib/paidClock/ClockFlowBridge.tsx",r=>r.fulfill({contentType:"application/javascript",body:"export const PAID_SETUP_RELEASE_AUTHORIZED=true; export default function(){return null;}"}));
  await page.route("**/src/lib/clockContext.tsx",r=>r.fulfill({contentType:"application/javascript",body:`
    import { signInGeneration } from '/src/lib/signedIn.ts';
    export const OPEN_CLOCK_EVENT='infinity:open-clock';
    export function openClockGlobally(){window.__clockDoors=(window.__clockDoors||0)+1;}
    export function useClock(){return {loading:false,refresh(){},nativeFlow:{ownerId:'${TEST_USER.id}',loginGeneration:signInGeneration(),route:'isolated',nativeRead:'ready',records:[],currentRead:'ready',canStartDay:false,canRequestSafety:true,current:{kind:'open',observedAt:'2026-10-04T12:30:00.000Z',shift:{id:'${SHIFT}',profile_id:'${TEST_USER.id}',project_id:null,cost_code_id:null,status:'open',clock_in_at:new Date(Date.now()-60000).toISOString(),clock_out_at:null,break_seconds:0,break_started_at:null}}}}}
  `}));
  const unexpected:string[]=[];
  await page.route('https://**/*',async r=>{
    const url=new URL(r.request().url());
    if(!url.hostname.endsWith('e2efixture.supabase.co'))return r.abort();
    const endpoint=url.pathname.split('/').pop();
    const args=r.request().method()==='POST'?r.request().postDataJSON():null;
    if(endpoint==='user')return json(r,TEST_USER,null);
    if(endpoint==='profiles')return json(r,{...TEST_USER,display_name:'Fixture Foreman',role:'foreman',active:true},null);
    if(endpoint==='projects')return json(r,[{id:PROJECT,name:'Black Desert 22',job_code:'BLACK22',active:true,allowed_modes:['data']}],null);
    if(endpoint==='cost_codes')return json(r,[{id:DEFINITION,code:'100',label:'Installation',active:true,is_general:true}],null);
    if(endpoint==='custom_work_units')return r.fulfill({contentType:'application/json',headers:{'content-range':'0-0/1','access-control-expose-headers':'content-range'},body:JSON.stringify([{id:UNIT,project_id:PROJECT,opening_id:null,created_by:TEST_USER.id,label:'Unit 42',type_label:'Bifold aluminum',facts:{},revision:1,created_at:utc(),updated_at:utc()}])});
    if(endpoint==='server_now')return json(r,new Date().toISOString(),null);
    if(endpoint==='get_or_create_toolbox_talk_for_date')return json(r,{id:OBSERVATION,title:'Site safety',body:'Fixture talk',talk_date:new Date().toISOString().slice(0,10)},null);
    if(endpoint==='crew_goal_summary')return json(r,{goal_hours:10,goal_revision:1,goal_updated_at:utc(),recorded_hours:3,running_provisional_hours:1,open_shifts:1,unresolved_shifts:0,allowance_hours:4,as_of:utc()},null);
    if(endpoint==='work_activity_snapshot')return json(r,{protocolVersion:1,asOf:utc(),deviceId:args.p_device_id,capability:{mode:'active',reasonCode:null},observation:{id:OBSERVATION,revision:0,lastTransitionId:null,issuedAt:utc(new Date(Date.now()-1000)),expiresAt:utc(new Date(Date.now()+600000)),shiftRef:{kind:'shift',id:SHIFT},currentGeneration:null,currentHeadCommandId:null},stream:null,state:{revision:0,lastTransitionId:null,integrity:'clean',status:'unclassified',choiceRequired:true,actions:{canEstablishStream:true,canSwitch:false,canFinishSetup:false,canStop:false},shift:{id:SHIFT,clockInCommandId:null,clockInAt:utc(new Date(Date.now()-60000)),breakStartedAt:null,breakType:null,status:'open',project:{visibility:'available',id:PROJECT,name:'Black Desert 22',jobCode:'BLACK22'}},activity:null}},null);
    if(endpoint==='work_activity_catalog')return json(r,{protocolVersion:1,asOf:utc(),availability:'available',projectId:PROJECT,unit:args.p_unit_id?unitBasis():null,selection:{selectionId:SELECTION,selectionRevision:2,menuVersionId:MENU,eligibleNow:true,activities:[{definitionId:DEFINITION,definitionVersionId:VERSION,position:0,enabled:true,scope:'general',labelEn:'Supplier Pickup',labelEs:'Recoger del proveedor',machineSelection:false,typedFields:[],eligibleNow:true,ineligibleReason:null}]},totals:{availability:'unavailable',reasonCode:'not_ready'}},null);
    if(endpoint==='work_activity_unit_basis')return json(r,{protocolVersion:1,asOf:utc(),availability:'available',unit:unitBasis()},null);
    // Display-only existing clock/toolbox/schedule/goals dependencies.
    if(['summons','schedule_assignment_members','company_settings','safety_talks','toolbox_completions','time_shifts','schedule_entries','install_summons','project_crew_goals','get_project_crew_goal','crew_project_goal_read','project_goal_current'].includes(endpoint??''))return json(r,[],null);
    unexpected.push(url.pathname);return json(r,[],null);
  });
  page.on('pageerror',e=>{throw e;});
  await page.goto('/e2e/support/selected-job-route.html');
  await page.getByRole('button',{name:/BLACK22.*Black Desert/}).click();
  await expect(page.locator('.pav')).toBeVisible();
  await expect(page.locator('.pav-tile')).toHaveCount(1);
  return unexpected;
}
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
