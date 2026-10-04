// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rememberSignedIn, signInGeneration } from "../../lib/signedIn";
import type { SelectedJobWorkProps } from "./SelectedJobWork";
const ME = "00000000-0000-4000-8000-0000000000e3";
const A = "00000000-0000-4000-8000-0000000000a1", B = "00000000-0000-4000-8000-0000000000a2";
let seen: SelectedJobWorkProps | null, clockSeen: Record<string, unknown>;
const m = vi.hoisted(() => ({enabled:true, preview:false, unavailable:false, read:"ready", schedule:[] as unknown[], units:[] as unknown[],
  shift:null as null | Record<string, unknown>, projects: null as null | (() => Promise<unknown[]>), navigate:vi.fn(), openClock:vi.fn()}));
vi.mock("./SelectedJobWork", () => ({SelectedJobWork: (props: SelectedJobWorkProps) => {seen=props; return <div data-testid="adapter" />;}}));
vi.mock("../../lib/workActivity/selectedJobWorkGate", () => ({useSelectedJobWorkGate:()=>m.enabled}));
vi.mock("../../components/work/ClockStrip", () => ({ClockStrip:(p: Record<string, unknown>)=>{clockSeen=p;return <div data-testid="clock-strip" />;}}));
vi.mock("../../components/work/TodayCard",()=>({TodayCard:()=> <div data-testid="schedule"/>}));
vi.mock("../../components/install/LiveSummonsStrip",()=>({LiveSummonsStrip:()=>null}));
vi.mock("../../components/projects/CrewGoalCard",()=>({CrewGoalCard:()=> <div data-testid="goals"/>}));
vi.mock("../../components/work/ReportProblemSheet",()=>({ReportProblemSheet:()=>null}));
vi.mock("../../components/dailyLogs/DailyLogDialog",()=>({DailyLogDialog:()=>null}));
vi.mock("../../lib/pwa/useSafeSurface",()=>({useSafeSurface:()=>{}}));
vi.mock("../../lib/useToolboxGate",()=>({useLocalDay:()=>"2026-10-04",useTodayTalk:()=>({isSuccess:true,data:{id:"talk"}}),useToolboxToday:()=>({isSuccess:true,data:null})}));
vi.mock("../../lib/companySettings",()=>({getCompanySettings:async()=>null}));
vi.mock("../../lib/viewAsRoleContext",()=>({useViewAsRole:()=>({previewPerson:null,previewRole:m.preview?"foreman":null})}));
vi.mock("../../lib/supabase",()=>({supabase:{auth:{getSession:async()=>({data:{session:{user:{id:ME},access_token:"fixture"}},error:null})}}}));
vi.mock("../../lib/install/api",()=>({getMyProfile:async()=>({id:ME,role:"foreman",active:true})}));
vi.mock("../../lib/api",()=>({listProjects:async()=>{
  if(m.unavailable)throw new Error("unavailable");if(m.projects)return m.projects();
  return [{id:A,job_code:"A",name:"Alpha",allowed_modes:["data"]},{id:B,job_code:"B",name:"Beta",allowed_modes:["data"]}];
}}));
vi.mock("../../lib/costCodes",()=>({getClockCostCodesForProject:async()=>[{id:"00000000-0000-4000-8000-0000000000c1",code:"100",label:"Install",active:true}]}));
vi.mock("../../lib/customWork/api",()=>({listWorkUnits:async()=>m.units}));
vi.mock("../../lib/schedule/api",()=>({listMyPublished:async()=>m.schedule}));
vi.mock("../../lib/timeclock",async(orig)=>({...await orig<typeof import("../../lib/timeclock")>(),listRecentJobs:async()=>[]}));
vi.mock("../../lib/clockContext",()=>({useClock:()=>({loading:false,refresh:()=>{},nativeFlow:{ownerId:ME,loginGeneration:signInGeneration(),currentRead:m.read,current:m.shift ? {kind:"open",shift:m.shift} : {kind:"off",shift:null}}}),openClockGlobally:()=>m.openClock()}));
vi.mock("react-router-dom",async(orig)=>({...await orig<typeof import("react-router-dom")>(),useNavigate:()=>m.navigate}));
const {SelectedJobWorkRoute}=await import("./SelectedJobWorkRoute");
(globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
let host:HTMLDivElement,root:Root,qc:QueryClient;
async function flush(){await act(async()=>{await new Promise(r=>setTimeout(r,10));});}
async function render(){await act(async()=>root.render(<QueryClientProvider client={qc}><MemoryRouter><SelectedJobWorkRoute/></MemoryRouter></QueryClientProvider>));await flush();}
const button=(text:string)=>[...host.querySelectorAll("button")].find(b=>b.textContent?.includes(text))!;
async function pick(text="Alpha"){await act(async()=>button(text).click());await flush();}
beforeEach(()=>{m.enabled=true;m.preview=false;m.unavailable=false;m.read="ready";m.schedule=[];m.units=[];m.shift=null;m.projects=null;m.navigate.mockClear();m.openClock.mockClear();seen=null;rememberSignedIn({user:{id:ME}});Object.defineProperty(navigator,"onLine",{configurable:true,value:true});host=document.createElement("div");document.body.append(host);root=createRoot(host);qc=new QueryClient({defaultOptions:{queries:{retry:false}}});});
afterEach(()=>{act(()=>root.unmount());host.remove();qc.clear();rememberSignedIn(null);});
describe("real selected-job route caller",()=>{
  it("requires an explicit project and cost-code selection; it never allocates payroll by recommendation",async()=>{
    await render();expect(seen).toBeNull();expect(host.querySelector('[data-testid="clock-strip"]')).toBeTruthy();await pick();
    expect(seen?.project.id).toBe(A);expect(seen?.setupAllocation).toBeNull();expect(seen?.paidSeconds).toBeNull();expect(seen?.featureEnabled).toBe(true);
    const select=host.querySelector<HTMLSelectElement>("#sjwr-cost")!;expect(select.value).toBe("");
    expect(clockSeen.todayJobId).toBeNull();expect(clockSeen.gate).toMatchObject({talkExists:true,signedToday:false});
  });
  it("uses only an explicitly selected current cost code for finish_setup and clears it on job switch",async()=>{
    m.shift={id:"s1",profile_id:ME,clock_in_at:"2026-10-04T12:00:00Z",clock_out_at:null,break_seconds:0,break_started_at:null,status:"open"};
    await render();await pick();expect(seen?.setupAllocation).toBeNull();
    const code=host.querySelector<HTMLSelectElement>("#sjwr-cost")!;
    await act(async()=>{code.value="00000000-0000-4000-8000-0000000000c1";code.dispatchEvent(new Event("change",{bubbles:true}));});
    expect(seen?.setupAllocation).toEqual({projectId:A,costCodeId:code.value});
    await act(async()=>button("Change job").click());await pick("Beta");expect(seen?.setupAllocation).toBeNull();expect(m.openClock).not.toHaveBeenCalled();
  });
  it("maps only current selected-job units and keeps new-unit/editor/goals and clock navigation",async()=>{
    m.units=[{id:"u1",project_id:A,label:"Unit 1",type_label:"Bifold"},{id:"hidden",project_id:B,label:"Private"}];await render();await pick();
    expect(seen?.units).toEqual([{id:"u1",label:"Unit 1",detail:"Bifold"}]);expect(host.querySelector('[data-testid="goals"]')).toBeTruthy();
    seen!.onAddUnit();expect(m.navigate).toHaveBeenLastCalledWith(`/current-work?job=${A}&new_unit=1`);
    seen!.onBreak();seen!.onClockOut();seen!.onOpenClock();expect(m.openClock).toHaveBeenCalledTimes(3);
    seen!.onSchedule();expect(m.navigate).toHaveBeenLastCalledWith("/my-schedule");seen!.onAsk();expect(m.navigate).toHaveBeenLastCalledWith("/ask");
    expect(host.querySelector(`a[href="/current-work?job=${A}&unit=u1"]`)).toBeTruthy();
  });
  it("switches jobs without a clock punch, clears allocation, and hides stale native activity authority",async()=>{
    await render();await pick();m.read="stale";await render();expect(seen?.featureEnabled).toBe(false);expect(seen?.setupAllocation).toBeNull();
    await act(async()=>button("Change job").click());await pick("Beta");expect(seen?.project.id).toBe(B);expect(m.openClock).not.toHaveBeenCalled();
  });
  it("hides source errors and preview identically, retaining the clock door",async()=>{
    m.unavailable=true;await render();expect(button("Alpha")).toBeUndefined();expect(host.textContent).toContain("unavailable");
    m.unavailable=false;m.preview=true;await render();expect(button("Alpha")).toBeUndefined();expect(host.textContent).toContain("unavailable");expect(host.querySelector('[data-testid="clock-strip"]')).toBeTruthy();
  });
  it("invalidates a picked job on offline/reconnect until new data arrives",async()=>{
    await render();await pick();Object.defineProperty(navigator,"onLine",{configurable:true,value:false});await act(async()=>window.dispatchEvent(new Event("offline")));
    expect(host.querySelector('[data-testid="adapter"]')).toBeNull();let resolve!:(v:unknown[])=>void;m.projects=()=>new Promise(r=>{resolve=r;});
    Object.defineProperty(navigator,"onLine",{configurable:true,value:true});await act(async()=>window.dispatchEvent(new Event("online")));await flush();expect(host.querySelector('[data-testid="adapter"]')).toBeNull();
    await act(async()=>resolve([{id:B,name:"Beta",job_code:"B"}]));await flush();expect(button("Alpha")).toBeUndefined();
  });
  it("discards an old-login late project read, including same-owner ABA",async()=>{
    let resolve!:(v:unknown[])=>void;m.projects=()=>new Promise(r=>{resolve=r;});await render();await act(async()=>{rememberSignedIn(null);rememberSignedIn({user:{id:ME}});});await flush();
    await act(async()=>resolve([]));await flush();expect(seen).toBeNull();expect(button("Alpha")).toBeUndefined();
  });
});
