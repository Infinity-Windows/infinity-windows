// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider, onlineManager } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkUnit } from "../../lib/customWork/model";
import { rememberSignedIn } from "../../lib/signedIn";
import type { UnitBasis } from "../../lib/workActivity/protocol";
import type { UnitFactSnapshot } from "../../lib/workUnitObservations/model";
import { SelectedJobUnitDimensions, type SelectedJobUnitDimensionsProps } from "./SelectedJobUnitDimensions";

const fetchFact=vi.fn();
vi.mock("../../lib/workUnitObservations/api",()=>({fetchUnitFactSnapshot:(...args:unknown[])=>fetchFact(...args)}));
(globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,"0")}`;
const OWNER=id(1),JOB=id(2),UNIT=id(3),OPENING=id(4),FACT=id(5);
const unit:WorkUnit={id:UNIT,project_id:JOB,opening_id:OPENING,created_by:OWNER,label:"Window 12",type_label:"Window",revision:5,created_at:"2026-10-04T00:00:00Z",updated_at:"2026-10-04T00:00:00Z",facts:{width_in:12,height_in:24,material:"Aluminum"}};
const projection:UnitBasis={id:UNIT,projectId:JOB,openingId:OPENING,operationalRevision:5,incarnationEpoch:1,bindingEpoch:1,projectEpoch:1,openingEpoch:1,
  fact:{id:FACT,revision:4,eventKind:"legacy_observation",originProjectEpoch:1,originOpeningEpoch:1,dimensions:{widthIn:12,heightIn:24,source:"plans",original:null},estimated:null},eligibleForCapture:false,ineligibleReason:"missing_observation"};
const snapshot:UnitFactSnapshot={unitId:UNIT,revision:4,eventKind:"legacy_observation",observation:null,widthIn:12,heightIn:24,observationActorId:null,recordedAt:"2026-10-04T00:00:00Z"};
const save=vi.fn<(_data:Readonly<Record<string,unknown>>)=>Promise<void>>(),refreshUnits=vi.fn<()=>Promise<void>>(),refreshActivity=vi.fn<()=>Promise<void>>();
let host:HTMLDivElement,root:Root,qc:QueryClient,props:SelectedJobUnitDimensionsProps,connected=true;
async function render(changes:Partial<SelectedJobUnitDimensionsProps>={}) { props={...props,...changes};await act(async()=>{root.render(<QueryClientProvider client={qc}><SelectedJobUnitDimensions {...props}/></QueryClientProvider>);await new Promise(r=>setTimeout(r,10));}); }
async function flush(){await act(async()=>{await new Promise(r=>setTimeout(r,10));});}
function button(label:string){const b=[...host.querySelectorAll("button")].find(x=>x.textContent?.trim()===label);expect(b,label).toBeTruthy();return b!;}
async function click(label:string){await act(async()=>button(label).click());}
async function field(label:string,value:string){const input=[...host.querySelectorAll("label")].find(x=>x.textContent?.includes(label))?.querySelector("input,select") as HTMLInputElement|HTMLSelectElement;expect(input,label).toBeTruthy();await act(async()=>{Object.getOwnPropertyDescriptor(input instanceof HTMLSelectElement?HTMLSelectElement.prototype:HTMLInputElement.prototype,"value")!.set!.call(input,value);input.dispatchEvent(new Event("input",{bubbles:true}));input.dispatchEvent(new Event("change",{bubbles:true}));});}
async function fill(){await click("Enter dimensions");await field("Width","2");await field("Height","3");await field("Dimension source","measured");}
beforeEach(()=>{connected=true;onlineManager.setOnline(true);Object.defineProperty(navigator,"onLine",{configurable:true,get:()=>connected});rememberSignedIn({user:{id:OWNER}});fetchFact.mockReset().mockResolvedValue(snapshot);save.mockReset().mockResolvedValue();refreshUnits.mockReset().mockResolvedValue();refreshActivity.mockReset().mockResolvedValue();qc=new QueryClient({defaultOptions:{queries:{retry:false}}});host=document.createElement("div");document.body.append(host);root=createRoot(host);props={projectId:JOB,selectedUnitId:UNIT,units:[unit],unitSourceState:"ready",unitBasis:projection,enabled:true,canEditDimensions:true,pendingUnitIds:[],onSave:save,onRefreshUnits:refreshUnits,onRefreshActivity:refreshActivity};});
afterEach(()=>{act(()=>root.unmount());qc.clear();host.remove();rememberSignedIn(null);onlineManager.setOnline(true);delete (navigator as unknown as {onLine?:boolean}).onLine;});

describe("selected-job unit dimensions adapter",()=>{
  it("uses the private fact read and sends exactly one canonical frozen unit edit",async()=>{
    await render();await flush();await fill();await click("Save dimension request");expect(save).toHaveBeenCalledOnce();
    expect(save.mock.calls[0][0]).toMatchObject({id:UNIT,project_id:JOB,opening_id:OPENING,revision:5,expected_fact_revision:4,dimension_observation:{width:2,height:3,unit:"in",source:"measured"},facts:{material:"Aluminum"}});
    expect(Object.isFrozen(save.mock.calls[0][0])).toBe(true);
    expect(host.textContent).toContain("Save request stored");expect(host.textContent).toContain("pending or unresolved");
    expect(button("Save dimension request").hasAttribute("disabled")).toBe(true);
  });
  it("refuses cross-project, opening, operational or fact revision mismatches",async()=>{
    for(const basis of [{...projection,projectId:id(9)},{...projection,openingId:null},{...projection,operationalRevision:6},{...projection,fact:{...projection.fact!,revision:3}}]){
      await render({unitBasis:basis});await flush();expect(host.textContent).toContain("unavailable");
      expect([...host.querySelectorAll("button")].some(x=>x.textContent?.trim()==="Enter dimensions")).toBe(false);
    }
    expect(save).not.toHaveBeenCalled();
  });
  it("blocks edits for a pending canonical unit and for source-unavailable permissions",async()=>{
    await render({pendingUnitIds:[UNIT]});await flush();expect(button("Enter dimensions").hasAttribute("disabled")).toBe(true);
    expect(host.textContent).toContain("A request for this unit is pending. Its result is not confirmed.");
    await render({pendingUnitIds:[],canEditDimensions:false});expect([...host.querySelectorAll("button")].some(x=>x.textContent?.trim()==="Enter dimensions")).toBe(false);
    await render({canEditDimensions:true,unitSourceState:"unavailable"});expect(host.textContent).toContain("unavailable");expect(save).not.toHaveBeenCalled();
  });
  it("hides private unit and fact details on preview disable, offline, logout and navigation",async()=>{
    await render();await flush();expect(host.textContent).toContain("Legacy dimensions");await render({enabled:false});
    expect(host.textContent).not.toContain("Legacy dimensions");expect(host.textContent).not.toContain("Window 12");
    await render({enabled:true});await act(async()=>{connected=false;window.dispatchEvent(new Event("offline"));});await flush();
    expect(host.textContent).not.toContain("Legacy dimensions");
    await act(async()=>rememberSignedIn(null));expect(host.textContent).not.toContain("Legacy dimensions");
    await act(async()=>{rememberSignedIn({user:{id:OWNER}});connected=true;window.dispatchEvent(new Event("online"));});await render({selectedUnitId:id(8)});
    expect(host.textContent).not.toContain("Legacy dimensions");
  });
  it("keeps uncertain save locked after queue absence, and only releases on two newer matching revisions",async()=>{
    let fail!:(e:Error)=>void;save.mockImplementation(()=>new Promise((_,no)=>{fail=no;}));
    await render();await flush();await fill();await act(async()=>button("Save dimension request").click());
    await act(async()=>fail(Error("lost reply")));expect(host.textContent).toContain("may have been saved");
    await render({pendingUnitIds:[]});expect(button("Save dimension request").hasAttribute("disabled")).toBe(true);
    fetchFact.mockResolvedValue({...snapshot,revision:5});
    await render({unitBasis:{...projection,operationalRevision:6,fact:{...projection.fact!,revision:5}},units:[{...unit,revision:6}]});
    await click("Refresh current unit");await flush();
    expect(refreshUnits).toHaveBeenCalled();expect(refreshActivity).toHaveBeenCalled();
    expect(host.textContent).toContain("Unit facts changed");
    await click("Start new edit from current facts");expect(button("Save dimension request").hasAttribute("disabled")).toBe(false);
  });
  it("does not revive a late save result after same-owner ABA",async()=>{
    let resolve!:()=>void;save.mockImplementation(()=>new Promise(done=>{resolve=done;}));
    await render();await flush();await fill();await act(async()=>button("Save dimension request").click());
    await act(async()=>{rememberSignedIn(null);rememberSignedIn({user:{id:OWNER}});});await flush();
    await act(async()=>resolve());expect(host.textContent).not.toContain("Save request stored");
  });
});
