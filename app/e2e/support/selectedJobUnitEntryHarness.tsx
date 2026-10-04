// Acceptance fixture: real CurrentWork / UnitEditor and isolated real dimension
// adapter. Payroll provider, native journal and root review forms are not mounted.
// The dimension callback captures an intent; it is not a production queue receipt.
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { Link, MemoryRouter, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Layout } from "../../src/components/Layout";
import { CurrentWork } from "../../src/pages/customWork/CurrentWork";
import { SelectedJobUnitDimensions } from "../../src/pages/work/SelectedJobUnitDimensions";
import type { WorkUnit } from "../../src/lib/customWork/model";
import type { UnitBasis } from "../../src/lib/workActivity/protocol";
import { useSyncExternalStore } from "react";
import { WorkScreen } from "../../src/pages/work/WorkScreen";
import { DesignContext } from "../../src/lib/design/context";
import { LanguageContext } from "../../src/lib/i18n/context";
import { ViewAsRoleContext } from "../../src/lib/viewAsRoleContext";
import { CATALOG } from "../../src/lib/i18n/catalog";
import { translate, type Lang } from "../../src/lib/i18n/translate";
import { rememberSignedIn } from "../../src/lib/signedIn";
import "../../src/index.css";
const OWNER="00000000-0000-4000-8000-0000000000e2";
rememberSignedIn({user:{id:OWNER}});
const qc=new QueryClient({defaultOptions:{queries:{retry:false}}});
export function Destination(){const location=useLocation();return <div className="page" data-testid="destination">{location.pathname}{location.search}<Link to="/">Return to Work</Link></div>;}
const PROJECT="00000000-0000-4000-8000-000000000301", UNIT="00000000-0000-4000-8000-000000000309";
const connected=()=>navigator.onLine;
const subscribe=(cb:()=>void)=>{window.addEventListener("online",cb);window.addEventListener("offline",cb);return()=>{window.removeEventListener("online",cb);window.removeEventListener("offline",cb);};};
const unit:WorkUnit={id:UNIT,project_id:PROJECT,opening_id:null,created_by:OWNER,label:"Unit 42",type_label:"Bifold aluminum",facts:{components:[{label:"leaf",quantity:3},{label:"frame",quantity:1}]},revision:5,created_at:new Date().toISOString(),updated_at:new Date().toISOString()};
const basis:UnitBasis={id:UNIT,projectId:PROJECT,openingId:null,operationalRevision:5,incarnationEpoch:2,bindingEpoch:3,projectEpoch:1,openingEpoch:null,fact:{id:"00000000-0000-4000-8000-000000000310",revision:2,eventKind:"observation",originProjectEpoch:1,originOpeningEpoch:null,dimensions:{widthIn:10,heightIn:20,source:"measured",original:{width:10,height:20,unit:"in",source:"measured",sourceReference:null}},estimated:false},eligibleForCapture:true,ineligibleReason:null};
export function Dimensions({preview}:{preview:boolean}){
 const online=useSyncExternalStore(subscribe,connected);
 return <div className="page"><h1>Dimension inspection fixture</h1><p>Controlled callback only; QC verification is independent.</p>
 <SelectedJobUnitDimensions projectId={PROJECT} selectedUnitId={UNIT} units={[unit]} unitSourceState="ready" unitBasis={basis} enabled={online&&!preview} canEditDimensions={!preview} pendingUnitIds={[]}
 onSave={async data=>{const w=window as Window & {__dimensionIntents?:unknown[]};(w.__dimensionIntents??=[]).push(data);}}
 onRefreshUnits={async()=>{}} onRefreshActivity={async()=>{}}/></div>;
}
export function FixtureNavigation(){
 const navigate=useNavigate();
 useEffect(()=>{const move=(event:Event)=>navigate((event as CustomEvent<string>).detail);
 window.addEventListener("fixture-navigate",move);return()=>window.removeEventListener("fixture-navigate",move);},[navigate]);
 return null;
}
export function Harness(){
 const [lang,setLang]=useState<Lang>("en");
 const [preview,setPreview]=useState(false);
 useEffect(()=>{const language=()=>setLang(l=>l==='en'?'es':'en'),preview=()=>setPreview(p=>!p);
 window.addEventListener('fixture-language',language);window.addEventListener('fixture-preview',preview);
 return ()=>{window.removeEventListener('fixture-language',language);window.removeEventListener('fixture-preview',preview);};},[]);
 return <QueryClientProvider client={qc}><MemoryRouter initialEntries={[new URLSearchParams(location.search).get("entry")??"/"]}><DesignContext.Provider value={{design:"new",choice:"new",masterOn:true,setChoice:()=>{}}}>
 <LanguageContext.Provider value={{lang,t:(k,v)=>translate(CATALOG,lang,k,v),setLang,needsChoice:false}}>
 <ViewAsRoleContext.Provider value={{previewRole:preview?"installer":null,setPreviewRole:()=>{},canPreview:true,previewPerson:null,setPreviewPerson:()=>{},canPreviewPerson:false}}>
 <FixtureNavigation/><Routes><Route element={<Layout/>}><Route index element={<WorkScreen/>}/><Route path="current-work" element={<CurrentWork/>}/><Route path="dimensions" element={<Dimensions preview={preview}/>}/><Route path="*" element={<Destination/>}/></Route></Routes>

 </ViewAsRoleContext.Provider></LanguageContext.Provider></DesignContext.Provider></MemoryRouter></QueryClientProvider>;
}
createRoot(document.getElementById("root")!).render(<Harness/>);
