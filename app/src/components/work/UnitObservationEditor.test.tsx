// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkUnit } from "../../lib/customWork/model";
import { rememberSignedIn } from "../../lib/signedIn";
import type { UnitFactSnapshot } from "../../lib/workUnitObservations/model";
import { UnitObservationEditor, type UnitObservationEditorProps } from "./UnitObservationEditor";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const OWNER="00000000-0000-4000-8000-000000000003", UNIT="00000000-0000-4000-8000-000000000001", JOB="00000000-0000-4000-8000-000000000002";
const unit:WorkUnit={id:UNIT,project_id:JOB,opening_id:null,created_by:OWNER,label:"Window 12",type_label:"Window",revision:5,created_at:"2026-10-03T00:00:00Z",updated_at:"2026-10-03T00:00:00Z",facts:{width_in:12,height_in:24,measurement_source:"Old",material:"Aluminum",note:"Keep"}};
const basis:UnitFactSnapshot={unitId:UNIT,revision:4,eventKind:"legacy_observation",observation:null,widthIn:12,heightIn:24,observationActorId:null,recordedAt:"2026-10-03T00:00:00Z"};
let host:HTMLDivElement, root:Root, props:UnitObservationEditorProps;
const save=vi.fn<(_data:Readonly<Record<string,unknown>>)=>Promise<void>>();
const refresh=vi.fn<()=>Promise<void>>();
async function render(changes:Partial<UnitObservationEditorProps>={}) { props={...props,...changes}; await act(async()=>root.render(<UnitObservationEditor {...props}/>)); }
function button(label:string) { const b=[...host.querySelectorAll("button")].find(x=>x.textContent?.trim()===label); expect(b,label).toBeTruthy(); return b!; }
async function click(label:string) { await act(async()=>button(label).click()); }
async function field(label:string,value:string) {
  const input=[...host.querySelectorAll("label")].find(x=>x.textContent?.includes(label))?.querySelector("input,select") as HTMLInputElement|HTMLSelectElement|undefined;
  expect(input,label).toBeTruthy();
  await act(async()=>{const setter=Object.getOwnPropertyDescriptor(input instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype,"value")!.set!;setter.call(input,value);input!.dispatchEvent(new Event("input",{bubbles:true}));input!.dispatchEvent(new Event("change",{bubbles:true}));});
}
async function openFilled() { await click("Enter dimensions"); await field("Width","2.5"); await field("Height","3"); await field("Dimension source","plans"); await field("Source reference","Sheet A-4"); }
beforeEach(()=>{rememberSignedIn({user:{id:OWNER}});host=document.createElement("div");document.body.append(host);root=createRoot(host);save.mockReset().mockResolvedValue();refresh.mockReset().mockResolvedValue();props={projectId:JOB,unit,currentFactSnapshot:basis,sourceState:"ready",enabled:true,onSave:save,onRefresh:refresh};});
afterEach(()=>{act(()=>root.unmount());host.remove();rememberSignedIn(null);});

