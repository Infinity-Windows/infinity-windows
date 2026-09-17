import {expect,test,type Page} from "@playwright/test";
import {useSupabaseFixtures as installFixtures,TEST_USER} from "./support/supabaseFixtures";
import {hideWrongProjectBanner,json} from "./support/specHelpers";
const person="aaaaaaaa-aaaa-4aaa-8aaa-000000000021";
async function setup(page:Page,role:"owner"|"foreman"="owner",payGrant=false) {
 await installFixtures(page,{role});await hideWrongProjectBanner(page);
 const profiles=[{id:TEST_USER.id,display_name:"Manager",role,can_see_pay:payGrant},{id:person,display_name:"Installer Alex",role:"installer"}].map(p=>({active:true,skill_level:3,language:"en",retired_at:null,...p}));
 let rates=[{id:"rate-old",profile_id:person,hourly_cents:3000,pay_basis:"hourly",monthly_cents:null as number|null,effective_from:"2026-08-01",set_by:TEST_USER.id,created_at:"2026-08-01T00:00:00Z"}];
 const saves:Record<string,unknown>[]=[];
 await page.route("**/rest/v1/profiles**",r=>{const target=new URL(r.request().url()).searchParams.get("id")?.slice(3);return json(r,target?profiles.find(p=>p.id===target):profiles,profiles.length);});
 await page.route("**/rest/v1/pay_rates**",r=>json(r,rates,rates.length));
 await page.route("**/rest/v1/rpc/set_compensation",r=>{const body=r.request().postDataJSON();saves.push(body);rates=[{id:"rate-new",profile_id:person,hourly_cents:body.p_pay_basis==="hourly"?body.p_amount_cents:0,pay_basis:body.p_pay_basis,monthly_cents:body.p_pay_basis==="salary_monthly"?body.p_amount_cents:null,effective_from:body.p_effective_from,set_by:TEST_USER.id,created_at:new Date().toISOString()},...rates];return json(r,rates[0]);});
 await page.goto("/crew");
 return {saves,panel:page.getByRole("region",{name:"Pay for Installer Alex"})};
}
for(const width of [390,1280])test(`owner switches to salary, reviews months and keeps hourly history at ${width}px`,async({page})=>{
 await page.setViewportSize({width,height:900});const {saves,panel}=await setup(page);
 await page.getByLabel("Pay month",{exact:true}).fill("2026-09");
 await panel.getByRole("button",{name:"Set pay",exact:true}).click();
 await panel.getByLabel("Pay type",{exact:true}).selectOption("salary_monthly");
 await panel.getByLabel("Monthly salary ($)",{exact:true}).fill("5,000.00");
 await panel.getByLabel("Starting month",{exact:true}).fill("2026-09");
 await panel.screenshot({path:`e2e/test-results/monthly-salary-${width}.png`});
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
 await panel.getByRole("button",{name:"Save pay",exact:true}).click();
 await expect(panel.getByText("$5000.00/month · Salary",{exact:true}).first()).toBeVisible();
 expect(saves).toEqual([{p_profile_id:person,p_pay_basis:"salary_monthly",p_amount_cents:500000,p_effective_from:"2026-09-01"}]);
 await expect(page.getByRole("region",{name:"Monthly salary summary"}).getByText("$5000.00",{exact:true})).toBeVisible();
 await page.getByLabel("Pay month",{exact:true}).fill("2026-08");
 await expect(panel.getByText("$30.00/hr · Hourly",{exact:true}).first()).toBeVisible();
 await page.getByLabel("Pay month",{exact:true}).fill("2026-10");
 await expect(panel.getByText("$5000.00/month · Salary",{exact:true}).first()).toBeVisible();
 await panel.getByText("Pay history",{exact:true}).click();await expect(panel.getByText("2026-08-01",{exact:true})).toBeVisible();
});
test("foreman without the pay grant sees no salary or pay controls",async({page})=>{
 await setup(page,"foreman");await expect(page.getByRole("heading",{name:"Roster",exact:true,level:1})).toBeVisible();
 await expect(page.getByRole("region",{name:"Monthly salary summary"})).toHaveCount(0);await expect(page.getByRole("button",{name:"Set pay",exact:true})).toHaveCount(0);
});
test("a pay reader can review but cannot change compensation",async({page})=>{
 const {panel}=await setup(page,"foreman",true);await expect(panel).toBeVisible();
 await expect(panel.getByRole("button",{name:"Set pay",exact:true})).toHaveCount(0);
});
test("a refused save leaves the entered salary available to correct",async({page})=>{
 const {panel}=await setup(page);await page.route("**/rest/v1/rpc/set_compensation",r=>r.fulfill({status:400,contentType:"application/json",body:JSON.stringify({message:"Salary changes must start on the first day of a month."})}));
 await panel.getByRole("button",{name:"Set pay",exact:true}).click();await panel.getByLabel("Pay type",{exact:true}).selectOption("salary_monthly");
 await panel.getByLabel("Monthly salary ($)",{exact:true}).fill("5000");await panel.getByRole("button",{name:"Save pay",exact:true}).click();
 await expect(panel.getByRole("alert")).toBeVisible();await expect(panel.getByLabel("Monthly salary ($)",{exact:true})).toHaveValue("5000");
});
