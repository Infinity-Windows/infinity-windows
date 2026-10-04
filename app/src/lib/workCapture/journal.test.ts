// Pure boundary checks only. Native IndexedDB transaction/durability coverage
// lives in e2e/work-capture-journal.spec.ts; happy-dom provides no IndexedDB.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { appendSwitchCommand, recordReceipt, JournalUnavailableError, JournalValidationError,
  type AppendSwitchCommandInput } from "./journal";
const uuid = (n:number) => `00000000-0000-4000-8000-${String(n).padStart(12,"0")}`;
const input = ():AppendSwitchCommandInput => ({
  requestId:uuid(1),ownerId:uuid(2),deviceId:uuid(3),expectedRevision:0,
  shiftRef:"shift:1",tapAt:"2026-10-03T12:00:00.000Z",observedServerEvidence:"snapshot:1",
  intent:{scope:"general",projectRef:"project:1",activityRef:"activity-version:1",menuRevision:"menu-version:1",unitRef:null},
});
const open = vi.fn();
const factory = {open} as unknown as IDBFactory;
beforeEach(()=>{open.mockReset();open.mockImplementation(()=>{throw new Error("No durable storage");});});
async function invalid(value:unknown){
  await expect(appendSwitchCommand(value as AppendSwitchCommandInput,{factory})).rejects.toBeInstanceOf(JournalValidationError);
  expect(open).not.toHaveBeenCalled();
}
describe("capture journal boundary",()=>{
  it("surfaces unavailable storage with no pretend durable fallback",async()=>{
    await expect(appendSwitchCommand(input(),{factory})).rejects.toBeInstanceOf(JournalUnavailableError);
    expect(open).toHaveBeenCalledOnce();
  });
  it.each(["ownerId","deviceId","requestId"])("refuses an invalid %s before storage",async key=>{
    await invalid({...input(),[key]:"not-a-uuid"});
  });
  it.each([-1,0.5,Infinity,Number.MAX_SAFE_INTEGER+1])("refuses unsafe expected revision %s",async revision=>{
    await invalid({...input(),expectedRevision:revision});
  });
  it.each(["2026-02-30T12:00:00Z","2026-10-03","not a time","2026-10-03T24:00:00Z"])("refuses invalid or ambiguous tap time %s",async tapAt=>{
    await invalid({...input(),tapAt});
  });
  it("refuses implicit General attribution to a selected unit",async()=>{
    const c=input();await invalid({...c,intent:{...c.intent,unitRef:"unit:1"}});
  });
  it("does not persist unknown credential-like fields",async()=>{
    const c=input();await invalid({...c,intent:{...c.intent,access_token:"synthetic-not-a-secret"}});
  });
  it("does not execute caller-defined JSON serializers",async()=>{
    const c=input();const serializer=vi.fn(()=>({scope:"general"}));
    await invalid({...c,intent:{...c.intent,toJSON:serializer}});
    expect(serializer).not.toHaveBeenCalled();
  });
  it("refuses custom class instances and cycles",async()=>{
    class CustomIntent { scope="general";projectRef="project:1";activityRef="a";menuRevision="m";unitRef=null; }
    await invalid({...input(),intent:new CustomIntent()});
    const c:Record<string,unknown>={...input()};c.intent=c;await invalid(c);
  });
  it("refuses nonfinite dimensions before storage",async()=>{
    await invalid({...input(),intent:{scope:"specific",projectRef:"p",activityRef:"a",menuRevision:"m",unitRef:"u",dimensionFact:{factRevision:"f",widthIn:NaN,heightIn:40}}});
  });
  it("rejects unsupported General machinery",async()=>{
    const c=input();await invalid({...c,intent:{...c.intent,machineryKind:"scissor_lift"}});
  });
  it("requires bounded nonblank references",async()=>{
    await invalid({...input(),shiftRef:"   "});
    await invalid({...input(),observedServerEvidence:"x".repeat(257)});
  });
  it("refuses undefined/non-JSON fields instead of stripping them",async()=>{
    const c=input();await invalid({...c,intent:{...c.intent,machineryKind:undefined}});
  });
  it("requires genuine bounded confirmation evidence before storage",async()=>{
    await expect(recordReceipt(uuid(2),uuid(3),uuid(1),{status:"confirmed",serverRevision:1},{factory})).rejects.toBeInstanceOf(JournalValidationError);
    await expect(recordReceipt(uuid(2),uuid(3),uuid(1),{status:"sent",serverRevision:1,resultRef:"r"},{factory})).rejects.toBeInstanceOf(JournalValidationError);
    expect(open).not.toHaveBeenCalled();
  });
});