describe("unit observation editor",()=>{
  it("keeps an explicit original observation and unrelated facts in one frozen canonical payload",async()=>{
    await render();expect(host.textContent).toContain("Legacy dimensions are not a verified source");
    await openFilled();await field("Measurement unit","ft");await click("Save dimension request");
    expect(save).toHaveBeenCalledOnce();
    const data=save.mock.calls[0][0];
    expect(data).toMatchObject({id:UNIT,project_id:JOB,revision:5,expected_fact_revision:4,dimension_observation:{width:2.5,height:3,unit:"ft",source:"plans",sourceReference:"Sheet A-4"},facts:{material:"Aluminum",note:"Keep"}});
    expect(data.facts).not.toHaveProperty("width_in");expect(Object.isFrozen(data)).toBe(true);
    expect(host.textContent).toContain("Save request stored");expect(host.textContent).toContain("server confirmation is pending");
    expect(host.textContent).not.toContain("Verified");
  });
  it("refuses empty, zero, negative, absent source and over-500 Unicode reference before callback",async()=>{
    await render();await click("Enter dimensions");await click("Save dimension request");expect(save).not.toHaveBeenCalled();
    await field("Width","0");await field("Height","-2");await click("Save dimension request");expect(save).not.toHaveBeenCalled();
    await field("Width","2");await field("Height","3");await field("Dimension source","estimated");
    expect(host.textContent).toContain("excluded from trusted averages");
    await field("Dimension source","unknown");await click("Save dimension request");expect(save).not.toHaveBeenCalled();
    await field("Dimension source","estimated");
    await field("Source reference","😀".repeat(501));await click("Save dimension request");expect(save).not.toHaveBeenCalled();
    await field("Source reference","😀".repeat(500));await click("Save dimension request");expect(save).toHaveBeenCalledOnce();
    expect((save.mock.calls[0][0].dimension_observation as Record<string,unknown>).source).toBe("estimated");
  });
  it("rejects mismatched or changed source basis under an open edit",async()=>{
    await render({currentFactSnapshot:{...basis,unitId:JOB}});expect(host.textContent).toContain("unavailable");
    expect([...host.querySelectorAll("button")].some(x=>x.textContent?.trim()==="Enter dimensions")).toBe(false);
  });
  it("holds the original revision if a fresh read advances while editing",async()=>{
    await render();await openFilled();await render({currentFactSnapshot:{...basis,revision:5}});
    expect(host.textContent).toContain("Unit facts changed");await click("Save dimension request");expect(save).not.toHaveBeenCalled();
  });
  it("shows a recorded original read-only without implying verification or opening an edit",async()=>{
    const recorded:UnitFactSnapshot={...basis,eventKind:"observation",observation:{width:1200,height:900,unit:"mm",source:"estimated",sourceReference:"Field note",estimated:true},widthIn:1200/25.4,heightIn:900/25.4,observationActorId:OWNER};
    await render({currentFactSnapshot:recorded,readOnly:true});
    expect(host.textContent).toContain("1200 × 900 mm");expect(host.textContent).toContain("Field note");expect(host.textContent).toContain("Estimate — not verified");
    expect([...host.querySelectorAll("button")].some(x=>x.textContent?.trim()==="Enter dimensions")).toBe(false);
  });
  it("serializes rapid taps and treats a lost callback reply as possibly saved",async()=>{
    let reject!: (error:Error)=>void;
    save.mockImplementation(()=>new Promise((_,fail)=>{reject=fail;}));
    await render();await openFilled();await act(async()=>{button("Save dimension request").click();button("Save dimension request").click();});
    expect(save).toHaveBeenCalledOnce();expect(host.textContent).toContain("Saving the request");
    await act(async()=>reject(new Error("network reply lost")));
    expect(host.textContent).toContain("may have been saved");
    expect(button("Cancel").hasAttribute("disabled")).toBe(true);
    await click("Save dimension request");expect(save).toHaveBeenCalledOnce();
    await click("Refresh current unit");expect(refresh).toHaveBeenCalledOnce();
    expect(button("Save dimension request").hasAttribute("disabled")).toBe(true);
  });
  it("settles an in-flight save truthfully when a fresh fact revision appears first",async()=>{
    let resolve!:()=>void;save.mockImplementation(()=>new Promise(done=>{resolve=done;}));
    await render();await openFilled();await act(async()=>button("Save dimension request").click());
    await render({currentFactSnapshot:{...basis,revision:5}});
    await act(async()=>resolve());
    expect(host.textContent).toContain("Save request stored");
    expect(host.textContent).not.toContain("Saving the request");
    expect(button("Save dimension request").hasAttribute("disabled")).toBe(true);
  });
  it("clears private draft and ignores late success on logout, ABA, and unit navigation",async()=>{
    let resolve!:()=>void;save.mockImplementation(()=>new Promise(done=>{resolve=done;}));
    await render();await openFilled();await act(async()=>button("Save dimension request").click());
    await act(async()=>rememberSignedIn(null));expect(host.textContent).toContain("Sign in");expect(host.textContent).not.toContain("Sheet A-4");
    await act(async()=>rememberSignedIn({user:{id:OWNER}}));expect(host.textContent).not.toContain("Sheet A-4");
    await act(async()=>resolve());expect(host.textContent).not.toContain("Save request stored");
    await openFilled();await render({unit:{...unit,id:"00000000-0000-4000-8000-000000000004"}});
    expect(host.textContent).not.toContain("Sheet A-4");expect(host.textContent).toContain("unavailable");
  });
});
