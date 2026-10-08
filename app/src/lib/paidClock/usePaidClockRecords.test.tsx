// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rememberSignedIn, signInGeneration } from "../signedIn";
import { PAID_CLOCK_EVENT } from "./notifications";
import type { PaidClockRecord } from "./storage";

const readNative=vi.fn();
vi.mock("./storage",()=>({readPaidClockRecords:(...args:unknown[])=>readNative(...args)}));
const {usePaidClockRecords}=await import("./usePaidClockRecords");
(globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,"0")}`;
const A=id(1),B=id(2),COMMAND=id(3);
const row=(ownerId:string,clientId=COMMAND)=>({ownerId,clientId} as PaidClockRecord);
let host:HTMLDivElement,root:Root,latest:ReturnType<typeof usePaidClockRecords>,profile:string|null;
function View({profileId}:{profileId:string|null}) { latest=usePaidClockRecords(profileId); return <div>{latest.state}:{latest.rows.map(r=>r.clientId).join(",")}</div>; }
async function render(next=profile){profile=next;await act(async()=>{root.render(<View profileId={profile}/>);await new Promise(done=>setTimeout(done,10));});}
async function flush(){await act(async()=>{await new Promise(done=>setTimeout(done,10));});}
beforeEach(()=>{rememberSignedIn({user:{id:A}});readNative.mockReset().mockResolvedValue([row(A)]);host=document.createElement("div");document.body.append(host);root=createRoot(host);profile=A;});
afterEach(()=>{act(()=>root.unmount());host.remove();rememberSignedIn(null);});

describe("current-owner paid clock records",()=>{
  it("does not call an unread native queue empty, and scopes every read to the current mark",async()=>{
    let resolve!:(rows:PaidClockRecord[])=>void;readNative.mockImplementationOnce(()=>new Promise<PaidClockRecord[]>(done=>{resolve=done;}));
    await render();expect(latest.state).toBe("loading");expect(latest.rows).toEqual([]);expect(readNative).toHaveBeenCalledWith({userId:A,generation:signInGeneration()});
    await act(async()=>resolve([row(A)]));expect(latest.state).toBe("ready");expect(latest.rows[0].clientId).toBe(COMMAND);
  });
  it("hides private rows immediately for wrong profile, logout, same-owner ABA and new owner",async()=>{
    await render();expect(latest.state).toBe("ready");await render(B);expect(latest).toMatchObject({state:"blocked",rows:[]});expect(readNative).toHaveBeenCalledTimes(1);
    await render(A);expect(latest.state).toBe("ready");await act(async()=>rememberSignedIn(null));expect(latest).toMatchObject({state:"blocked",rows:[]});
    let resolve!:(rows:PaidClockRecord[])=>void;readNative.mockImplementationOnce(()=>new Promise<PaidClockRecord[]>(done=>{resolve=done;}));
    await act(async()=>rememberSignedIn({user:{id:A}}));expect(latest.state).toBe("loading");expect(latest.rows).toEqual([]);
    await act(async()=>rememberSignedIn({user:{id:B}}));expect(latest).toMatchObject({state:"blocked",rows:[]});
    await act(async()=>resolve([row(A)]));expect(latest.rows).toEqual([]);
  });
  it("ignores a late A result after A→B→A and reads the new generation",async()=>{
    let oldResolve!:(rows:PaidClockRecord[])=>void;
    readNative.mockImplementationOnce(()=>new Promise<PaidClockRecord[]>(done=>{oldResolve=done;})).mockResolvedValueOnce([row(A,id(4))]);
    await render();const oldGeneration=signInGeneration();
    await act(async()=>{rememberSignedIn({user:{id:B}});rememberSignedIn({user:{id:A}});});await flush();
    expect(signInGeneration()).toBeGreaterThan(oldGeneration);expect(latest.rows.map(r=>r.clientId)).toEqual([id(4)]);
    await act(async()=>oldResolve([row(A,id(5))]));expect(latest.rows.map(r=>r.clientId)).toEqual([id(4)]);
  });
  it("takes the latest event/refresh read, including deletion and read failure",async()=>{
    await render();let oldResolve!:(rows:PaidClockRecord[])=>void;
    readNative.mockImplementationOnce(()=>new Promise<PaidClockRecord[]>(done=>{oldResolve=done;})).mockResolvedValueOnce([]);
    await act(async()=>window.dispatchEvent(new Event(PAID_CLOCK_EVENT)));
    expect(latest.state).toBe("loading");expect(latest.rows).toEqual([]);
    await act(async()=>{await latest.refresh();});expect(latest).toMatchObject({state:"ready",rows:[]});
    await act(async()=>oldResolve([row(A,id(6))]));expect(latest).toMatchObject({state:"ready",rows:[]});
    readNative.mockRejectedValueOnce(Error("native read failed"));await act(async()=>{await latest.refresh();});
    expect(latest).toMatchObject({state:"unavailable",rows:[]});
  });
  it("retains owner-visible native records offline, then clears on unmount and ignores late completion",async()=>{
    Object.defineProperty(navigator,"onLine",{configurable:true,value:false});
    await render();expect(latest.state).toBe("ready");expect(latest.rows).toHaveLength(1);
    let resolve!:(rows:PaidClockRecord[])=>void;readNative.mockImplementationOnce(()=>new Promise<PaidClockRecord[]>(done=>{resolve=done;}));
    await act(async()=>window.dispatchEvent(new Event(PAID_CLOCK_EVENT)));expect(latest.state).toBe("loading");
    act(()=>root.unmount());root=createRoot(host);await render();
    await act(async()=>resolve([row(A,id(7))]));expect(latest.rows.map(r=>r.clientId)).toEqual([COMMAND]);
    delete (navigator as unknown as {onLine?:boolean}).onLine;
  });
  it("treats a foreign native row as unavailable instead of publishing it",async()=>{
    readNative.mockResolvedValueOnce([row(B)]);await render();expect(latest).toMatchObject({state:"unavailable",rows:[]});
  });
});
