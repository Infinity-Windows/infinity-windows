// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rememberSignedIn } from "../../lib/signedIn";
import { LanguageContext } from "../../lib/i18n/context";
import { CATALOG, translate, type Lang } from "../../lib/i18n";
import type { PaidClockRecord } from "../../lib/paidClock/storage";
const m=vi.hoisted(()=>({recover:vi.fn(),refresh:vi.fn(),legacy:vi.fn(),state:"ready",rows:[] as PaidClockRecord[],online:true}));
vi.mock("../../lib/paidClock/usePaidClockRecords",()=>({usePaidClockRecords:()=>({state:m.state,rows:m.rows,refresh:m.refresh})}));
vi.mock("../../lib/paidClock/coordinator",()=>({recoverPaidClockRequest:m.recover}));
vi.mock("../../lib/offline/useWeakSignal",()=>({useConnection:()=>({online:m.online})}));
vi.mock("./ClockQueueStatus",()=>({ClockQueueStatus:(props:unknown)=>{m.legacy(props);return <p>Legacy clock queue</p>;}}));
const {PaidClockQueueStatus}=await import("./PaidClockQueueStatus");
(globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,"0")}`;
const OWNER=id(1),CLIENT=id(2);
const row=(status:PaidClockRecord["delivery"]["status"]):PaidClockRecord=>({clientId:CLIENT,
  intent:{action:"clock_in",tappedAt:"2026-10-04T08:00:00Z"},delivery:{status,receipt:null}} as PaidClockRecord);
let host:HTMLDivElement,root:Root,lang:Lang;
async function render(history=false){await act(async()=>root.render(<LanguageContext.Provider value={{lang,t:(key,vars)=>translate(CATALOG,lang,key,vars),setLang:()=>{},needsChoice:false}}><PaidClockQueueStatus profileId={OWNER} includeHistory={history}/></LanguageContext.Provider>));}
function button(text:string){return Array.from(host.querySelectorAll("button")).find(b=>b.textContent===text)!;}
beforeEach(()=>{rememberSignedIn({user:{id:OWNER}});m.state="ready";m.rows=[row("uncertain")];m.online=true;m.refresh.mockReset().mockResolvedValue(undefined);m.recover.mockReset().mockResolvedValue({kind:"held",reason:"unknown"});m.legacy.mockClear();lang="en";host=document.createElement("div");document.body.append(host);root=createRoot(host);});
afterEach(()=>{act(()=>root.unmount());host.remove();rememberSignedIn(null);});
describe("saved punch recovery view",()=>{
  it("does not convert a saved or unknown punch into clocked-in or setup completion",async()=>{
    await render();expect(host.textContent).toContain("Forge may already have received");
    expect(host.textContent).not.toContain("Clocked in");expect(host.textContent).not.toContain("Start-of-day setup");
    expect(m.recover).not.toHaveBeenCalled();expect(m.legacy).toHaveBeenCalledWith({pending:null,refused:[]});
    m.rows=[row("queued")];await render();expect(host.textContent).toContain("awaiting confirmation");expect(m.recover).not.toHaveBeenCalled();
  });
  it("shows failed reads as unavailable and blocks recovery while offline",async()=>{
    m.state="unavailable";m.rows=[];await render();expect(host.textContent).toContain("could not be read");
    await act(async()=>button("Read saved punches again").click());expect(m.refresh).toHaveBeenCalledOnce();
    m.state="ready";m.rows=[row("sending")];m.online=false;await render();
    expect(button("Check confirmation").disabled).toBe(true);expect(button("Resend original punch").disabled).toBe(true);
    expect(host.textContent).toContain("Reconnect");expect(m.recover).not.toHaveBeenCalled();
  });
  it("separates checking from explicit same-original resend and serializes double taps",async()=>{
    await render();let done!:(result:unknown)=>void;m.recover.mockImplementationOnce(()=>new Promise(resolve=>{done=resolve;}));
    const check=button("Check confirmation");await act(async()=>{check.click();check.click();});
    expect(m.recover).toHaveBeenCalledOnce();expect(m.recover.mock.calls[0][0]).toBe(CLIENT);expect(m.recover.mock.calls[0][2]).toBe("check");
    await act(async()=>done({kind:"held",reason:"unknown"}));expect(m.refresh).toHaveBeenCalledOnce();
    await act(async()=>button("Resend original punch").click());expect(m.recover.mock.calls[1][2]).toBe("retry_original");
    expect(host.textContent).toContain("not treated as complete");
  });
  it("hides rows and does not publish a late recovery after owner ABA",async()=>{
    await render();let done!:(result:unknown)=>void;m.recover.mockImplementationOnce(()=>new Promise(resolve=>{done=resolve;}));
    await act(async()=>button("Check confirmation").click());rememberSignedIn(null);rememberSignedIn({user:{id:OWNER}});
    m.state="blocked";await render();await act(async()=>done({kind:"settled",record:row("acknowledged")}));
    expect(host.textContent).toBe("");expect(m.refresh).not.toHaveBeenCalled();
  });
  it("labels acknowledgement as delivery history, without using it as current shift proof",async()=>{
    m.rows=[row("acknowledged")];await render();expect(host.textContent).not.toContain("Delivery confirmed");
    await render(true);expect(host.textContent).toContain("historical receipt");expect(host.textContent).toContain("latest shift and activity records");
    expect(host.querySelectorAll("button")).toHaveLength(0);
    m.rows=[row("attention")];await render();expect(host.textContent).toContain("Needs review");expect(button("Resend original punch")).toBeUndefined();
  });
  it("renders the same recovery distinction and explicit action in Spanish",async()=>{
    lang="es";await render();expect(host.textContent).toContain("Confirmación pendiente");expect(host.textContent).toContain("su hora original");
    expect(button("Revisar confirmación")).toBeTruthy();expect(button("Reenviar marcación original")).toBeTruthy();
  });
});
