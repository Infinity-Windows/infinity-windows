// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { rememberSignedIn, signInMark } from "../signedIn";
import type { ClockIntent } from "./protocol";
const m = vi.hoisted(() => ({ device: vi.fn(), records: vi.fn(), basis: vi.fn(), append: vi.fn(), dispatch: vi.fn() }));
vi.mock("../workActivity/device", () => ({ getActivityDeviceId: () => { throw Error("Activity metadata unavailable"); } }));
vi.mock("./storage", () => ({ readPaidClockRecords: m.records, appendPaidClockIntent: m.append, getPaidClockDeviceId: m.device }));
vi.mock("./api", () => ({ fetchOwnClockSafetyBasis: m.basis, ClockAccountChangedError: class extends Error {} }));
vi.mock("./dispatch", () => ({ dispatchPaidClockRequest: m.dispatch }));
const { paidSetupIntent, submitPaidClockIntent, recoverPaidClockRequest } = await import("./coordinator");
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12,"0")}`;
const OWNER=id(1), DEVICE=id(2), CLIENT=id(3), SHIFT=id(4), PREVIOUS=id(5);
const punch = { clientId: CLIENT, tappedAt: "2026-10-04T08:00:00.123456-06:00", clockCheckedAt: null, clockSkewMs: null };
const clock = () => paidSetupIntent(punch);
const out = ():ClockIntent => ({ ...punch, action:"clock_out", shiftRef:{kind:"shift",id:SHIFT},
  photo:null, injured:false, timeConfirmed:false, breakSeconds:0, lat:null, lng:null, injuryNote:null });
beforeEach(() => {
  rememberSignedIn({user:{id:OWNER}});
  Object.values(m).forEach(mock => mock.mockReset());
  m.device.mockResolvedValue(DEVICE); m.records.mockResolvedValue([]); m.basis.mockResolvedValue({proof:"fresh"});
  m.append.mockImplementation(async (_login,_device,intent) => ({clientId:intent.clientId}));
  m.dispatch.mockResolvedValue({kind:"held",reason:"unknown"});
});
describe("original paid clock coordinator", () => {
  it("keeps the original tap before job and toolbox setup without minting a UUID", () => {
    const intent=paidSetupIntent(punch,"data");
    expect(intent).toEqual({...punch,action:"clock_in",projectId:null,costCodeId:null,photo:null,lat:null,lng:null,note:null,mode:"data",setupVersion:1});
    expect(Object.isFrozen(intent)).toBe(true);
  });
  it("freezes before the first wait and commits before delivery, without fabricating a shift", async () => {
    let resolve!:(device:string)=>void; m.device.mockImplementationOnce(()=>new Promise<string>(done=>{resolve=done;}));
    const raw={...clock()}; const login=signInMark(), saving=submitPaidClockIntent(login,raw,null);
    raw.tappedAt="2026-10-04T11:00:00Z"; await vi.waitFor(()=>expect(m.device).toHaveBeenCalledOnce()); resolve(DEVICE);
    const result=await saving;
    expect(m.append.mock.calls[0]).toEqual([login,DEVICE,clock(),null,undefined]);
    expect(m.append.mock.invocationCallOrder[0]).toBeLessThan(m.dispatch.mock.invocationCallOrder[0]);
    expect(result).toEqual({kind:"saved",clientId:CLIENT,dispatch:{kind:"held",reason:"unknown"}});
    expect(result).not.toHaveProperty("shift"); expect(m.basis).not.toHaveBeenCalled();
  });
  it("blocks an A→B→A completion before it can save or send", async () => {
    let resolve!:(device:string)=>void; m.device.mockImplementationOnce(()=>new Promise<string>(done=>{resolve=done;}));
    const saving=submitPaidClockIntent(signInMark(),clock(),null);
    await vi.waitFor(()=>expect(m.device).toHaveBeenCalledOnce());
    rememberSignedIn(null);rememberSignedIn({user:{id:OWNER}});resolve(DEVICE);
    expect(await saving).toEqual({kind:"held",clientId:CLIENT,reason:"account_changed"});
    expect(m.append).not.toHaveBeenCalled();expect(m.dispatch).not.toHaveBeenCalled();
  });
  it("requires a fresh self-owned shift before a new independent safety head", async () => {
    const login=signInMark(); await submitPaidClockIntent(login,out(),null);
    expect(m.basis).toHaveBeenCalledWith(SHIFT,login);
    expect(m.append).toHaveBeenCalledWith(login,DEVICE,out(),null,{proof:"fresh"});
    m.basis.mockRejectedValueOnce(Error("closed"));m.append.mockClear();m.dispatch.mockClear();
    expect(await submitPaidClockIntent(login,out(),null)).toMatchObject({kind:"held",reason:"basis_unavailable"});
    expect(m.append).not.toHaveBeenCalled();expect(m.dispatch).not.toHaveBeenCalled();
  });
  it("does not demand an open shift to recover the same already-saved original", async () => {
    m.records.mockResolvedValue([{clientId:CLIENT}]); await submitPaidClockIntent(signInMark(),out(),null);
    expect(m.basis).not.toHaveBeenCalled(); expect(m.append).toHaveBeenCalledOnce();
    expect(m.dispatch).toHaveBeenLastCalledWith(CLIENT,expect.anything(),"check_only");
    // Exact owner/intent matching and stored device identity are native rules.
    m.records.mockResolvedValue([]);await submitPaidClockIntent(signInMark(),out(),PREVIOUS);
    expect(m.basis).not.toHaveBeenCalled();
  });
  it("does not author a safety head from a late basis across same-owner sign-out and sign-in",async()=>{
    let resolve!:(basis:unknown)=>void;m.basis.mockImplementationOnce(()=>new Promise(done=>{resolve=done;}));
    const saving=submitPaidClockIntent(signInMark(),out(),null);
    await vi.waitFor(()=>expect(m.basis).toHaveBeenCalledOnce());
    rememberSignedIn(null);rememberSignedIn({user:{id:OWNER}});resolve({proof:"old-generation"});
    expect(await saving).toEqual({kind:"held",clientId:CLIENT,reason:"account_changed"});
    expect(m.append).not.toHaveBeenCalled();expect(m.dispatch).not.toHaveBeenCalled();
  });
  it("never sends an unsaved request and does not call a post-commit auth change success", async () => {
    m.append.mockRejectedValueOnce(Error("native unavailable"));
    expect(await submitPaidClockIntent(signInMark(),clock(),null)).toMatchObject({kind:"held",reason:"storage_unavailable"});
    expect(m.dispatch).not.toHaveBeenCalled();
    m.append.mockImplementationOnce(async()=>{rememberSignedIn(null);rememberSignedIn({user:{id:OWNER}});return {clientId:CLIENT};});
    expect(await submitPaidClockIntent(signInMark(),clock(),null)).toMatchObject({kind:"held",reason:"account_changed"});
    expect(m.dispatch).not.toHaveBeenCalled();
  });
  it("adopts an original or predecessor device without consulting replacement metadata", async () => {
    m.device.mockRejectedValue(Error("Replacement metadata unavailable"));
    m.records.mockResolvedValue([{clientId:CLIENT,deviceId:DEVICE}]);
    await submitPaidClockIntent(signInMark(),out(),null);
    expect(m.device).not.toHaveBeenCalled();expect(m.append).toHaveBeenCalledWith(expect.anything(),DEVICE,out(),null,undefined);
    m.records.mockResolvedValue([{clientId:PREVIOUS,deviceId:DEVICE}]);m.append.mockClear();
    await submitPaidClockIntent(signInMark(),out(),PREVIOUS);
    expect(m.device).not.toHaveBeenCalled();expect(m.append).toHaveBeenCalledWith(expect.anything(),DEVICE,out(),PREVIOUS,undefined);
  });
  it("checks the winning original after two tabs deduplicate a safety action", async () => {
    m.append.mockResolvedValueOnce({clientId:PREVIOUS});
    const login=signInMark(), result=await submitPaidClockIntent(login,out(),null);
    expect(result).toMatchObject({kind:"saved",clientId:PREVIOUS});
    expect(m.dispatch).toHaveBeenCalledWith(PREVIOUS,login,"check_only");
  });
  it("uses paid metadata despite unavailable activity identity and stops if paid metadata fails", async () => {
    const login=signInMark(); await submitPaidClockIntent(login,out(),null);
    expect(m.device).toHaveBeenCalledWith(login);expect(m.append).toHaveBeenCalledOnce();
    m.device.mockRejectedValueOnce(Error("Paid metadata unavailable"));m.append.mockClear();m.dispatch.mockClear();
    expect(await submitPaidClockIntent(login,out(),null)).toMatchObject({kind:"held",reason:"storage_unavailable"});
    expect(m.append).not.toHaveBeenCalled();expect(m.dispatch).not.toHaveBeenCalled();
  });
  it("separates receipt checking from an explicit same-original resend", async () => {
    const login=signInMark();await recoverPaidClockRequest(CLIENT,login,"check");await recoverPaidClockRequest(CLIENT,login,"retry_original");
    expect(m.dispatch.mock.calls).toEqual([[CLIENT,login,"check_only"],[CLIENT,login,"retry_original"]]);
    m.dispatch.mockImplementationOnce(async()=>{rememberSignedIn(null);return {kind:"settled",record:{}};});
    expect(await recoverPaidClockRequest(CLIENT,login,"check")).toEqual({kind:"held",reason:"account_changed"});
  });
});
