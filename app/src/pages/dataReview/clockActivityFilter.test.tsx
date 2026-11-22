// @vitest-environment happy-dom
import {act,useState} from "react";
import {createRoot} from "react-dom/client";
import {expect,it} from "vitest";
import {JobsTable} from "./JobsTable";
import type {TimeShift} from "../../lib/timeclock";
it("keeps excluded activities inspectable while updating job totals",async()=>{
 Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});
 const host=document.createElement("div"),root=createRoot(host);document.body.append(host);
 const records=[{id:"a",cost_code_id:"install",cost_codes:{label:"Installation"},clock_out_at:"2026-10-01T11:00:00Z"},{id:"b",cost_code_id:"office",cost_codes:{label:"Office"},clock_out_at:"2026-10-01T12:00:00Z"}].map(row=>({...row,project_id:"j",profile_id:"p",clock_in_at:"2026-10-01T10:00:00Z",break_seconds:0,status:"submitted"})) as TimeShift[];
 function Harness(){const [excluded,setExcluded]=useState<string[]>([]);return <JobsTable jobs={["j"]} records={records} names={new Map([["j","Job"]])} statuses={new Map()} selected={[]} onSelect={()=>{}} excludedCodes={excluded} onExcludedCodes={setExcluded}/>;}
 try{
  await act(async()=>root.render(<Harness/>));
  expect(host.querySelector('[aria-label="Clocked activities"]')).not.toBeNull();
  await act(async()=>host.querySelector<HTMLButtonElement>('[aria-label="Exclude Office in clocked totals"]')!.click());
  expect(host.querySelector('tbody[data-excluded=true]')?.textContent).toContain("Office");
  await act(async()=>host.querySelector<HTMLButtonElement>('[aria-label="Clock records for Office"]')!.click());
  expect(host.querySelector('tbody[data-excluded=true] table')).not.toBeNull();
  await act(async()=>host.querySelector<HTMLButtonElement>('[title="Switch to jobs"]')!.click());
  expect(host.querySelector(".job-total-hours")?.textContent).toBe("1.00 h");
 }finally{await act(async()=>root.unmount());host.remove();}
});
