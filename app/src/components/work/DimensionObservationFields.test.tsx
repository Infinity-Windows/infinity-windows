// @vitest-environment happy-dom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LanguageContext } from "../../lib/i18n/context";
import { CATALOG } from "../../lib/i18n/catalog";
import { translate, type Lang } from "../../lib/i18n/translate";
import type { DimensionDraft } from "../../lib/workUnitObservations/model";
import { DimensionObservationFields } from "./DimensionObservationFields";
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT=true;
let host:HTMLDivElement,root:Root,last:DimensionDraft;
const initial:DimensionDraft={width:"",height:"",unit:"in",source:"",reference:""};
function Harness({lang="en",disabled=false,invalid=false}:{lang?:Lang;disabled?:boolean;invalid?:boolean}){
  const [draft,setDraft]=useState(initial);last=draft;
  return <LanguageContext.Provider value={{lang,t:(key,vars)=>translate(CATALOG,lang,key,vars),setLang:()=>{},needsChoice:false}}><DimensionObservationFields value={draft} onChange={setDraft} disabled={disabled} invalid={invalid}/></LanguageContext.Provider>;
}
async function render(props:Parameters<typeof Harness>[0]={}){await act(async()=>root.render(<Harness {...props}/>));}
async function input(index:number,value:string){const node=host.querySelectorAll("input")[index];await act(async()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value")!.set!.call(node,value);node.dispatchEvent(new Event("input",{bubbles:true}));});}
async function select(index:number,value:string){const node=host.querySelectorAll("select")[index];await act(async()=>{node.value=value;node.dispatchEvent(new Event("change",{bubbles:true}));});}
beforeEach(()=>{host=document.createElement("div");document.body.append(host);root=createRoot(host);});
afterEach(()=>{act(()=>root.unmount());host.remove();});
describe("original dimension controls",()=>{
  it("keeps partial typed decimals across unit, source and language changes",async()=>{
    await render();await input(0,"12.");await input(1,".75");await input(2,"Sheet A4");await select(0,"ft");await select(1,"plans");await render({lang:"es"});
    expect(last).toEqual({width:"12.",height:".75",reference:"Sheet A4",unit:"ft",source:"plans"});
    expect(host.textContent).toContain("Dimensiones de la unidad");expect(host.querySelectorAll("input")[0].value).toBe("12.");
  });
  it("requires deliberate source selection and keeps original positive-entry controls",async()=>{
    await render();expect(host.querySelectorAll("select")[1].value).toBe("");expect(host.querySelectorAll("select")[1].required).toBe(true);
    for(const node of [...host.querySelectorAll("input")].slice(0,2)){expect(node.required).toBe(true);expect(node.inputMode).toBe("decimal");}
    expect(host.querySelector("button")).toBeNull();
  });
  it("flags an estimate in both languages without an approval badge",async()=>{
    await render();await select(1,"estimated");expect(host.textContent).toContain("excluded from trusted averages until verified");await render({lang:"es"});expect(host.textContent).toContain("se excluye de los promedios verificados");expect(host.textContent).not.toContain("QC approved");
  });
  it("permits the documented 500 four-byte-character reference and preserves it",async()=>{
    await render();await input(2,"😀".repeat(500));expect(last.reference).toBe("😀".repeat(500));expect(host.querySelectorAll("input")[2].maxLength).toBe(1000);
  });
  it("announces invalid input and disables the entire draft while saving",async()=>{
    await render({invalid:true,disabled:true});expect(host.querySelector("fieldset")?.disabled).toBe(true);expect(host.querySelector('[role="alert"]')?.textContent).toContain("positive decimal dimensions");expect(host.querySelector("fieldset")?.getAttribute("aria-describedby")).toContain(host.querySelector('[role="alert"]')!.id);
  });
});
