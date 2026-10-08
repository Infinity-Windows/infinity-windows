// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { DesignContext } from "../../lib/design/context";
const state = vi.hoisted(()=>({authorized:false}));
vi.mock("../../lib/paidClock/ClockFlowBridge",()=>({get PAID_SETUP_RELEASE_AUTHORIZED(){return state.authorized;}}));
vi.mock("./SelectedJobWorkRoute",()=>({SelectedJobWorkRoute:()=> <div data-testid="real-route"/>}));
import Entry from "./SelectedJobWorkEntry";
(globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
describe("production Work entry gates",()=>{
  it.each([[false,"new",false],[true,"classic",false],[true,"new",true]] as const)("release=%s design=%s mounts route=%s",async(authorized,design,mounts)=>{
    state.authorized=authorized;const host=document.createElement("div"),root=createRoot(host);
    try {await act(async()=>root.render(<DesignContext.Provider value={{design,choice:design,masterOn:true,setChoice:()=>{}}}><Entry fallback={<div data-testid="legacy"/>}/></DesignContext.Provider>));
      expect(!!host.querySelector('[data-testid="real-route"]')).toBe(mounts);
      expect(!!host.querySelector('[data-testid="legacy"]')).toBe(!mounts);
    } finally {act(()=>root.unmount());}
  });
});
