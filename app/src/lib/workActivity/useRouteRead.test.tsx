// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { rememberSignedIn } from "../signedIn";
import { useRouteRead } from "./useRouteRead";
const session=vi.hoisted(()=>({owner:"u1"}));
vi.mock("../supabase",()=>({supabase:{auth:{getSession:async()=>({data:{session:{user:{id:session.owner},access_token:"fixture"}},error:null})}}}));
(globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
let host:HTMLDivElement,root:Root,latest:ReturnType<typeof useRouteRead<string>>,enabled=true;
let request:()=>Promise<string>;
function Harness({resource}:{resource:string}){latest=useRouteRead(resource,enabled,request);return null;}
async function render(resource="jobs"){await act(async()=>{root.render(<Harness resource={resource}/>);await Promise.resolve();});}
async function flush(){await act(async()=>{await new Promise(r=>setTimeout(r,5));});}
beforeEach(()=>{enabled=true;session.owner="u1";rememberSignedIn({user:{id:"u1"}});Object.defineProperty(navigator,"onLine",{configurable:true,value:true});host=document.createElement("div");root=createRoot(host);request=async()=>"original";});
afterEach(()=>{act(()=>root.unmount());rememberSignedIn(null);});
it("never republishes a prior resource's late result",async()=>{let settle!:(v:string)=>void;request=()=>new Promise(r=>{settle=r;});await render();const old=settle;await render("units:other");await act(async()=>old("private old job"));expect(latest.data).toBeUndefined();await act(async()=>settle("correct units"));expect(latest.data).toBe("correct units");});
it("loses authority on login ABA even if the same owner returns",async()=>{let settle!:(v:string)=>void;request=()=>new Promise(r=>{settle=r;});await render();const old=settle;await act(async()=>{rememberSignedIn(null);rememberSignedIn({user:{id:"u1"}});});await act(async()=>old("prior-login"));expect(latest.data).toBeUndefined();});
it("does not accept another authenticated session's rows",async()=>{session.owner="u2";await render();await flush();expect(latest.state).toBe("unavailable");expect(latest.data).toBeUndefined();});
it("does not revive a previously ready response on reconnect",async()=>{await render();await flush();expect(latest.data).toBe("original");request=()=>new Promise(()=>{});Object.defineProperty(navigator,"onLine",{configurable:true,value:false});await act(async()=>window.dispatchEvent(new Event("offline")));expect(latest.data).toBeUndefined();Object.defineProperty(navigator,"onLine",{configurable:true,value:true});await act(async()=>window.dispatchEvent(new Event("online")));expect(latest.data).toBeUndefined();});
it("unmount discards in-flight reads rather than populating a shared cache",async()=>{let settle!:(v:string)=>void;request=()=>new Promise(r=>{settle=r;});await render();await act(async()=>root.render(null));await act(async()=>settle("late"));request=async()=>"new mount";await render();await flush();expect(latest.data).toBe("new mount");});
