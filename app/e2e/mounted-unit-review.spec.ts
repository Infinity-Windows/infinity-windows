import { expect, test, type Page } from "@playwright/test";
import { setupMountedReview, PROJECT, UNIT, unitBasis } from "./support/mountedUnitReviewFixture";
import { TEST_USER } from "./support/supabaseFixtures";
import type { MountedReviewFixture } from "./support/mountedUnitReviewHarness";
import type { ReviewPayload, ReviewStoredReceipt, ReviewReply } from "../src/lib/workUnitReview/protocol";
// Type-only import exposes the synthetic browser controls to this spec.
void (null as unknown as MountedReviewFixture);
const unexpectedRequests = new Map<Page, string[]>();
test.afterEach(async ({page}) => { expect(unexpectedRequests.get(page) ?? []).toEqual([]); unexpectedRequests.delete(page); });
const OTHER = "00000000-0000-4000-8000-000000000311";
const EVENT = "00000000-0000-4000-8000-000000000312";
function current(unitId = UNIT): ReviewReply { return { protocolVersion:1,asOf:"2026-10-04T12:00:00.000000Z",availability:"available",review:{
 basis:{unitId,unitRevision:5,factId:unitBasis().fact.id,factRevision:2,scopeToken:`ur1:${"a".repeat(64)}`,reviewRevision:0,submissionId:null,generation:0},basisStatus:"current",
 observation:{observerId:OTHER,source:"estimated",widthDecimal:"10.000000000001",heightDecimal:"20",unit:"in",sourceReference:"Original estimate"},
 capabilities:{verifyDimensions:true,submit:true,pass:false,fail:false,claimResolved:false,reopen:false},dimensionVerification:{state:"unverified",verificationId:null},
 qc:{state:"not_submitted",acceptance:"not_accepted",lifecycle:"proven",qcAccepted:false},work:{availability:"available",activeCount:0,pendingCount:0},defects:[]}}; }
