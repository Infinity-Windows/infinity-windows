import { describe, expect, it } from "vitest";
import corpus from "./__fixtures__/sourceMatchedWire.json";
import { parseTotalsReply, TotalsUnavailableError, type TotalsView, type TotalsCohort } from "./protocol";
type AvailableFixture={protocolVersion:1;availability:"available";totals:TotalsView&{cohort:Extract<TotalsCohort,{availability:"available"}>}};
const base=()=>structuredClone(corpus.calls.find(call=>call.result.totals?.cohort?.eligible===true)!.result) as AvailableFixture;
function parse(raw:ReturnType<typeof base>){const t=raw.totals!;return parseTotalsReply(raw,t.projectId,t.unitId,t.actorId);}
describe("totals exact quantities and trust boundary",()=>{
 it("does not mutate input and never turns partial quantities into zero",()=>{
  const raw=structuredClone(corpus.calls.find(call=>call.result.totals?.complete===false&&call.result.totals.activities.length>0)!.result) as AvailableFixture;
  const before=JSON.stringify(raw);const parsed=parse(raw);expect(JSON.stringify(raw)).toBe(before);
  expect(parsed.availability).toBe("available");if(parsed.availability==="available"){expect(parsed.totals.complete).toBe(false);expect(parsed.totals.activities[0].scopeTotal.microseconds).toBeNull();}
 });
 it.each(["wrong actor","wrong job","wrong unit","wrong window","missing privacy scope","personal eligible cohort","wrong sum","duplicate version","machine double count","floor allocation","area mismatch","excluded labor","claimed full partial"])("rejects %s",kind=>{
  const raw=base(),t=raw.totals!;const actor=t.actorId,job=t.projectId,unit=t.unitId;
  if(kind==="wrong actor")t.actorId=t.projectId;
  if(kind==="wrong job")t.projectId=t.actorId;
  if(kind==="wrong unit")t.unitId=t.projectId;
  if(kind==="wrong window")t.window.until="2026-01-01T00:00:00.000000Z";
  if(kind==="missing privacy scope")delete (t.reconciliation as unknown as Record<string,unknown>).scope;
  if(kind==="personal eligible cohort")t.reconciliation.scope="personal";
  if(kind==="wrong sum")t.scopeKnownMicros="1";
  if(kind==="duplicate version")t.activities.push(structuredClone(t.activities[0]));
  if(kind==="machine double count")t.activities[0].machineSubsets=[{machineKind:"forklift",microseconds:(BigInt(t.activities[0].scopeTotal.knownMicros)+1n).toString()}];
  if(kind==="floor allocation")(t.cohort.floor as Record<string,unknown>).state="allocated";
  if(kind==="area mismatch")t.cohort.areaSquareFeetNumerator="0";
  if(kind==="excluded labor")t.cohort.excludedLaborMicros="1";
  if(kind==="claimed full partial")t.activities[0].scopeTotal.microseconds=null;
  expect(()=>parseTotalsReply(raw,job,unit,actor)).toThrow(TotalsUnavailableError);
 });
 it("keeps microseconds beyond numeric precision exact",()=>{
  const raw=base(),t=raw.totals!,n="9007199254740993000000";t.activities=[t.activities[0]];
  Object.assign(t.activities[0].personal,{state:"known",microseconds:n,knownMicros:n});Object.assign(t.activities[0].scopeTotal,{state:"known",microseconds:n,knownMicros:n});t.activities[0].machineSubsets=[];
  t.scopeKnownMicros=n;t.personalKnownMicros=n;Object.assign(t.reconciliation,{scope:"authorized_scope",grossMicros:n,payrollMicros:n,classifiedMicros:n,setupMicros:"0",unclassifiedMicros:"0",breakElapsedMicros:"0",breakDeductionMicros:"0",policyAdjustmentMicros:"0"});
  Object.assign(t.cohort,{actualLaborMicros:n,excludedLaborMicros:"0",laborNumeratorMicros:n});expect(parse(raw)).toEqual(raw);
 });
 it("rejects accessors without invoking them",()=>{
  const raw=base();const getter=()=>{throw Error("must not invoke");};Object.defineProperty(raw,"availability",{get:getter,enumerable:true});expect(()=>parse(raw)).toThrow(TotalsUnavailableError);
 });
 it("rejects two simultaneous personal live rows before adding display estimates",()=>{
  const raw=structuredClone(corpus.calls[0].result) as {protocolVersion:1;availability:"available";totals:TotalsView},t=raw.totals;
  const second=structuredClone(t.activities[0]);second.definitionVersionId="00000000-0000-4000-8000-000000250099";
  t.activities.push(second);t.scopeKnownMicros=(BigInt(t.scopeKnownMicros)*2n).toString();t.personalKnownMicros=(BigInt(t.personalKnownMicros)*2n).toString();
  expect(()=>parseTotalsReply(raw,t.projectId,t.unitId,t.actorId)).toThrow(TotalsUnavailableError);
 });
});
