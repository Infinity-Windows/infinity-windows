// @vitest-environment happy-dom
import { act } from "react";
import { createRoot,type Root } from "react-dom/client";
import { afterEach,beforeEach,describe,expect,it,vi } from "vitest";
import { rememberSignedIn } from "../signedIn";
import type { NativeClockFlow } from "./flow";
import type { ClockPunch } from "../clockPunch";
const m=vi.hoisted(()=>({rows:[] as unknown[],nativeState:"ready",current:{kind:"off",shift:null} as unknown,
  refresh:vi.fn(),cap:vi.fn(),submit:vi.fn(),recover:vi.fn(),capability:{mode:"active",canAuthorSetup:true,setupReason:null,
    canDispatchExistingSetup:true,canReadOwnReceipts:true,canDispatchPayrollSafety:true}}));
vi.mock("./usePaidClockRecords",()=>({usePaidClockRecords:()=>({state:m.nativeState,rows:m.rows,refresh:m.refresh})}));
vi.mock("./useOwnPaidClockCurrent",()=>({useOwnPaidClockCurrent:()=>({state:"ready",value:m.current,refresh:m.refresh})}));
vi.mock("./usePaidClockCapability",()=>({usePaidClockCapability:()=>({state:"ready",value:m.capability,refresh:m.refresh})}));
vi.mock("./capability",()=>({fetchPaidClockCapability:m.cap}));
vi.mock("./coordinator",async original=>({...await original<typeof import("./coordinator")>(),submitPaidClockIntent:m.submit}));
vi.mock("./recovery",()=>({checkSavedPaidClockReceipts:m.recover}));
const {default:Bridge}=await import("./ClockFlowBridge");
const OWNER="00000000-0000-4000-8000-000000000001",CLIENT="00000000-0000-4000-8000-000000000002";
let root:Root,host:HTMLDivElement,flow:NativeClockFlow|null;
const publish=(next:NativeClockFlow|null)=>{flow=next;};
const punch=():ClockPunch=>({clientId:CLIENT,tappedAt:"2026-10-04T09:00:00.123Z",clockCheckedAt:null,clockSkewMs:null});
async function render(releaseAuthorized=true){await act(async()=>root.render(<Bridge profileId={OWNER} legacyReady legacyShift={null} legacyPending={null}
  onFlow={publish} releaseAuthorized={releaseAuthorized}/>));}
beforeEach(()=>{(globalThis as {IS_REACT_ACT_ENVIRONMENT?:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
  rememberSignedIn({user:{id:OWNER}});m.rows=[];m.nativeState="ready";m.current={kind:"off",shift:null};m.refresh.mockReset();
  m.cap.mockReset().mockResolvedValue(m.capability);m.submit.mockReset().mockResolvedValue({kind:"saved",clientId:CLIENT,dispatch:{kind:"held",reason:"unknown"}});
  m.recover.mockReset().mockResolvedValue("checked");host=document.createElement("div");document.body.append(host);root=createRoot(host);flow=null;});
afterEach(()=>{act(()=>root.unmount());host.remove();rememberSignedIn(null);});
describe("existing-flow admission and original tap",()=>{
  it("does not divert an unactivated Classic account when its current shift read beats native storage",async()=>{
    m.current={kind:"open",shift:{id:CLIENT,profile_id:OWNER,status:"open"}};
    m.nativeState="loading";await render(false);
    const intent={action:"break_end" as const,...punch(),shiftRef:{kind:"shift" as const,id:CLIENT}};
    expect(flow?.route).toBe("activation_blocked");expect(flow?.canRequestSafety).toBe(false);
    expect(await flow!.authorSafety(intent)).toMatchObject({kind:"held"});expect(m.submit).not.toHaveBeenCalled();
    m.nativeState="ready";await render(false);expect(flow?.route).toBe("legacy");
    expect(await flow!.authorSafety(intent)).toMatchObject({kind:"held"});expect(m.submit).not.toHaveBeenCalled();
    m.rows=[{intent:{action:"clock_in"},delivery:{status:"acknowledged"}}];await render(false);
    expect(flow?.route).toBe("recovery_only");expect(flow?.canRequestSafety).toBe(true);
    expect(await flow!.authorSafety(intent)).toMatchObject({kind:"saved"});expect(m.submit).toHaveBeenCalledOnce();
  });
  it("refuses a retained safety callback from the previous login even for the same person",async()=>{
    m.current={kind:"open",shift:{id:CLIENT,profile_id:OWNER,status:"open"}};await render();
    const old=flow!;await act(async()=>{rememberSignedIn(null);rememberSignedIn({user:{id:OWNER}});});
    expect(await old.authorSafety({action:"break_end",...punch(),shiftRef:{kind:"shift",id:CLIENT}})).toMatchObject({kind:"held",reason:"account_changed"});
    expect(m.submit).not.toHaveBeenCalled();
  });
  it("defaults to classic only after native admission, with no automatic clock author",async()=>{
    await render(false);expect(flow?.route).toBe("legacy");expect(m.cap).not.toHaveBeenCalled();expect(m.submit).not.toHaveBeenCalled();
    m.nativeState="unavailable";await render(false);expect(flow?.canStartDay).toBe(false);expect(flow?.route).toBe("activation_blocked");
  });
  it("freezes the original tap before fresh capability and holds a competing start in the same login",async()=>{
    await render();let resolve!:(v:unknown)=>void;m.cap.mockImplementationOnce(()=>new Promise(done=>{resolve=done;}));
    const original=punch(),first=flow!.authorStart(original);
    original.tappedAt="2026-10-04T09:30:00.000Z";
    expect(await flow!.authorStart({...punch(),clientId:OWNER})).toMatchObject({kind:"held",clientId:OWNER});
    expect(m.submit).not.toHaveBeenCalled();resolve(m.capability);await first;
    expect(m.submit).toHaveBeenCalledOnce();expect(m.submit.mock.calls[0][1]).toMatchObject({clientId:CLIENT,tappedAt:punch().tappedAt,
      projectId:null,costCodeId:null,photo:null,lat:null,lng:null,note:null,setupVersion:1});
  });
  it("holds missing capability and late ABA without writing a replacement or invoking another author",async()=>{
    await render();m.cap.mockRejectedValueOnce(Error("missing RPC"));expect(await flow!.authorStart(punch())).toMatchObject({kind:"held"});
    let resolve!:(v:unknown)=>void;m.cap.mockImplementationOnce(()=>new Promise(done=>{resolve=done;}));
    const old=flow!,pending=old.authorStart(punch());await act(async()=>{rememberSignedIn(null);rememberSignedIn({user:{id:OWNER}});});
    resolve(m.capability);await pending;expect(m.submit).not.toHaveBeenCalled();
    const count=m.cap.mock.calls.length;await old.authorStart(punch());expect(m.cap).toHaveBeenCalledTimes(count);
  });
  it("coalesces foreground recovery while busy and never treats queue notifications as renewed send permission",async()=>{
    let resolve!:(v:unknown)=>void;m.recover.mockImplementationOnce(()=>new Promise(done=>{resolve=done;}));await render();
    await act(async()=>{window.dispatchEvent(new Event("focus"));window.dispatchEvent(new Event("online"));
      window.dispatchEvent(new Event("forge:paid-clock-chain"));});expect(m.recover).toHaveBeenCalledOnce();
    await act(async()=>resolve("checked"));expect(m.submit).not.toHaveBeenCalled();
    await act(async()=>window.dispatchEvent(new Event("focus")));expect(m.recover).toHaveBeenCalledTimes(2);
  });
});
