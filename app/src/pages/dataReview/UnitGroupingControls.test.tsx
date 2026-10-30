// @vitest-environment happy-dom
import {act,useState} from "react";
import {createRoot} from "react-dom/client";
import {it,expect} from "vitest";
import {UnitGroupingControls} from "./UnitGroupingControls";
it("toggles options and group lips and reorders with the keyboard",async()=>{
 Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});
 const host=document.createElement("div"),root=createRoot(host);
 function Test(){const [order,setOrder]=useState(["job","floor"]),[groups,setGroups]=useState(["job"]),[filters,setFilters]=useState<Record<string,string[]|null>>({});return <><UnitGroupingControls dimensions={order.map(key=>({key,label:key,options:[{key:"a",label:"A"},{key:"b",label:"B"}]}))} groups={groups} filters={filters} onOrder={setOrder} onGroups={setGroups} onFilters={(key,next)=>setFilters({...filters,[key]:next})}/><output>{JSON.stringify({order,groups,filters})}</output></>}
 try{await act(async()=>root.render(<Test/>));
 expect(host.querySelector('[aria-label="Group units by job"]')?.getAttribute("aria-pressed")).toBe("true");
 await act(async()=>host.querySelector<HTMLInputElement>('.report-multi-options input[type="checkbox"]')!.click());
 expect(host.querySelector("output")!.textContent).toContain('"job":["a"]');
 await act(async()=>host.querySelector<HTMLButtonElement>('[aria-label="Group units by floor"]')!.click());
 expect(host.querySelector("output")!.textContent).toContain('"groups":["job","floor"]');
 await act(async()=>host.querySelector('[aria-label="Group units by floor"]')!.dispatchEvent(new KeyboardEvent("keydown",{key:"ArrowLeft",bubbles:true})));
 expect(host.querySelector("output")!.textContent).toContain('"order":["floor","job"]');
 }finally{await act(async()=>root.unmount());}
});
