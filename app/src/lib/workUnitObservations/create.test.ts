import { describe, expect, it } from "vitest";
import { unitCreationObservation } from "./create";
const id="00000000-0000-4000-8000-000000000011", project="00000000-0000-4000-8000-000000000012";
const observation={width:12.25,height:24.5,unit:"ft",source:"estimated",sourceReference:"Field estimate"} as const;
const draft=()=>({id,project_id:project,opening_id:null,revision:0,label:"43",type_label:"Window",facts:{width_in:12,height_in:24,area_source:"Measured",components:[{label:"leaf",quantity:2}],opening_direction:"Left",unknown_fields:["height_in","electrical"]}});
describe("selected-job new unit observation",()=>{
 it("keeps original units and unrelated captured facts while leaving conversion and actor to the server",()=>{
  const original=draft(),result=unitCreationObservation(original,observation);
  expect(result.dimension_observation).toEqual(observation);
  expect(result.expected_fact_revision).toBe(0);
  expect(result.facts).toEqual({components:[{label:"leaf",quantity:2}],opening_direction:"Left",unknown_fields:["height_in","electrical"]});
  expect(result).not.toHaveProperty("observerId");expect(result).not.toHaveProperty("verified");
  original.facts.components[0].quantity=7;expect((result.facts as typeof original.facts).components[0].quantity).toBe(2);
 });
 it("refuses existing revisions, map links, missing job and nonpositive measurements",()=>{
  for(const change of [{revision:1},{opening_id:id},{project_id:null}]) expect(()=>unitCreationObservation({...draft(),...change},observation)).toThrow();
  expect(()=>unitCreationObservation(draft(),{...observation,width:0})).toThrow();
 });
});
