import {describe,it,expect,vi} from "vitest";
vi.mock("./supabase",()=>({supabase:{}}));
import {computeLabor,type LaborShift} from "./costing";
import {indexPayRates,rateInEffect,salaryForMonth,formatCompensation,payReviewDay,type PayRate} from "./payRates";
const salary=(month:string,cents=500000):PayRate=>({id:month,profileId:"person",hourlyCents:0,payBasis:"salary_monthly",monthlyCents:cents,effectiveFrom:`${month}-01`,setBy:null,createdAt:""});
const hourly:PayRate={...salary("2026-08"),payBasis:"hourly",monthlyCents:null,hourlyCents:3000};
const shift=(job:string|null,day:number,hours:number,month=8):LaborShift=>({project_id:job,profile_id:"person",role:"installer",clock_in_at:new Date(2026,month,day,7).toISOString(),clock_out_at:new Date(2026,month,day,7+hours).toISOString(),break_seconds:0});
describe("calendar-month salary",()=>{
 it("shows a current mid-month hourly raise without prematurely showing a future raise",()=>{
  const rates=indexPayRates([hourly,{...hourly,id:"raise",hourlyCents:3500,effectiveFrom:"2026-09-16"},{...hourly,id:"future",hourlyCents:4000,effectiveFrom:"2026-09-25"}]).get("person");
  expect(rateInEffect(rates,payReviewDay("2026-09","2026-09-16"))?.hourlyCents).toBe(3500);
  expect(payReviewDay("2026-08","2026-09-16")).toBe("2026-08-31");
  expect(payReviewDay("2028-02","2026-09-16")).toBe("2028-02-29");
 });
 it("carries the monthly amount forward and preserves earlier hourly pay",()=>{
  const rates=indexPayRates([hourly,salary("2026-09"),salary("2026-11",600000)]).get("person");
  expect(rateInEffect(rates,"2026-08-31")?.hourlyCents).toBe(3000);
  expect(salaryForMonth(rates,"2026-08")).toBeNull();
  expect(salaryForMonth(rates,"2026-09")).toBe(500000);
  expect(salaryForMonth(rates,"2026-10")).toBe(500000);
  expect(salaryForMonth(rates,"2026-11")).toBe(600000);
  expect(salaryForMonth(rates,"2026-13")).toBeNull();
  expect(formatCompensation(salary("2026-09"))).toBe("$5000.00/month · Salary");
 });
 it("allocates one monthly amount across jobs, retaining the unassigned share",()=>{
  const result=computeLabor([shift("a",1,6),shift("b",2,2),shift(null,3,2)],indexPayRates([salary("2026-09")]));
  expect(result.get("a")?.cost).toBeCloseTo(3000);expect(result.get("b")?.cost).toBeCloseTo(1000);
  expect(result.get("a")?.hours).toBe(6);expect(result.get("a")?.people[0].salaryAllocated).toBe(true);
 });
 it("keeps months separate, honors raises, and excludes removed/open punches",()=>{
  const result=computeLabor([shift("a",1,8),shift("a",1,8,9),{...shift("b",2,8),status:"voided"},{...shift("b",3,8),clock_out_at:null}],indexPayRates([salary("2026-09"),salary("2026-10",600000)]));
  expect(result.get("a")?.cost).toBe(11000);expect(result.has("b")).toBe(false);
 });
 it("splits an overnight shift at the month and pay-type boundary",()=>{
  const result=computeLabor([{...shift("a",1,2),clock_in_at:new Date(2026,7,31,23).toISOString(),clock_out_at:new Date(2026,8,1,1).toISOString()}],indexPayRates([hourly,salary("2026-09")]));
  expect(result.get("a")?.hours).toBe(2);expect(result.get("a")?.cost).toBe(5030);
 });
 it("allocates by hours after breaks and does not assign salary to a zero-hour punch",()=>{
  const result=computeLabor([{...shift("a",1,8),break_seconds:3600},shift("b",2,7),{...shift("c",3,1),break_seconds:3600}],indexPayRates([salary("2026-09")]));
  expect(result.get("a")?.cost).toBe(2500);expect(result.get("b")?.cost).toBe(2500);expect(result.get("c")?.cost).toBe(0);
 });
});
