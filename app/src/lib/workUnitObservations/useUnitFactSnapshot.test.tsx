// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider, onlineManager } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rememberSignedIn, signInGeneration } from "../signedIn";
import type { UnitFactSnapshot } from "./model";
const fetch=vi.fn();
vi.mock("./api",()=>({fetchUnitFactSnapshot:(...args:unknown[])=>fetch(...args)}));
const {useUnitFactSnapshot}=await import("./useUnitFactSnapshot");
(globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
const OWNER="00000000-0000-4000-8000-000000000001", JOB="00000000-0000-4000-8000-000000000010", UNIT="00000000-0000-4000-8000-000000000020";
const fact:UnitFactSnapshot={unitId:UNIT,revision:1,eventKind:"legacy_observation",observation:null,widthIn:12,heightIn:24,observationActorId:null,recordedAt:"2026-10-04T00:00:00Z"};
let host:HTMLDivElement,root:Root,qc:QueryClient,connected=true,latest:ReturnType<typeof useUnitFactSnapshot>;
function View({enabled=true,unit=UNIT}:{enabled?:boolean;unit?:string}){latest=useUnitFactSnapshot(JOB,unit,enabled);return <div>{latest.state} {latest.snapshot?.widthIn}</div>;}
async function render(props:Parameters<typeof View>[0]={}){await act(async()=>{root.render(<QueryClientProvider client={qc}><View {...props}/></QueryClientProvider>);await new Promise(r=>setTimeout(r,10));});}
async function flush(){await act(async()=>{await new Promise(r=>setTimeout(r,10));});}
function expectAnonymousCache(){for(const query of qc.getQueryCache().getAll()){expect(query.queryKey).not.toContain(OWNER);expect(query.queryKey).not.toContain(JOB);expect(query.queryKey).not.toContain(UNIT);expect(query.state.data).toBeUndefined();}}
beforeEach(()=>{connected=true;onlineManager.setOnline(true);Object.defineProperty(navigator,"onLine",{configurable:true,get:()=>connected});rememberSignedIn({user:{id:OWNER}});fetch.mockReset().mockResolvedValue(fact);qc=new QueryClient({defaultOptions:{queries:{retry:false}}});host=document.createElement("div");document.body.append(host);root=createRoot(host);});
afterEach(()=>{act(()=>root.unmount());qc.clear();host.remove();rememberSignedIn(null);onlineManager.setOnline(true);delete (navigator as unknown as {onLine?:boolean}).onLine;});
describe("private current measurement scope",()=>{
  it("binds real login generation and erases the scoped cache on navigation",async()=>{await render();await flush();expect(latest.snapshot?.widthIn).toBe(12);expect(fetch).toHaveBeenCalledWith(UNIT,{userId:OWNER,generation:signInGeneration()});expect(qc.getQueryCache().getAll()).toHaveLength(1);await render({unit:JOB});await flush();expect(qc.getQueryCache().getAll().some(q=>q.queryKey.at(-1)===UNIT)).toBe(false);});
  it("clears private details when disabled and fetches fresh on re-entry",async()=>{await render();await flush();await render({enabled:false});await flush();expect(latest.state).toBe("blocked");expect(latest.snapshot).toBeUndefined();expectAnonymousCache();fetch.mockResolvedValue({...fact,widthIn:15});await render();await flush();expect(latest.snapshot?.widthIn).toBe(15);});
  it("hides and erases private evidence offline without interpreting it as no history",async()=>{await render();await flush();await act(async()=>{connected=false;window.dispatchEvent(new Event("offline"));});await flush();expect(latest.state).toBe("blocked");expect(latest.snapshot).toBeUndefined();expectAnonymousCache();});
  it("does not retain former identities or revive a late private read after logout",async()=>{let resolve!:(value:UnitFactSnapshot)=>void;fetch.mockImplementationOnce(()=>new Promise<UnitFactSnapshot>(yes=>{resolve=yes;}));await render();await act(async()=>rememberSignedIn(null));await flush();await act(async()=>resolve({...fact,widthIn:999}));await flush();expect(latest.state).toBe("blocked");expect(latest.snapshot).toBeUndefined();expectAnonymousCache();});
  it("a refused refresh replaces old private cached details with unavailable",async()=>{await render();await flush();fetch.mockRejectedValue(Error("Source now unavailable"));await act(async()=>{await latest.refresh();});await flush();expect(latest.state).toBe("unavailable");expect(latest.snapshot).toBeUndefined();expect(qc.getQueryCache().getAll()[0].state.data).toEqual({status:"unavailable"});});
  it("does not revive a cancelled late read after same-owner account ABA",async()=>{let resolve!:(value:UnitFactSnapshot)=>void;fetch.mockImplementationOnce(()=>new Promise<UnitFactSnapshot>(yes=>{resolve=yes;}));await render();const oldGeneration=signInGeneration();await act(async()=>{rememberSignedIn(null);rememberSignedIn({user:{id:OWNER}});});await flush();expect(signInGeneration()).toBeGreaterThan(oldGeneration);await act(async()=>{resolve({...fact,widthIn:999});});await flush();expect(latest.snapshot?.widthIn).toBe(12);expect(qc.getQueryCache().getAll().some(q=>q.queryKey.includes(oldGeneration))).toBe(false);});
});
