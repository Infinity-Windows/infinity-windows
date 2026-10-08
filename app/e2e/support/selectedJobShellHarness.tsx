// Acceptance fixture: actual Layout, WorkScreen and native children, no App
// bootstrap/PIN/PWA/ClockProvider. Clock, outbox read and RPCs are injected by
// Playwright. Destination bodies are markers; navigation doors are real.
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { Link, MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Layout } from "../../src/components/Layout";
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
function Destination(){const location=useLocation();return <div className="page" data-testid="destination">{location.pathname}{location.search}<Link to="/">Return to Work</Link></div>;}
function Harness(){
 const [lang,setLang]=useState<Lang>("en");
 const [preview,setPreview]=useState(false);
 useEffect(()=>{const language=()=>setLang(l=>l==='en'?'es':'en'),preview=()=>setPreview(p=>!p);
 window.addEventListener('fixture-language',language);window.addEventListener('fixture-preview',preview);
 return ()=>{window.removeEventListener('fixture-language',language);window.removeEventListener('fixture-preview',preview);};},[]);
 return <QueryClientProvider client={qc}><MemoryRouter><DesignContext.Provider value={{design:"new",choice:"new",masterOn:true,setChoice:()=>{}}}>
 <LanguageContext.Provider value={{lang,t:(k,v)=>translate(CATALOG,lang,k,v),setLang,needsChoice:false}}>
 <ViewAsRoleContext.Provider value={{previewRole:preview?"installer":null,setPreviewRole:()=>{},canPreview:true,previewPerson:null,setPreviewPerson:()=>{},canPreviewPerson:false}}>
 <Routes><Route element={<Layout/>}><Route index element={<WorkScreen/>}/><Route path="*" element={<Destination/>}/></Route></Routes>

 </ViewAsRoleContext.Provider></LanguageContext.Provider></DesignContext.Provider></MemoryRouter></QueryClientProvider>;
}
createRoot(document.getElementById("root")!).render(<Harness/>);
