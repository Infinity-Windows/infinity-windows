// @vitest-environment happy-dom
import { act } from "react";
import { createRoot,type Root } from "react-dom/client";
import { QueryClient,QueryClientProvider } from "@tanstack/react-query";
import { afterEach,beforeEach,describe,expect,it,vi } from "vitest";
import { rememberSignedIn } from "../signedIn";
import { ViewAsRoleContext,createSensitivePreviewLifetime } from "../viewAsRoleContext";
import { createUnitReviewSelectionSource } from "../workUnitReview/useUnitReviewCoordinator";
import { useActivityTotals } from "./useActivityTotals";
import { parseTotalsReply } from "./protocol";
import corpus from "./__fixtures__/sourceMatchedWire.json";
const fetch=vi.hoisted(()=>vi.fn());vi.mock("./api",()=>({fetchActivityTotals:fetch}));
(globalThis as {IS_REACT_ACT_ENVIRONMENT?:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
const raw=corpus.calls[0].result,t=raw.totals!,OWNER=t.actorId,PROJECT=t.projectId;
let root:Root,host:HTMLDivElement,qc:QueryClient,source:ReturnType<typeof createUnitReviewSelectionSource>,preview:ReturnType<typeof createSensitivePreviewLifetime>,allowed:boolean;
let result:ReturnType<typeof useActivityTotals>;let unitId:string|null=null;
const parent=()=>allowed;
function Reader(){result=useActivityTotals(PROJECT,unitId,source,parent);return <div>{result.data?.actorId??"hidden"}</div>;}
async function render(){await act(async()=>{root.render(<QueryClientProvider client={qc}><ViewAsRoleContext.Provider value={{previewRole:null,previewPerson:null,canPreview:false,canPreviewPerson:false,setPreviewRole:()=>{},setPreviewPerson:()=>{},sensitiveLifetime:preview}}><Reader/></ViewAsRoleContext.Provider></QueryClientProvider>);});}
function held<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(done=>{resolve=done;});return {promise,resolve};}
beforeEach(()=>{
 rememberSignedIn({user:{id:OWNER}});allowed=true;unitId=null;source=createUnitReviewSelectionSource();qc=new QueryClient({defaultOptions:{queries:{retry:false}}});qc.setQueryData(["myRealProfile"],{id:OWNER,role:"installer",retired_at:null});
 preview=createSensitivePreviewLifetime(()=>{const s=qc.getQueryState<{id:string;role:string}>(["myRealProfile"]);return {stamp:JSON.stringify([s?.dataUpdateCount,s?.status,s?.isInvalidated]),ownerId:s?.data?.id??null,role:s?.data?.role??null,ready:s?.status==="success"&&!s.isInvalidated};},false);
 fetch.mockReset().mockResolvedValue(parseTotalsReply(raw,PROJECT,null,OWNER));host=document.createElement("div");document.body.append(host);root=createRoot(host);
});
afterEach(()=>{act(()=>root.unmount());qc.clear();host.remove();rememberSignedIn(null);vi.useRealTimers();});
describe("ephemeral lifetime-bound totals",()=>{
 it("shows fresh exact totals without an offline/query cache fallback",async()=>{await render();expect(result.data).toEqual(t);expect(qc.getQueryCache().findAll().length).toBe(1);expect(fetch).toHaveBeenCalledOnce();});
 it("drops a held reply across synchronous source ABA",async()=>{const response=held<ReturnType<typeof parseTotalsReply>>();fetch.mockReturnValueOnce(response.promise).mockResolvedValue({protocolVersion:1,availability:"unavailable",totals:null});await render();act(()=>{source.invalidate();source.invalidate();});await act(async()=>response.resolve(parseTotalsReply(raw,PROJECT,null,OWNER)));expect(result.data).toBeNull();});
 it("checks live parent admission at the final await",async()=>{const response=held<ReturnType<typeof parseTotalsReply>>();fetch.mockReturnValueOnce(response.promise);await render();allowed=false;await act(async()=>response.resolve(parseTotalsReply(raw,PROJECT,null,OWNER)));expect(result.data).toBeNull();});
 it("preview ABA hides evidence and makes old refresh inert",async()=>{await render();const old=result;act(()=>{preview.previewChanged(true);preview.previewChanged(false);});await act(async()=>{});const reads=fetch.mock.calls.length;act(()=>old.refresh());expect(fetch.mock.calls.length).toBe(reads);});
 it("never treats unavailable as zero",async()=>{fetch.mockResolvedValue({protocolVersion:1,availability:"unavailable",totals:null});await render();expect(result.state).toBe("unavailable");expect(result.data).toBeNull();});
 it("requires a fresh own profile and does not reopen from stale profile data",async()=>{await render();act(()=>{void qc.invalidateQueries({queryKey:["myRealProfile"],refetchType:"none"});});await act(async()=>{});expect(result.data).toBeNull();expect(fetch).toHaveBeenCalledOnce();act(()=>{qc.setQueryData(["myRealProfile"],{id:OWNER,role:"installer",retired_at:null});});await act(async()=>{});expect(result.data).not.toBeNull();expect(fetch).toHaveBeenCalledTimes(2);});
 it("rejects another owner's or retired profile even with a role",async()=>{qc.setQueryData(["myRealProfile"],{id:"00000000-0000-4000-8000-000000250099",role:"installer",retired_at:null});await render();expect(fetch).not.toHaveBeenCalled();qc.setQueryData(["myRealProfile"],{id:OWNER,role:"installer",retired_at:"2026-10-04T00:00:00Z"});await render();expect(fetch).not.toHaveBeenCalled();expect(result.data).toBeNull();});
 it("expires rendered evidence without sending anything",async()=>{vi.useFakeTimers({toFake:["setTimeout","clearTimeout","setInterval","clearInterval"]});await render();expect(result.data).not.toBeNull();act(()=>vi.advanceTimersByTime(30002));expect(result.data).toBeNull();expect(fetch).toHaveBeenCalledOnce();});
 it("changes resources without displaying the prior unit data",async()=>{await render();unitId="00000000-0000-4000-8000-000000250030";fetch.mockResolvedValue({protocolVersion:1,availability:"unavailable",totals:null});await render();expect(result.data).toBeNull();});
 it("offline and background clear evidence before another check",async()=>{await render();Object.defineProperty(window.navigator,"onLine",{value:false,configurable:true});act(()=>window.dispatchEvent(new Event("offline")));expect(result.data).toBeNull();Object.defineProperty(window.navigator,"onLine",{value:true,configurable:true});act(()=>window.dispatchEvent(new Event("online")));await act(async()=>{});act(()=>window.dispatchEvent(new Event("pagehide")));expect(result.data).toBeNull();act(()=>window.dispatchEvent(new Event("pageshow")));});
});
