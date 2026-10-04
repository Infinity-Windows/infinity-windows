// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { rememberSignedIn, signInMark } from "../signedIn";
import type { PaidClockRecord } from "./storage";
import type { ClockFlowInput } from "./flow";
import type { ClockIntent } from "./protocol";
const m=vi.hoisted(()=>({submit:vi.fn(),head:vi.fn(),valid:vi.fn()}));
vi.mock("./storage",()=>({getCurrentLoginCommittedHead:m.head,isCurrentLoginCommittedHead:m.valid}));
vi.mock("./coordinator",()=>({submitPaidClockIntent:m.submit,paidSetupIntent:(p:object)=>({action:"clock_in",...p,setupVersion:1,projectId:null,costCodeId:null})}));
const flow=await import("./flow");
const OWNER="00000000-0000-4000-8000-000000000001",SHIFT="00000000-0000-4000-8000-000000000002";
const source=():ClockFlowInput=>({releaseAuthorized:true,backendReady:true,nativeRead:"ready",records:[],currentRead:"ready",current:{kind:"off",shift:null},legacyReady:true,legacyShift:null,legacyPending:null});
beforeEach(()=>{rememberSignedIn({user:{id:OWNER}});m.head.mockReset().mockReturnValue(null);m.valid.mockReset().mockReturnValue(true);m.submit.mockReset().mockResolvedValue({kind:"saved",clientId:"winning-original",dispatch:{kind:"held",reason:"unknown"}});});
describe("shared clock route",()=>{
  it("uses only an admitted current-login predecessor and preserves its command origin",async()=>{
    const current={kind:"open" as const,shift:{id:SHIFT,profile_id:OWNER,status:"open" as const} as NonNullable<ClockFlowInput["legacyShift"]>};
    const intent={action:"break_end",clientId:"tap",shiftRef:{kind:"shift",id:SHIFT}} as Extract<ClockIntent,{action:"break_end"}>;
    const head={clientId:"original-break",action:"break_start",origin:{kind:"clock_command",id:"original-clock"}};
    m.head.mockReturnValue(head);await flow.authorNativeClockSafety(intent,signInMark(),current);
    expect(m.submit).toHaveBeenCalledWith(signInMark(),{...intent,shiftRef:head.origin},head.clientId);
    m.head.mockReturnValue({...head,action:"break_end"});m.submit.mockClear();
    expect(await flow.authorNativeClockSafety(intent,signInMark(),current)).toMatchObject({kind:"held"});expect(m.submit).not.toHaveBeenCalled();
    m.head.mockReturnValue({...head,action:"clock_out"});expect(await flow.authorNativeClockSafety(intent,signInMark(),current)).toMatchObject({kind:"held"});
    m.valid.mockReturnValue(false);await flow.authorNativeClockSafety(intent,signInMark(),current);
    expect(m.submit).toHaveBeenCalledWith(signInMark(),intent,null);
  });
  it("requires rollout, backend, current shift and native readiness separately",()=>{
    expect(flow.projectClockFlow(source())).toMatchObject({route:"isolated",canStartDay:true});
    for(const change of [{backendReady:false},{nativeRead:"unavailable"},{nativeRead:"loading"},{currentRead:"unavailable"},{currentRead:"loading"}]) {
      expect(flow.projectClockFlow({...source(),...change} as ClockFlowInput).canStartDay).toBe(false);
    }
    expect(flow.projectClockFlow({...source(),releaseAuthorized:false})).toMatchObject({route:"legacy",canStartDay:true});
    const own={kind:"open" as const,shift:{id:SHIFT,profile_id:OWNER,status:"open" as const} as NonNullable<ClockFlowInput["legacyShift"]>};
    expect(flow.projectClockFlow({...source(),releaseAuthorized:false,nativeRead:"loading",current:own})).toMatchObject({route:"activation_blocked",canRequestSafety:false});
  });
  it("blocks another start for uncertain native and legacy starts, including acknowledgement without fresh off state",()=>{
    const records=[{intent:{action:"clock_in"},delivery:{status:"uncertain"}} as PaidClockRecord];
    expect(flow.projectClockFlow({...source(),records}).canStartDay).toBe(false);
    expect(flow.projectClockFlow({...source(),legacyPending:{kind:"clock_in",entryId:"old",tappedAt:"today",sending:false}}).canStartDay).toBe(false);
    records[0].delivery.status="acknowledged";
    expect(flow.projectClockFlow({...source(),records,currentRead:"loading",current:null}).canStartDay).toBe(false);
  });
  it("keeps independently confirmed own paid safety usable despite capture/native readiness failures",async()=>{
    const current={kind:"open" as const,shift:{id:SHIFT,profile_id:OWNER,status:"open" as const} as NonNullable<ClockFlowInput["legacyShift"]>};
    expect(flow.projectClockFlow({...source(),backendReady:false,nativeRead:"unavailable",current})).toMatchObject({canStartDay:false,canRequestSafety:true});
    const intent={action:"break_end",clientId:"tap",shiftRef:{kind:"shift",id:SHIFT}} as Extract<ClockIntent,{action:"break_end"}>;
    expect(await flow.authorNativeClockSafety(intent,signInMark(),current)).toMatchObject({kind:"saved",clientId:"winning-original"});
    expect(m.submit).toHaveBeenCalledWith(signInMark(),intent,null);
    expect(await flow.authorNativeClockSafety({...intent,shiftRef:{kind:"shift",id:OWNER}},signInMark(),current)).toMatchObject({kind:"held"});
    expect(m.submit).toHaveBeenCalledOnce();
  });
});
