// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { rememberSignedIn, signInMark } from "../signedIn";
const m=vi.hoisted(()=>({read:vi.fn(),dispatch:vi.fn()}));
vi.mock("./storage",()=>({readPaidClockRecords:m.read}));
vi.mock("./dispatch",()=>({dispatchPaidClockRequest:m.dispatch}));
const {checkSavedPaidClockReceipts}=await import("./recovery");
const OWNER="00000000-0000-4000-8000-000000000001";
const row=(n:number,status="queued")=>({clientId:String(n),intent:{tappedAt:`2026-10-04T09:00:0${n}.000Z`},delivery:{status}});
beforeEach(()=>{rememberSignedIn({user:{id:OWNER}});m.read.mockReset();m.dispatch.mockReset().mockResolvedValue({kind:"held",reason:"unknown"});
  Object.defineProperty(navigator,"onLine",{configurable:true,value:true});});
describe("bounded native receipt recovery",()=>{
  it("checks at most four unresolved originals, including queued starts, and never selects a send policy",async()=>{
    m.read.mockResolvedValue([row(6),row(1),row(2,"uncertain"),row(3,"sending"),row(4,"attention"),row(5,"acknowledged")]);
    const login=signInMark();expect(await checkSavedPaidClockReceipts(login)).toBe("checked");
    expect(m.dispatch.mock.calls).toEqual([1,2,3,4].map(n=>[String(n),login,"check_only"]));
  });
  it("stops after an account change and never touches another original",async()=>{
    m.read.mockResolvedValue([row(1),row(2)]);m.dispatch.mockImplementationOnce(async()=>{rememberSignedIn(null);rememberSignedIn({user:{id:OWNER}});});
    expect(await checkSavedPaidClockReceipts(signInMark())).toBe("held");expect(m.dispatch).toHaveBeenCalledOnce();
  });
  it("holds offline or unread native state without assuming it is empty",async()=>{
    Object.defineProperty(navigator,"onLine",{configurable:true,value:false});expect(await checkSavedPaidClockReceipts(signInMark())).toBe("held");expect(m.read).not.toHaveBeenCalled();
    Object.defineProperty(navigator,"onLine",{configurable:true,value:true});m.read.mockRejectedValueOnce(Error("storage"));
    expect(await checkSavedPaidClockReceipts(signInMark())).toBe("held");expect(m.dispatch).not.toHaveBeenCalled();
  });
});
