import { describe,expect,it } from "vitest";
import corpus from "./__fixtures__/sourceMatchedWire.json";
import { parseTotalsReply } from "./protocol";
import { durationMicros,quantitySeconds,trustedUnitRate,choiceTotals,personalScopeSeconds,scopeTotalSeconds } from "./format";
describe("exact totals presentation",()=>{
 it("formats large/signed time without Number rounding",()=>{expect(durationMicros("9007199254740993000000")).toBe("2501999792983:36:33");expect(durationMicros("-60000000")).toBe("−0:01:00");});
 it("holds partial and oversized tile values instead of inventing zero",()=>{expect(quantitySeconds({state:"partial",microseconds:null,knownMicros:"9000000"})).toBeNull();expect(quantitySeconds({state:"known",microseconds:"9007199254740993000000",knownMicros:"9007199254740993000000"})).toBeNull();});
 it("the Your time header uses personal time rather than coworker scope time",()=>{
  const raw=corpus.calls.find(c=>c.result.totals?.complete&&c.result.totals.unitId===null&&c.result.totals.personalKnownMicros!==c.result.totals.scopeKnownMicros)!.result,t=raw.totals!;
  const parsed=parseTotalsReply(raw,t.projectId,null,t.actorId);if(parsed.availability!=="available")throw Error("Fixture unavailable");
  expect(personalScopeSeconds(parsed.totals,0n)).toBe(Number(BigInt(t.personalKnownMicros)/1000000n));
  expect(personalScopeSeconds(parsed.totals,0n)).not.toBe(scopeTotalSeconds(parsed.totals,0n));
 });
 it("rates use the exact same eligible unit labor/area, with no live-display estimate",()=>{
  const raw=corpus.calls.find(c=>c.result.totals?.cohort?.eligible===true)!.result,t=raw.totals!;const parsed=parseTotalsReply(raw,t.projectId,t.unitId,t.actorId);if(parsed.availability!=="available")throw Error("Fixture unavailable");
  const c=parsed.totals.cohort;if(c.availability!=="available")throw Error("Fixture cohort unavailable");
  expect(trustedUnitRate({...c,laborNumeratorMicros:"3600000000",areaSquareFeetNumerator:"12",areaSquareFeetDenominator:"1"})).toEqual({squareFeet:"12.00",hoursPer100SquareFeet:"8.33"});
  expect(trustedUnitRate({...c,eligible:false})).toBeNull();expect(choiceTotals(parsed.totals,"00000000-0000-4000-8000-000000000099",0n)).toEqual({personalSeconds:null,scopeTotalSeconds:null});
 });
});
