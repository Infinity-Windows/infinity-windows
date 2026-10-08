import { expect, test, type Page } from "@playwright/test";
import {useSupabaseFixtures as replaySupabaseFixtures} from "./support/supabaseFixtures";
import {json} from "./support/specHelpers";
const ID="dddddddd-4444-4444-8444-dddddddddddd";
async function replayLocationFixture(page:Page,role:"foreman"|"installer"="foreman",over:Record<string,unknown>={},language:"en"|"es"="en"){
 await replaySupabaseFixtures(page,{role,language});
 const state={row:{id:ID,job_code:"LOCATION",name:"Location job",address:null,latitude:null,longitude:null,status:"active",is_test:false,allowed_modes:["data"],project_pipeline:{ready_state:"ready"},...over},calls:[] as Record<string,unknown>[]};
 await page.route("**/rest/v1/projects**",r=>json(r,[state.row],1));
 await page.route("**/rest/v1/rpc/set_project_location",async r=>{const body=r.request().postDataJSON();state.calls.push(body);Object.assign(state.row,{address:body.p_address,latitude:body.p_latitude,longitude:body.p_longitude});await json(r,null);});
 await page.goto(`/projects/${ID}`);
 await expect(page.getByRole("heading",{name:/Job location|Ubicación del trabajo/,exact:true})).toBeVisible();return state;
}
function card(page:Page){return page.locator("section.job-location");}
async function contained(page:Page){expect(await page.evaluate(()=>document.documentElement.scrollWidth-document.documentElement.clientWidth)).toBeLessThanOrEqual(1);expect(await page.evaluate(()=>window.scrollX)).toBe(0);}
test("phone saves address, then exact GPS pin, and both survive reload",async({page},testInfo)=>{
 await page.setViewportSize({width:390,height:844});const state=await replayLocationFixture(page);
 await card(page).getByRole("button",{name:"Add location",exact:true}).click();
 await card(page).getByLabel("Address",{exact:true}).fill("  1 Main Street  ");
 await card(page).getByRole("button",{name:"Save location",exact:true}).press("Enter");
 await expect(card(page).getByText("1 Main Street",{exact:true})).toBeVisible();expect(state.calls[0]).toMatchObject({p_address:"1 Main Street",p_latitude:null,p_longitude:null});
 await card(page).getByRole("button",{name:"Edit location",exact:true}).click();
 await card(page).getByLabel("GPS coordinates",{exact:true}).fill("37.123456789, -113.987654321");
 await card(page).getByLabel("GPS coordinates",{exact:true}).press("Enter");
 await expect(card(page).getByText("Directions go to the GPS point.", {exact:true})).toBeVisible();
 expect(state.calls[1]).toMatchObject({p_expected_address:"1 Main Street",p_expected_latitude:null,p_latitude:37.123456789,p_longitude:-113.987654321});
 await page.reload();await expect(card(page).getByText("37.123456789, -113.987654321",{exact:true})).toBeVisible();await contained(page);
 await card(page).scrollIntoViewIfNeeded();await page.screenshot({path:testInfo.outputPath("fixture-phone.png")});
});
test("bad GPS keeps draft and makes no save request; deliberate clear removes both",async({page})=>{
 const state=await replayLocationFixture(page,"foreman",{address:"Old",latitude:0,longitude:0});await card(page).getByRole("button",{name:"Edit location",exact:true}).click();await card(page).getByLabel("GPS coordinates",{exact:true}).fill("91, 0");await card(page).getByRole("button",{name:"Save location",exact:true}).click();await expect(card(page).getByRole("alert")).toContainText("Latitude must be between");expect(state.calls).toHaveLength(0);await expect(card(page).getByLabel("GPS coordinates",{exact:true})).toHaveValue("91, 0");await card(page).getByRole("button",{name:"Clear both",exact:true}).click();await card(page).getByRole("button",{name:"Save location",exact:true}).click();await expect(card(page).getByText("No location saved for this job yet.")).toBeVisible();expect(state.calls[0]).toMatchObject({p_address:null,p_latitude:null,p_longitude:null});
});
test("installer gets GPS-only directions at zero but cannot edit",async({page})=>{
 await replayLocationFixture(page,"installer",{latitude:0,longitude:0});await expect(card(page).getByText("0, 0",{exact:true})).toBeVisible();await expect(card(page).getByRole("button",{name:/Add location|Edit location/})).toHaveCount(0);await card(page).getByRole("button",{name:/Get directions/}).click();await expect(page.getByRole("dialog",{name:"Get directions to the job"})).toBeVisible();await expect(page.getByRole("button",{name:"Copy coordinates",exact:true})).toBeVisible();
});
test("Spanish phone keeps manual location fields readable",async({page})=>{
 await page.setViewportSize({width:375,height:812});await replayLocationFixture(page,"foreman",{},"es");await card(page).getByRole("button",{name:"Agregar ubicación",exact:true}).click();await expect(card(page).getByLabel("Coordenadas GPS",{exact:true})).toBeVisible();await card(page).getByLabel("Dirección",{exact:true}).fill("Dirección larga ".repeat(25));await contained(page);
});
test("desktop wraps long saved address without sideways scrolling",async({page},testInfo)=>{
 await page.setViewportSize({width:1280,height:900});await replayLocationFixture(page,"foreman",{address:"VeryLongJobAddress".repeat(50),latitude:90,longitude:-180});await expect(card(page).getByRole("button",{name:"Edit location",exact:true})).toBeVisible();await contained(page);await card(page).scrollIntoViewIfNeeded();await page.screenshot({path:testInfo.outputPath("fixture-desktop.png")});
});

test("tiny stored point roundtrips through an unchanged editor",async({page})=>{
 const state=await replayLocationFixture(page,"foreman",{latitude:0.0000001,longitude:-0.0000001});
 await card(page).getByRole("button",{name:"Edit location",exact:true}).click();
 await card(page).getByRole("button",{name:"Save location",exact:true}).click();
 await expect(card(page).getByRole("button",{name:"Edit location",exact:true})).toBeVisible();
 expect(state.calls[0]).toMatchObject({p_latitude:0.0000001,p_longitude:-0.0000001,p_expected_latitude:0.0000001});
});
