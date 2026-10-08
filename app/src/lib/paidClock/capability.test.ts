// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { rememberSignedIn, signInMark } from "../signedIn";
const m=vi.hoisted(()=>({client:vi.fn(),rpc:vi.fn()}));
vi.mock("./api",()=>({ClockAccountChangedError:class extends Error {},ownPaidClockClient:m.client}));
const {parsePaidClockCapability,fetchPaidClockCapability}=await import("./capability");
const OWNER="00000000-0000-4000-8000-000000000001";
const capability=()=>({protocolVersion:1,asOf:"2026-10-04T09:00:00.123456Z",clockProtocol:"setup_v1",receiptProtocol:"retained_v1",
  mode:"active",canAuthorSetup:true,setupReason:null,canDispatchExistingSetup:true,canReadOwnReceipts:true,canDispatchPayrollSafety:true});
beforeEach(()=>{rememberSignedIn({user:{id:OWNER}});m.client.mockReset().mockResolvedValue({rpc:m.rpc});m.rpc.mockReset().mockResolvedValue({data:capability(),error:null});});
describe("explicit paid-clock capability",()=>{
  it("distinguishes author permission from compatible closing and saved request protocols",()=>{
    expect(parsePaidClockCapability(capability()).canAuthorSetup).toBe(true);
    expect(parsePaidClockCapability({...capability(),canAuthorSetup:false,setupReason:"toolbox_required"})).toMatchObject({mode:"active",canAuthorSetup:false});
    expect(parsePaidClockCapability({...capability(),mode:"closing_only",canAuthorSetup:false,setupReason:"starts_disabled"})).toMatchObject({canDispatchPayrollSafety:true});
    expect(parsePaidClockCapability({...capability(),mode:"unavailable",canAuthorSetup:false,setupReason:"not_ready"})).toMatchObject({canReadOwnReceipts:true});
  });
  it("refuses partial, upgraded or contradictory data instead of activating from a positive flag",()=>{
    for(const change of [{extra:true},{protocolVersion:2},{clockProtocol:"legacy"},{asOf:"bad"},{mode:"closing_only"},
      {canAuthorSetup:"true"},{canDispatchExistingSetup:false},{canReadOwnReceipts:false},{canDispatchPayrollSafety:false},
      {canAuthorSetup:false},{canAuthorSetup:false,setupReason:"starts_disabled"}])expect(()=>parsePaidClockCapability({...capability(),...change})).toThrow();
    expect(()=>parsePaidClockCapability(null)).toThrow();
    const missing=capability() as Record<string,unknown>;delete missing.canReadOwnReceipts;expect(()=>parsePaidClockCapability(missing)).toThrow();
  });
  it("uses only the own no-argument RPC, and never accepts a missing RPC or late auth ABA",async()=>{
    expect(await fetchPaidClockCapability(signInMark())).toMatchObject({mode:"active"});expect(m.rpc).toHaveBeenCalledWith("work_activity_clock_capability");
    m.rpc.mockResolvedValueOnce({data:null,error:Error("function missing")});await expect(fetchPaidClockCapability(signInMark())).rejects.toThrow("function missing");
    let resolve!:(v:unknown)=>void;m.rpc.mockImplementationOnce(()=>new Promise(done=>{resolve=done;}));
    const pending=fetchPaidClockCapability(signInMark());await vi.waitFor(()=>expect(m.rpc).toHaveBeenCalledTimes(3));
    rememberSignedIn(null);rememberSignedIn({user:{id:OWNER}});resolve({data:capability(),error:null});await expect(pending).rejects.toThrow();
  });
});