async function setup(page:Page){
 const server={reads:0,writes:[] as {id:string;payload:ReviewPayload;durable:boolean}[],ledger:new Map<string,ReviewStoredReceipt>(),lose:false,receipts:true,hold:false,pending:[] as (()=>void)[],cancel:0,holdUnit:false,unitPending:[] as (()=>void)[]};
 const unexpected = await setupMountedReview(page,async()=>{
  await page.route("**/rest/v1/profiles*",r=>r.fulfill({contentType:"application/json",body:JSON.stringify({...TEST_USER,display_name:"Synthetic owner",role:"owner",active:true})}));
  await page.route("**/rest/v1/custom_work_units*",r=>r.fulfill({contentType:"application/json",headers:{"content-range":"0-1/2","access-control-expose-headers":"content-range"},body:JSON.stringify([UNIT,OTHER].map((id,i)=>({id,project_id:PROJECT,opening_id:null,created_by:TEST_USER.id,label:`Unit ${42+i}`,type_label:"Bifold aluminum",facts:{},revision:1,created_at:"2026-10-04T12:00:00.000000Z",updated_at:"2026-10-04T12:00:00.000000Z"})))}));
  await page.route("**/rest/v1/rpc/work_activity_unit_basis",async r=>{const id=r.request().postDataJSON().p_unit_id;if(server.holdUnit)await new Promise<void>(yes=>server.unitPending.push(yes));return r.fulfill({contentType:"application/json",body:JSON.stringify({protocolVersion:1,asOf:"2026-10-04T12:00:00.000000Z",availability:"available",unit:{...unitBasis(),id}})});});
  await page.route("**/rest/v1/rpc/work_unit_review*",async r=>{
   const endpoint=new URL(r.request().url()).pathname.split("/").pop(), args=r.request().postDataJSON();
   const send=(value:unknown)=>r.fulfill({contentType:"application/json",body:JSON.stringify(value)});
   if(endpoint==="work_unit_review_read") {server.reads++;const result=current(args.p_unit_id);if(server.hold)await new Promise<void>(yes=>server.pending.push(yes));return send(result);}
   if(endpoint==="work_unit_review_command_receipt")return send(server.receipts&&server.ledger.has(args.p_command_id)?{protocolVersion:1,availability:"available",receipt:server.ledger.get(args.p_command_id)}:{protocolVersion:1,availability:"unavailable",receipt:null});
   const id=args.p_command_id as string,payload=args.p_payload as ReviewPayload;
   if(endpoint==="work_unit_review_cancel")server.cancel++;
   else {
    const durable=await page.evaluate(async id=>{const f=window.mountedReviewFixture,rows=await f.storage.readReviewJournal(f.auth.signInMark(),"00000000-0000-4000-8000-000000000309",()=>true);const row=rows.find(x=>x.commandId===id);return row?.durability==="strict"&&row.attempts.at(-1)?.outcome==="pending";},id);
    server.writes.push({id,payload,durable});
   }
   const receipt=server.ledger.get(id)??(endpoint==="work_unit_review_cancel"?{protocolVersion:1,commandId:id,action:payload.action,unitId:payload.basis.unitId,recordedAt:"2026-10-04T12:00:01Z",outcome:"cancelled",original:payload}:{protocolVersion:1,commandId:id,action:payload.action,unitId:payload.basis.unitId,eventId:EVENT,reviewRevision:payload.basis.reviewRevision+1,generation:payload.basis.generation,submissionId:payload.basis.submissionId,recordedAt:"2026-10-04T12:00:01Z",outcome:"applied"}) as ReviewStoredReceipt;
   server.ledger.set(id,receipt);
   if(server.lose&&endpoint==="work_unit_review_command")return r.abort("failed");return send(receipt);
  });
 });
 unexpectedRequests.set(page, unexpected);
 return server;
}
async function choose(page:Page){await page.getByRole("tab",{name:"Specific",exact:true}).click();await page.getByRole("combobox",{name:"Choose a unit"}).selectOption(UNIT);await expect(page.getByTestId("unit-review-current")).toBeVisible();}
async function verify(page:Page){const form=page.getByTestId("unit-verification-fields");await form.getByRole("textbox",{name:"Width",exact:true}).fill("0010.000000000001");await form.getByRole("textbox",{name:"Height",exact:true}).fill("20.00");await form.getByLabel("Evidence source",{exact:true}).selectOption("measured");await form.getByRole("textbox",{name:"Where did you check these dimensions?",exact:true}).fill("Private measured original");await form.getByRole("button",{name:"Send dimension verification",exact:true}).click();}
test("actual mounted route retains exact request before RPC and refreshes current flags separately",async({page})=>{
 const server=await setup(page);await choose(page);const reads=server.reads;await page.waitForTimeout(2100);expect(server.reads).toBe(reads);
 await verify(page);await expect(page.getByTestId("unit-review-history")).toContainText("Applied receipt recorded");expect(server.writes).toHaveLength(1);expect(server.writes[0].durable).toBe(true);expect(server.writes[0].payload.data).toMatchObject({widthDecimal:"10.000000000001",heightDecimal:"20"});
 await expect(page.getByTestId("unit-review-current")).toContainText("Dimensions are not currently verified");await expect(page.getByTestId("unit-review-current")).toContainText("Final QC is not currently accepted");
 await page.getByRole("button",{name:"Refresh unit details",exact:true}).click();await expect(page.getByTestId("unit-review-current")).toBeVisible();expect(server.writes).toHaveLength(1);expect(server.cancel).toBe(0);
});
test("lost response reload recovers same UUID without another delivery; explicit cancellation returns original winner",async({page})=>{
 const server=await setup(page);await choose(page);server.lose=true;server.receipts=false;await verify(page);await expect(page.getByTestId("unit-review-history")).toContainText("Outcome unknown");await expect(page.getByRole("button",{name:"Submit for final QC",exact:true})).toBeDisabled();
 const id=server.writes[0].id;await page.reload();await page.getByRole("button",{name:/BLACK22.*Black Desert/}).click();await choose(page);await expect(page.getByTestId("unit-review-history")).toContainText("Outcome unknown");expect(server.writes).toHaveLength(1);
 await page.getByRole("button",{name:"Cancel saved request",exact:true}).click();await expect(page.getByTestId("unit-review-history")).toContainText("Applied receipt recorded");expect(server.writes[0].id).toBe(id);expect(server.cancel).toBe(1);
});
test("late review response cannot reopen a changed tab or navigation, and refresh remains usable",async({page})=>{
 const server=await setup(page);await choose(page);server.hold=true;await page.getByRole("button",{name:"Check current review",exact:true}).click();await expect.poll(()=>server.pending.length).toBe(1);
 await page.getByRole("tab",{name:"General",exact:true}).click();server.hold=false;server.pending.splice(0).forEach(yes=>yes());await expect(page.getByTestId("unit-review-panel")).toHaveCount(0);
 await page.getByRole("tab",{name:"Specific",exact:true}).click();await expect(page.getByTestId("unit-review-current")).toBeVisible();
 await page.getByRole("button",{name:"Ask",exact:true}).click();await expect(page.getByText("Navigation destination")).toBeVisible();await page.goBack();await page.getByRole("button",{name:/BLACK22.*Black Desert/}).click();await choose(page);expect(server.writes).toHaveLength(0);
});
test("actual preview ABA, profile invalidation, and offline boundaries hide drafts without sending",async({page})=>{
 const server=await setup(page);await choose(page);await page.getByTestId("unit-verification-fields").getByRole("textbox",{name:"Width",exact:true}).fill("123.45");
 await page.evaluate(()=>{const f=window.mountedReviewFixture;f.preview().setPreviewRole("installer");f.preview().returnAsYourself?.();});
 await expect(page.getByTestId("unit-verification-fields").getByRole("textbox",{name:"Width",exact:true})).not.toHaveValue("123.45");
 await page.evaluate(()=>window.mountedReviewFixture.qc.invalidateQueries({queryKey:["myRealProfile"]}));await expect(page.getByTestId("unit-review-current")).toBeVisible();
 await page.context().setOffline(true);await expect(page.getByTestId("unit-review-current")).toHaveCount(0);await expect(page.getByRole("button",{name:"More clock options",exact:true})).toBeVisible();await page.context().setOffline(false);expect(server.writes).toHaveLength(0);
});
for(const width of [320,390])test(`mounted review English/Spanish fits ${width}px`,async({page})=>{await page.setViewportSize({width,height:620});await setup(page);await choose(page);await page.getByRole("button",{name:"EN/ES",exact:true}).click();await expect(page.getByTestId("unit-review-current")).toContainText("control final");expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);});

