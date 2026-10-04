import { expect, test, type Page } from "@playwright/test";
import { setupMountedReview, mountedTotalsReply, PROJECT, UNIT } from "./support/mountedUnitReviewFixture";
import { durationMicros } from "../src/lib/workActivityTotals/format";
async function setup(page: Page) {
  const calls: {p_project_id:string;p_unit_id:string|null}[]=[];
  const unexpected=await setupMountedReview(page,async()=>{
    await page.route("**/rest/v1/rpc/work_activity_totals_read",r=>{
      const args=r.request().postDataJSON();calls.push(args);
      return r.fulfill({contentType:"application/json",body:JSON.stringify(mountedTotalsReply(args.p_unit_id))});
    });
    await page.route("**/rest/v1/rpc/work_unit_review_read",r=>r.fulfill({contentType:"application/json",body:JSON.stringify({protocolVersion:1,asOf:"2026-10-04T12:00:00.000000Z",availability:"unavailable",review:null})}));
  });
  return {calls,unexpected};
}
test("real Work mount reads exact General totals once while the clock repaints",async({page})=>{
  const server=await setup(page),panel=page.getByRole("region",{name:"Recorded activity totals"});
  await expect(panel.getByText("All retained work for this selection",{exact:false})).toBeVisible();
  const raw=mountedTotalsReply(null).totals!;
  await expect(panel).toContainText(durationMicros(raw.activities[0].personal.knownMicros));
  expect(server.calls.at(-1)).toEqual({p_project_id:PROJECT,p_unit_id:null});
  const count=server.calls.length;await page.waitForTimeout(2100);expect(server.calls.length).toBe(count);
  expect(server.unexpected).toEqual([]);
});
test("Specific never displays the previous General total and explicit check restores General",async({page})=>{
  const server=await setup(page),panel=page.getByRole("region",{name:"Recorded activity totals"});
  await expect(panel.getByText("Machine time is included in activity time.")).toBeVisible();
  await page.getByRole("tab",{name:"Specific",exact:true}).click();
  await page.getByRole("combobox",{name:"Choose a unit"}).selectOption(UNIT);
  await expect.poll(()=>server.calls.some(c=>c.p_unit_id===UNIT)).toBe(true);
  await expect(panel.getByText("Totals are unavailable. Check the current records.")).toBeVisible();
  await expect(panel.getByText("Machine time is included in activity time.")).toHaveCount(0);
  await page.getByRole("tab",{name:"General",exact:true}).click();
  await panel.getByRole("button",{name:"Check totals",exact:true}).click();
  await expect(panel.getByText("Machine time is included in activity time.")).toBeVisible();
  expect(server.unexpected).toEqual([]);
});
