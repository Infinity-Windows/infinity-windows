// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rememberSignedIn, signInMark } from "../signedIn";
import { ClockProtocolError, parseClockIntent, type ClockReceipt } from "./protocol";
import type { PaidClockRecord } from "./storage";

const mocks=vi.hoisted(()=>({ read:vi.fn(),send:vi.fn(),records:vi.fn(),update:vi.fn() }));
vi.mock("./api",()=>({
  ClockRequestRefusedError:class ClockRequestRefusedError extends Error { code:string; constructor(code:string){super("refused");this.code=code;} },
  readPaidClockReceipt:(...args:unknown[])=>mocks.read(...args),
  sendPaidClockIntent:(...args:unknown[])=>mocks.send(...args),
}));
vi.mock("./storage",()=>({
  readPaidClockRecords:(...args:unknown[])=>mocks.records(...args),
  updatePaidClockDelivery:(...args:unknown[])=>mocks.update(...args),
}));
const {dispatchPaidClockRequest}=await import("./dispatch");
const {ClockRequestRefusedError}=await import("./api");
const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,"0")}`;
const OWNER=id(1),CLIENT=id(2),SHIFT=id(3),DEVICE=id(4),GEN=id(5),PREVIOUS=id(6);
const stamp="2026-10-04T08:30:00.123456-06:00";
const intent=()=>parseClockIntent({action:"clock_in",clientId:CLIENT,tappedAt:stamp,clockCheckedAt:null,clockSkewMs:null,
  projectId:null,costCodeId:null,photo:null,lat:null,lng:null,note:null,mode:null,setupVersion:1});
const breakIntent=()=>parseClockIntent({action:"break_end",clientId:CLIENT,tappedAt:stamp,clockCheckedAt:null,clockSkewMs:null,shiftRef:{kind:"shift",id:SHIFT}});
const readUnavailable={protocolVersion:1 as const,availability:"unavailable" as const,receipt:null};
const accepted=(action:ClockReceipt["action"]="clock_in",outcome:ClockReceipt["outcome"]="clocked_in"):ClockReceipt=>({
  clientId:CLIENT,action,outcome,shiftId:SHIFT,tappedAt:"2026-10-04T14:30:00.123456Z",arrivedAt:"2026-10-04T14:30:01.000001Z",clockCheckedAt:null,clockSkewMs:null,
  usedTapTime:false,reviewReason:null,receiptProtocol:"setup_v1",retention:"retained",sourcePresent:true,activityTransition:null,
});
const makeRow=(change:Partial<PaidClockRecord>={}):PaidClockRecord=>({version:1,clientId:CLIENT,ownerId:OWNER,deviceId:DEVICE,storageGeneration:GEN,
  sequence:0,origin:{kind:"clock_command",id:CLIENT},predecessorClientId:null,intent:intent(),
  delivery:{status:"queued",attemptToken:null,everAttempted:false,everUncertain:false,resolvedShiftId:null,receipt:null,attentionReason:null},...change});
let rows:PaidClockRecord[],held=false,log:string[]=[];
const locks={request:vi.fn(async (_key:string,options:{ifAvailable:boolean},callback:(lock:object|null)=>Promise<unknown>)=>{
  expect(options).toEqual({ifAvailable:true});if(held)return callback(null);
  held=true;try{return await callback({});}finally{held=false;}
})};
beforeEach(()=>{
  rememberSignedIn({user:{id:OWNER}});Object.defineProperty(navigator,"onLine",{configurable:true,value:true});Object.defineProperty(navigator,"locks",{configurable:true,value:locks});
  rows=[makeRow()];held=false;log=[];locks.request.mockClear();mocks.read.mockReset().mockResolvedValue(readUnavailable);mocks.send.mockReset().mockResolvedValue(undefined);
  mocks.records.mockReset().mockImplementation(async()=>rows);
  mocks.update.mockReset().mockImplementation(async (_login,clientId:string,expected:string|null,change:(record:PaidClockRecord)=>PaidClockRecord["delivery"])=>{
    const index=rows.findIndex(row=>row.clientId===clientId);if(index<0||rows[index].delivery.attemptToken!==expected)throw Error("CAS");
    const current=rows[index];rows[index]={...current,delivery:change(current)};log.push(rows[index].delivery.status);return rows[index];
  });
});
afterEach(()=>{rememberSignedIn(null);delete (navigator as unknown as {locks?:unknown}).locks;});

describe("isolated paid clock dispatch",()=>{
  it("durably marks the exact intent sending before the RPC and acknowledges only its receipt",async()=>{
    mocks.send.mockImplementation(async()=>{expect(rows[0].delivery.status).toBe("sending");expect(rows[0].delivery.everAttempted).toBe(true);expect(rows[0].intent.clientId).toBe(CLIENT);log.push("rpc");});
    mocks.read.mockResolvedValue({protocolVersion:1,availability:"available",receipt:accepted()});
    const result=await dispatchPaidClockRequest(CLIENT,signInMark(),"first_attempt");
    expect(result.kind).toBe("settled");expect(log).toEqual(["sending","rpc","acknowledged"]);
    expect(rows[0].delivery.receipt?.shiftId).toBe(SHIFT);expect(mocks.send).toHaveBeenCalledTimes(1);
  });
  it("does not automatically resend an unknown attempt",async()=>{
    mocks.send.mockRejectedValueOnce(Error("lost reply"));
    expect(await dispatchPaidClockRequest(CLIENT,signInMark(),"first_attempt")).toEqual({kind:"held",reason:"unknown"});
    expect(rows[0].delivery.status).toBe("uncertain");
    expect(await dispatchPaidClockRequest(CLIENT,signInMark(),"first_attempt")).toEqual({kind:"held",reason:"unknown"});
    expect(mocks.send).toHaveBeenCalledTimes(1);expect(rows[0].delivery.everUncertain).toBe(true);
  });
  it("keeps prior uncertainty after a later SQL refusal until a matching receipt arrives",async()=>{
    mocks.send.mockRejectedValueOnce(Error("lost reply"));await dispatchPaidClockRequest(CLIENT,signInMark(),"first_attempt");
    mocks.send.mockRejectedValueOnce(new ClockRequestRefusedError("42501"));
    expect(await dispatchPaidClockRequest(CLIENT,signInMark(),"retry_original")).toEqual({kind:"held",reason:"unknown"});
    expect(rows[0].delivery.status).toBe("uncertain");expect(rows[0].delivery.everUncertain).toBe(true);
    mocks.read.mockResolvedValue({protocolVersion:1,availability:"available",receipt:accepted()});
    expect((await dispatchPaidClockRequest(CLIENT,signInMark(),"check_only")).kind).toBe("settled");
    expect(rows[0].delivery.status).toBe("acknowledged");expect(mocks.send).toHaveBeenCalledTimes(2);
  });
  it("places a definitive first-attempt refusal in attention",async()=>{
    mocks.send.mockRejectedValueOnce(new ClockRequestRefusedError("42501"));
    expect(await dispatchPaidClockRequest(CLIENT,signInMark(),"first_attempt")).toEqual({kind:"held",reason:"attention"});
    expect(rows[0].delivery).toMatchObject({status:"attention",attentionReason:"request_refused",everUncertain:false});
  });
  it("does not publish a late reply after same-owner auth ABA",async()=>{
    let resolve!:()=>void;mocks.send.mockImplementationOnce(()=>new Promise<void>(done=>{resolve=done;}));
    const old=signInMark(),operation=dispatchPaidClockRequest(CLIENT,old,"first_attempt");
    await vi.waitFor(()=>expect(rows[0].delivery.status).toBe("sending"));
    rememberSignedIn(null);rememberSignedIn({user:{id:OWNER}});resolve();
    expect(await operation).toEqual({kind:"held",reason:"account_changed"});
    expect(rows[0].delivery.status).toBe("sending");expect(rows[0].delivery.receipt).toBeNull();expect(mocks.read).not.toHaveBeenCalled();
  });
  it("holds an unresolved causal predecessor without touching the network",async()=>{
    const predecessor=makeRow({clientId:PREVIOUS,sequence:0,intent:parseClockIntent({action:"break_start",clientId:PREVIOUS,tappedAt:stamp,clockCheckedAt:null,clockSkewMs:null,shiftRef:{kind:"shift",id:SHIFT},breakType:"lunch"}),
      origin:{kind:"shift",id:SHIFT},delivery:{status:"uncertain",attemptToken:id(8),everAttempted:true,everUncertain:true,resolvedShiftId:SHIFT,receipt:null,attentionReason:null}});
    rows=[predecessor,makeRow({sequence:1,predecessorClientId:PREVIOUS,origin:{kind:"shift",id:SHIFT},intent:breakIntent()})];
    expect(await dispatchPaidClockRequest(CLIENT,signInMark(),"first_attempt")).toEqual({kind:"held",reason:"dependency"});
    expect(mocks.send).not.toHaveBeenCalled();expect(mocks.read).not.toHaveBeenCalled();
  });
  it("does not acknowledge an invalid or foreign receipt",async()=>{
    mocks.read.mockRejectedValue(new ClockProtocolError());
    expect(await dispatchPaidClockRequest(CLIENT,signInMark(),"check_only")).toEqual({kind:"held",reason:"attention"});
    expect(rows[0].delivery).toMatchObject({status:"attention",attentionReason:"receipt_conflict",receipt:null});
    rows=[makeRow({delivery:{status:"uncertain",attemptToken:id(9),everAttempted:true,everUncertain:true,resolvedShiftId:null,receipt:null,attentionReason:null}})];
    expect(await dispatchPaidClockRequest(CLIENT,signInMark(),"check_only")).toEqual({kind:"held",reason:"unknown"});
    expect(rows[0].delivery.receipt).toBeNull();expect(mocks.send).not.toHaveBeenCalled();
  });
  it("uses a current owner lock so parallel sends cannot overlap",async()=>{
    let resolve!:()=>void;mocks.send.mockImplementationOnce(()=>new Promise<void>(done=>{resolve=done;}));
    const mark=signInMark(),first=dispatchPaidClockRequest(CLIENT,mark,"first_attempt");
    await vi.waitFor(()=>expect(rows[0].delivery.status).toBe("sending"));
    expect(await dispatchPaidClockRequest(CLIENT,mark,"retry_original")).toEqual({kind:"held",reason:"dispatcher_busy"});
    expect(mocks.send).toHaveBeenCalledTimes(1);resolve();await first;
    expect(locks.request).toHaveBeenCalledTimes(2);
  });
});
