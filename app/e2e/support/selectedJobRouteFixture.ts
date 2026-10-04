import { expect, type Page } from "@playwright/test";
import { FIXTURE_AUTH_KEY, FIXTURE_SESSION, TEST_USER } from "./supabaseFixtures";
import { json } from "./specHelpers";

export const PROJECT = "00000000-0000-4000-8000-000000000301";
const SHIFT = "00000000-0000-4000-8000-000000000302";
const SELECTION = "00000000-0000-4000-8000-000000000303";
const MENU = "00000000-0000-4000-8000-000000000304";
const DEFINITION = "00000000-0000-4000-8000-000000000305";
const VERSION = "00000000-0000-4000-8000-000000000306";
const OBSERVATION = "00000000-0000-4000-8000-000000000308";
export const UNIT = "00000000-0000-4000-8000-000000000309";
const FACT = "00000000-0000-4000-8000-000000000310";
const utc = (date = new Date()) => date.toISOString().replace("Z", "000Z");
function unitBasis(bindingEpoch = 3) { return { id: UNIT, projectId: PROJECT, openingId: null,
  operationalRevision: 5, incarnationEpoch: 2, bindingEpoch, projectEpoch: 1, openingEpoch: null,
  fact: { id: FACT, revision: 2, eventKind: "observation", originProjectEpoch: 1, originOpeningEpoch: null,
    dimensions: { widthIn: 10, heightIn: 20, source: "measured",
      original: { width: 10, height: 20, unit: "in", source: "measured", sourceReference: null } }, estimated: false },
  eligibleForCapture: true, ineligibleReason: null }; }
export async function setupRoute(page: Page, shell = false, fixtureUrl?: string) {
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
  if (shell) {
    await page.addInitScript(()=>localStorage.setItem('infinity-perm-wizard-choice','completed'));
    // Shell is real; only the queue observation is injected, not its renderer.
    await page.route("**/src/lib/offline/useOutbox.ts",r=>r.fulfill({contentType:"application/javascript",body:`
      import { pillSummary } from '/src/lib/offline/outbox-core.ts';
      const counts={clock:0,photos:5,memos:0,receipts:0,logs:0,other:0,deadLetter:0,warehouse:0,toolbox:0};
      export function useOutbox(){return {counts,pill:pillSummary(counts),held:0,unknown:0};}
    `}));
    // Ask's actual navigation door is checked; its independent feature UI is
    // outside this route-owned acceptance and is explicitly a marker here.
    await page.route("**/src/pages/AskInfinity.tsx",r=>r.fulfill({contentType:"application/javascript",body:"export function AskInfinity(){return 'Ask destination fixture';}"}));
    await page.route("**/src/lib/clockContext.tsx",r=>r.fulfill({contentType:"application/javascript",body:"export * from '/e2e/support/selectedJobShellClock.ts';"}));
  }
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
    if(endpoint==='can_read_app_update')return json(r,false,null);
    if(endpoint==='server_now')return json(r,new Date().toISOString(),null);
    if(endpoint==='get_or_create_toolbox_talk_for_date')return json(r,{id:OBSERVATION,title:'Site safety',body:'Fixture talk',talk_date:new Date().toISOString().slice(0,10)},null);
    if(endpoint==='crew_goal_summary')return json(r,{goal_hours:10,goal_revision:1,goal_updated_at:utc(),recorded_hours:3,running_provisional_hours:1,open_shifts:1,unresolved_shifts:0,allowance_hours:4,as_of:utc()},null);
    if(endpoint==='work_activity_snapshot')return json(r,{protocolVersion:1,asOf:utc(),deviceId:args.p_device_id,capability:{mode:'active',reasonCode:null},observation:{id:OBSERVATION,revision:0,lastTransitionId:null,issuedAt:utc(new Date(Date.now()-1000)),expiresAt:utc(new Date(Date.now()+600000)),shiftRef:{kind:'shift',id:SHIFT},currentGeneration:null,currentHeadCommandId:null},stream:null,state:{revision:0,lastTransitionId:null,integrity:'clean',status:'unclassified',choiceRequired:true,actions:{canEstablishStream:true,canSwitch:false,canFinishSetup:false,canStop:false},shift:{id:SHIFT,clockInCommandId:null,clockInAt:utc(new Date(Date.now()-60000)),breakStartedAt:null,breakType:null,status:'open',project:{visibility:'available',id:PROJECT,name:'Black Desert 22',jobCode:'BLACK22'}},activity:null}},null);
    if(endpoint==='work_activity_catalog')return json(r,{protocolVersion:1,asOf:utc(),availability:'available',projectId:PROJECT,unit:args.p_unit_id?unitBasis():null,selection:{selectionId:SELECTION,selectionRevision:2,menuVersionId:MENU,eligibleNow:true,activities:[{definitionId:DEFINITION,definitionVersionId:VERSION,position:0,enabled:true,scope:'general',labelEn:'Supplier Pickup',labelEs:'Recoger del proveedor',machineSelection:false,typedFields:[],eligibleNow:true,ineligibleReason:null}]},totals:{availability:'unavailable',reasonCode:'not_ready'}},null);
    if(endpoint==='work_activity_unit_basis')return json(r,{protocolVersion:1,asOf:utc(),availability:'available',unit:unitBasis()},null);
    // Display-only existing clock/toolbox/schedule/goals dependencies.
    if(['app_release_notes','project_openings','summons','schedule_assignment_members','company_settings','safety_talks','toolbox_completions','time_shifts','schedule_entries','install_summons','project_crew_goals','get_project_crew_goal','crew_project_goal_read','project_goal_current'].includes(endpoint??''))return json(r,[],null);
    unexpected.push(url.pathname);return json(r,[],null);
  });
  page.on('pageerror',e=>{throw e;});
  await page.goto(fixtureUrl ?? (shell?'/e2e/support/selected-job-shell.html':'/e2e/support/selected-job-route.html'));
  if(!shell)await page.getByRole('button',{name:/BLACK22.*Black Desert/}).click();
  if(!shell)await expect(page.locator('.pav')).toBeVisible();
  if(!shell)await expect(page.locator('.pav-tile')).toHaveCount(1);
  return unexpected;
}
