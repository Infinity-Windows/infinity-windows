// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { rememberSignedIn, signInMark } from "../signedIn";
import {act,createElement} from "react";
import {createRoot} from "react-dom/client";
const m=vi.hoisted(()=>({client:vi.fn(),single:vi.fn(),select:vi.fn(),eq:vi.fn(),filter:vi.fn()}));
vi.mock("./api",()=>({ClockAccountChangedError:class extends Error {},ownPaidClockClient:m.client}));
const api=await import("./current");
const {useOwnPaidClockCurrent}=await import("./useOwnPaidClockCurrent");
(globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
const OWNER="00000000-0000-4000-8000-000000000001",SHIFT="00000000-0000-4000-8000-000000000002";
const at="2026-10-04T09:00:00.123456Z";
const row=()=>({id:SHIFT,profile_id:OWNER,project_id:null,cost_code_id:null,clock_in_at:at,clock_out_at:null,
  break_seconds:0,break_started_at:null,break_type:null,injured:null,time_confirmed:null,status:"open",created_at:at,
  note:null,injury_note:null,job_mode:null,review_reason:null,projects:null,cost_codes:null});
beforeEach(()=>{
  rememberSignedIn(null);
  rememberSignedIn({user:{id:OWNER}});
  for(const fn of Object.values(m))fn.mockReset();
  const q={eq:m.eq,in:m.filter,is:m.filter,order:m.filter,limit:m.filter,maybeSingle:m.single};
  m.eq.mockReturnValue(q);m.filter.mockReturnValue(q);m.select.mockReturnValue(q);
  m.client.mockResolvedValue({from:()=>({select:m.select})});m.single.mockResolvedValue({data:row(),error:null});
});
describe("fresh own paid state",()=>{
  it("immediately hides an offline stamped display when its source is removed",async()=>{
    Object.defineProperty(navigator,"onLine",{configurable:true,value:true});
    const host=document.createElement("div"),root=createRoot(host);document.body.append(host);
    let latest!:ReturnType<typeof useOwnPaidClockCurrent>;
    function View(){latest=useOwnPaidClockCurrent(OWNER,true);return null;}
    try {
      await act(async()=>root.render(createElement(View)));expect(latest.value?.kind).toBe("open");
      await act(async()=>{Object.defineProperty(navigator,"onLine",{configurable:true,value:false});window.dispatchEvent(new Event("offline"));});
      expect(latest.state).toBe("stale");
      act(()=>api.invalidateObservedClockTarget(signInMark(),SHIFT));
      expect(latest).toMatchObject({state:"unavailable",value:null});
    } finally {
      act(()=>root.unmount());host.remove();Object.defineProperty(navigator,"onLine",{configurable:true,value:true});
    }
  });
  it("brands only the actual current-login observation and strips private allocation details from retained display",async()=>{
    const login=signInMark(),result=await api.fetchOwnPaidClockCurrent(login);
    expect(api.isCurrentLoginSafetyTarget(result.safetyTarget,OWNER,SHIFT,login)).toBe(true);
    expect(api.isCurrentLoginSafetyTarget({...result.safetyTarget},OWNER,SHIFT,login)).toBe(false);
    expect(Object.isFrozen(result.shift)).toBe(true);
    expect(Object.isFrozen(api.readLastObservedPaidClock(login)?.shift)).toBe(true);
    expect(api.parseOwnPaidClockCurrent(row(),OWNER).safetyTarget).toBeUndefined();
    const minimal=api.minimalObservedPaidClock({...result,shift:{...result.shift!,project_id:SHIFT,cost_code_id:SHIFT,
      projects:{job_code:"private",name:"office"},note:"private",injury_note:"private"}} as typeof result);
    expect(minimal.shift).toMatchObject({project_id:null,cost_code_id:null,note:null,injury_note:null});
    expect(minimal.shift?.projects).toBeUndefined();
  });
  it("retains transport evidence but revokes it on authoritative refusal or a fresh off read",async()=>{
    const login=signInMark(),first=await api.fetchOwnPaidClockCurrent(login);
    m.single.mockResolvedValueOnce({data:null,error:TypeError("Failed to fetch")});
    await expect(api.fetchOwnPaidClockCurrent(login)).rejects.toThrow();
    expect(api.readObservedClockTarget(login,SHIFT)).toBe(first.safetyTarget);
    m.single.mockResolvedValueOnce({data:null,error:{code:"42501",message:"Failed to fetch"}});
    await expect(api.fetchOwnPaidClockCurrent(login)).rejects.toMatchObject({code:"42501"});
    expect(api.readLastObservedPaidClock(login)).toBeNull();
    const next=await api.fetchOwnPaidClockCurrent(login);
    m.single.mockResolvedValueOnce({data:null,error:null});await api.fetchOwnPaidClockCurrent(login);
    expect(api.isCurrentLoginSafetyTarget(next.safetyTarget,OWNER,SHIFT,login)).toBe(false);
    expect(api.readLastObservedPaidClock(login)?.kind).toBe("off");
  });
  it("notifies every revocation subscriber even without a target and cancels an earlier in-flight source read",async()=>{
    const login=signInMark(),seen=vi.fn();
    const stopBad=api.subscribeObservedClockChanges(()=>{throw Error("UI failed");});
    const stopSeen=api.subscribeObservedClockChanges(seen);
    let resolve!:(value:unknown)=>void;m.single.mockImplementationOnce(()=>new Promise(done=>{resolve=done;}));
    const pending=api.fetchOwnPaidClockCurrent(login);await vi.waitFor(()=>expect(m.single).toHaveBeenCalledOnce());
    api.invalidateObservedClockTarget(login,SHIFT);expect(seen).toHaveBeenCalledOnce();
    resolve({data:row(),error:null});await expect(pending).rejects.toThrow("superseded");
    expect(api.readLastObservedPaidClock(login)).toBeNull();stopBad();stopSeen();
  });
  it("does not let an older read overwrite the newer source or invalidate its target",async()=>{
    const login=signInMark();let resolve!:(value:unknown)=>void;
    m.single.mockImplementationOnce(()=>new Promise(done=>{resolve=done;}));
    const earlier=api.fetchOwnPaidClockCurrent(login);await vi.waitFor(()=>expect(m.single).toHaveBeenCalledOnce());
    const newer=await api.fetchOwnPaidClockCurrent(login);resolve({data:row(),error:null});
    await expect(earlier).rejects.toThrow("superseded");
    expect(api.readObservedClockTarget(login,SHIFT)).toBe(newer.safetyTarget);
  });
  it("uses a self-filtered source read and distinguishes reviewed time from an open shift",async()=>{
    expect(await api.fetchOwnPaidClockCurrent(signInMark())).toMatchObject({kind:"open",shift:{id:SHIFT,clock_in_at:at}});
    expect(m.eq).toHaveBeenCalledWith("profile_id",OWNER);
    expect(api.parseOwnPaidClockCurrent({...row(),status:"needs_finish"},OWNER).kind).toBe("needs_finish");
    expect(api.parseOwnPaidClockCurrent(null,OWNER)).toEqual({kind:"off",shift:null});
  });
  it("refuses foreign, optimistic, closed or malformed source data instead of publishing off",()=>{
    for(const change of [{profile_id:SHIFT},{id:`pending:${SHIFT}`},{status:"submitted"},{clock_out_at:at},
      {break_seconds:-1},{break_seconds:0.5},{clock_in_at:"yesterday"},{break_started_at:"bad"},{projects:{job_code:7,name:"bad"}}]) {
      expect(()=>api.parseOwnPaidClockCurrent({...row(),...change},OWNER)).toThrow();
    }
  });
  it("drops late auth ABA and propagates read failure rather than treating it as off",async()=>{
    let resolve!:(value:unknown)=>void;m.single.mockImplementationOnce(()=>new Promise(done=>{resolve=done;}));
    const pending=api.fetchOwnPaidClockCurrent(signInMark());await vi.waitFor(()=>expect(m.single).toHaveBeenCalledOnce());
    rememberSignedIn(null);rememberSignedIn({user:{id:OWNER}});resolve({data:row(),error:null});await expect(pending).rejects.toThrow();
    m.single.mockResolvedValueOnce({data:null,error:Error("permission denied")});await expect(api.fetchOwnPaidClockCurrent(signInMark())).rejects.toThrow("permission denied");
  });
});