test("a late parent refresh cannot revive the prior unit after selection ABA",async({page})=>{
 const server=await setup(page);await choose(page);server.holdUnit=true;await page.getByRole("button",{name:"Refresh unit details",exact:true}).click();await expect.poll(()=>server.unitPending.length).toBe(1);await expect(page.getByTestId("unit-review-current")).toHaveCount(0);
 server.holdUnit=false;await page.getByRole("combobox",{name:"Choose a unit"}).selectOption(OTHER);await expect(page.getByTestId("unit-review-current")).toBeVisible();
 await page.getByRole("combobox",{name:"Choose a unit"}).selectOption(UNIT);await expect(page.getByTestId("unit-review-current")).toBeVisible();const count=server.reads;server.unitPending.splice(0).forEach(yes=>yes());await page.waitForTimeout(200);expect(server.reads).toBe(count);expect(server.writes).toHaveLength(0);
});
test("owner ABA discards a pending review and starts a new selected surface",async({page})=>{
 const server=await setup(page);await choose(page);server.hold=true;await page.getByRole("button",{name:"Check current review",exact:true}).click();await expect.poll(()=>server.pending.length).toBe(1);
 await page.evaluate(()=>{const f=window.mountedReviewFixture,id=f.auth.signInMark().userId!;f.auth.rememberSignedIn(null);f.auth.rememberSignedIn({user:{id}});});server.hold=false;server.pending.splice(0).forEach(yes=>yes());
 await expect(page.getByTestId("unit-review-current")).toHaveCount(0);await page.getByRole("button",{name:/BLACK22.*Black Desert/}).click();await choose(page);expect(server.writes).toHaveLength(0);
});
test("source expiry hides sensitive fields and explicit unit refresh restores them",async({page})=>{
 await page.clock.install();const server=await setup(page);await choose(page);await page.clock.fastForward(30002);await expect(page.getByTestId("unit-review-current")).toHaveCount(0);
 await page.getByRole("button",{name:"Refresh unit details",exact:true}).click();await expect(page.getByTestId("unit-review-current")).toBeVisible();expect(server.writes).toHaveLength(0);expect(server.cancel).toBe(0);
});

test("focus refresh closes pending review before the route refreshes its job and unit sources",async({page})=>{
 const server=await setup(page);await choose(page);server.hold=true;await page.getByRole("button",{name:"Check current review",exact:true}).click();await expect.poll(()=>server.pending.length).toBe(1);
 await page.evaluate(()=>window.dispatchEvent(new FocusEvent("focus")));server.hold=false;server.pending.splice(0).forEach(yes=>yes());await expect(page.getByTestId("unit-review-current")).toHaveCount(0);
 await choose(page);expect(server.writes).toHaveLength(0);expect(server.cancel).toBe(0);
});

test("reselecting the same tab keeps explicit unit refresh usable without reviving old review",async({page})=>{
 const server=await setup(page);await choose(page);await page.getByRole("tab",{name:"Specific",exact:true}).click();await expect(page.getByTestId("unit-review-current")).toHaveCount(0);
 await page.getByRole("button",{name:"Refresh unit details",exact:true}).click();await expect(page.getByTestId("unit-review-current")).toBeVisible();expect(server.writes).toHaveLength(0);expect(server.cancel).toBe(0);
});
