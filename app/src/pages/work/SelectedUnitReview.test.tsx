// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rememberSignedIn, signInMark } from "../../lib/signedIn";
import { createUnitReviewSelectionSource } from "../../lib/workUnitReview/useUnitReviewCoordinator";
import { SelectedUnitReview, type SelectedUnitReviewProps } from "./SelectedUnitReview";
vi.mock("../../components/work/UnitReviewPanel",()=>({UnitReviewPanel:()=> <div>Review panel fixture</div>}));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const OWNER="00000000-0000-4000-8000-000000250001", PROJECT="00000000-0000-4000-8000-000000250010", UNIT="00000000-0000-4000-8000-000000250020";
let root:Root,host:HTMLDivElement,qc:QueryClient,source:ReturnType<typeof createUnitReviewSelectionSource>,admitted:boolean;
const basis={id:UNIT,projectId:PROJECT,openingId:null,operationalRevision:1,incarnationEpoch:1,bindingEpoch:1,projectEpoch:1,openingEpoch:null,fact:null,eligibleForCapture:false,ineligibleReason:"missing_observation"};
let started:number;
const keys=()=>({unit:["workActivityPrivate",OWNER,signInMark().generation,"unit",UNIT],catalog:["workActivityPrivate",OWNER,signInMark().generation,"catalog",PROJECT,UNIT]});
const parentAdmission=()=>admitted;
async function render(changes: Partial<SelectedUnitReviewProps> = {}){await act(async()=>{root.render(<QueryClientProvider client={qc}><SelectedUnitReview source={source} login={signInMark()} projectId={PROJECT} unitId={UNIT} admitted={parentAdmission} unitRequestStartedAt={started} catalogRequestStartedAt={started} onRefresh={async()=>{}} locale="en" {...changes} /></QueryClientProvider>);});}
beforeEach(()=>{
 rememberSignedIn({user:{id:OWNER}});admitted=true;started=performance.now();qc=new QueryClient({defaultOptions:{queries:{retry:false}}});source=createUnitReviewSelectionSource();
 qc.setQueryData(["myRealProfile"],{id:OWNER,role:"foreman",retired_at:null});
 qc.setQueryData(keys().unit,{status:"ready",requestStartedAt:started,login:signInMark(),value:{availability:"available",unit:basis}});
 qc.setQueryData(keys().catalog,{status:"ready",requestStartedAt:started,login:signInMark(),value:{availability:"available",projectId:PROJECT,unit:basis}});
 host=document.createElement("div");document.body.append(host);root=createRoot(host);
});
afterEach(()=>{act(()=>root.unmount());qc.clear();host.remove();rememberSignedIn(null);vi.useRealTimers();});
describe("actual selected unit review binding",()=>{
 it("admits fresh exact source with missing dimensions without promoting capture eligibility",async()=>{
  await render();const selected=source.getSnapshot().selection;expect(selected?.binding).toEqual({unitId:UNIT,projectId:PROJECT});expect(selected?.admitted()).toBe(true);
 });
 it.each(["wrong job","conflicting epoch","stale","foreign login","invalidated profile"])("holds %s before review opens",async kind=>{
  if(kind==="stale")started-=30001;
  if(kind==="foreign login")qc.setQueryData(keys().unit,(old:Record<string,unknown>)=>({...old,login:{userId:UNIT,generation:signInMark().generation}}));
  if(kind==="wrong job"||kind==="conflicting epoch")qc.setQueryData(keys().catalog,(old:Record<string,unknown>)=>({...old,value:{availability:"available",projectId:PROJECT,unit:{...basis,...(kind==="wrong job"?{projectId:UNIT}:{bindingEpoch:2})}}}));
  if(kind==="invalidated profile")await qc.invalidateQueries({queryKey:["myRealProfile"]});
  await render();expect(source.getSnapshot().selection).toBeNull();
 });
 it("invalidates synchronously on source ABA even when final data is byte-equal",async()=>{
  await render();const old=source.getSnapshot().selection!;const row=qc.getQueryData(keys().unit);
  act(()=>{qc.setQueryData(keys().unit,{status:"unavailable"});qc.setQueryData(keys().unit,row);});
  expect(source.getSnapshot().selection).toBeNull();expect(old.admitted()).toBe(false);
 });
 it("blocks held callbacks at final admission on parent selection loss",async()=>{
  await render();const old=source.getSnapshot().selection!;admitted=false;expect(old.admitted()).toBe(false);
 });
 it("browser back immediately invalidates the source",async()=>{
  await render();const first=source.getSnapshot().selection!;
  act(()=>window.dispatchEvent(new PopStateEvent("popstate")));expect(source.getSnapshot().selection).toBeNull();expect(first.admitted()).toBe(false);
 });
 it("source deadline invalidates without a second click or polling",async()=>{
  vi.useFakeTimers({toFake:["setTimeout","clearTimeout"]});await render();const first=source.getSnapshot().selection!;
  expect(first).not.toBeNull();act(()=>vi.advanceTimersByTime(30002));expect(source.getSnapshot().selection).toBeNull();expect(first.admitted()).toBe(false);
 });
 it("refresh closes the old source before its callback runs",async()=>{
  await render();const button=host.querySelector("button")!;act(()=>button.click());expect(source.getSnapshot().selection).toBeNull();
 });
 it("unmount cannot revive the old callback after same-ID return",async()=>{
  await render();const old=source.getSnapshot().selection!;act(()=>root.render(<div/>));expect(old.admitted()).toBe(false);await render();expect(old.admitted()).toBe(false);
 });
 it("opens when a cold real profile succeeds and never revives old profile callbacks",async()=>{
  qc.removeQueries({queryKey:["myRealProfile"]});await render();expect(source.getSnapshot().selection).toBeNull();
  await act(async()=>qc.setQueryData(["myRealProfile"],{id:OWNER,role:"foreman",retired_at:null}));
  const first=source.getSnapshot().selection!;expect(first.admitted()).toBe(true);
  await act(async()=>{void qc.invalidateQueries({queryKey:["myRealProfile"]});expect(source.getSnapshot().selection).toBeNull();});
  expect(first.admitted()).toBe(false);
  await act(async()=>qc.setQueryData(["myRealProfile"],{id:OWNER,role:"foreman",retired_at:null}));
  expect(source.getSnapshot().selection?.admitted()).toBe(true);expect(first.admitted()).toBe(false);
 });
 it("keeps the source lifetime through inline callback re-renders, but reads the newest committed authority",async()=>{
  await render({admitted:()=>true});const first=source.getSnapshot();
  await render({admitted:()=>true,onRefresh:async()=>{}});expect(source.getSnapshot()).toBe(first);
  await render({admitted:()=>false});expect(first.selection!.admitted()).toBe(false);
 });
 it("catches refresh failure and cannot publish an old refresh failure after selection closes",async()=>{
  await render({onRefresh:async()=>{throw Error("private error");}});await act(async()=>host.querySelector("button")!.click());
  expect(host.textContent).toContain("Unit details could not refresh");expect(host.textContent).not.toContain("private error");
  let fail!:(error:Error)=>void;await render({onRefresh:()=>new Promise<void>((_,reject)=>{fail=reject;})});
  await act(async()=>host.querySelector("button")!.click());await render({unitId:PROJECT});
  await act(async()=>fail(Error("late")));expect(host.textContent).not.toContain("Unit details could not refresh");
 });
 it("rejects wall-clock timestamps instead of extending monotonic freshness",async()=>{
  await render({unitRequestStartedAt:Date.now(),catalogRequestStartedAt:Date.now()});expect(source.getSnapshot().selection).toBeNull();
 });

});
