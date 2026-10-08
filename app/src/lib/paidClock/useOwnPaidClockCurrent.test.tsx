// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rememberSignedIn } from "../signedIn";
const read=vi.hoisted(()=>vi.fn());
vi.mock("./current",async original=>({...await original<typeof import("./current")>(),fetchOwnPaidClockCurrent:read}));
const {useOwnPaidClockCurrent}=await import("./useOwnPaidClockCurrent");
(globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
const OWNER="00000000-0000-4000-8000-000000000001",OTHER="00000000-0000-4000-8000-000000000002";
let root:Root,host:HTMLDivElement,latest:ReturnType<typeof useOwnPaidClockCurrent>;
function View({profile=OWNER,enabled=true}:{profile?:string;enabled?:boolean}) {latest=useOwnPaidClockCurrent(profile,enabled);return <div>{latest.state}:{latest.value?.kind}</div>;}
async function render(profile=OWNER,enabled=true){await act(async()=>{root.render(<View profile={profile} enabled={enabled}/>);});}
beforeEach(()=>{rememberSignedIn({user:{id:OWNER}});read.mockReset().mockResolvedValue({kind:"off",shift:null});
  Object.defineProperty(navigator,"onLine",{configurable:true,value:true});host=document.createElement("div");document.body.append(host);root=createRoot(host);});
afterEach(()=>{act(()=>root.unmount());host.remove();rememberSignedIn(null);});
describe("current paid state lifecycle",()=>{
  it("keeps unread state unknown and clears source details on failed refresh",async()=>{
    let resolve!:(v:unknown)=>void;read.mockImplementationOnce(()=>new Promise(done=>{resolve=done;}));
    await render();expect(latest).toMatchObject({state:"loading",value:null});
    await act(async()=>resolve({kind:"off",shift:null}));expect(latest).toMatchObject({state:"ready",value:{kind:"off"}});
    read.mockRejectedValueOnce(Error("offline response"));await act(async()=>{await latest.refresh();});expect(latest).toMatchObject({state:"unavailable",value:null});
  });
  it("discards late ABA responses and immediately hides disabled or previewed data",async()=>{
    let resolve!:(v:unknown)=>void;read.mockImplementationOnce(()=>new Promise(done=>{resolve=done;}));await render();
    await act(async()=>{rememberSignedIn({user:{id:OTHER}});rememberSignedIn({user:{id:OWNER}});});
    expect(latest.value?.kind).toBe("off");
    await act(async()=>resolve({kind:"open",shift:{id:"stale private shift"}}));expect(latest.value?.kind).toBe("off");
    await render(OTHER);expect(latest).toMatchObject({state:"blocked",value:null});
    await render(OWNER,false);expect(latest).toMatchObject({state:"blocked",value:null});
  });
  it("labels last-observed state stale while offline and reads again after reconnect",async()=>{
    await render();expect(latest.state).toBe("ready");
    await act(async()=>{Object.defineProperty(navigator,"onLine",{configurable:true,value:false});window.dispatchEvent(new Event("offline"));});
    expect(latest).toMatchObject({state:"stale",value:{kind:"off"}});
    read.mockResolvedValueOnce({kind:"needs_finish",shift:{id:"review source"}});
    await act(async()=>{Object.defineProperty(navigator,"onLine",{configurable:true,value:true});window.dispatchEvent(new Event("online"));});
    expect(latest.value?.kind).toBe("needs_finish");
  });
});
