// Fixture only: actual WorkScreen/route/components; test server supplies all data.
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Routes, Route, Link } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SelectedJobWorkRoute } from "../../src/pages/work/SelectedJobWorkRoute";
import { ViewAsRoleProvider } from "../../src/lib/viewAsRole";
import { useViewAsRole, type ViewAsRoleValue } from "../../src/lib/viewAsRoleContext";
import * as auth from "../../src/lib/signedIn";
import * as storage from "../../src/lib/workUnitReview/storage";
import { DesignContext } from "../../src/lib/design/context";
import { LanguageContext } from "../../src/lib/i18n/context";
import { CATALOG } from "../../src/lib/i18n/catalog";
import { translate, type Lang } from "../../src/lib/i18n/translate";
import { rememberSignedIn } from "../../src/lib/signedIn";
import "../../src/index.css";
const OWNER="00000000-0000-4000-8000-0000000000e2";
rememberSignedIn({user:{id:OWNER}});
const qc=new QueryClient({defaultOptions:{queries:{retry:false}}});
let preview: ViewAsRoleValue;
function PreviewProbe(){ preview=useViewAsRole(); return null; }
const fixture={qc,auth,storage,preview:()=>preview};
export type MountedReviewFixture=typeof fixture;
declare global { interface Window { mountedReviewFixture: MountedReviewFixture } }
window.mountedReviewFixture=fixture;
export function Harness(){
 const [lang,setLang]=useState<Lang>("en");
 return <QueryClientProvider client={qc}><BrowserRouter><ViewAsRoleProvider><PreviewProbe/><DesignContext.Provider value={{design:"new",choice:"new",masterOn:true,setChoice:()=>{}}}>
 <LanguageContext.Provider value={{lang,t:(k,v)=>translate(CATALOG,lang,k,v),setLang,needsChoice:false}}>
 <style>{`html,body,#root{margin:0;min-width:0;width:100%}*,*::before,*::after{box-sizing:border-box}.fixture-lang{position:relative;margin-top:60px}`}</style>
 <button className="fixture-lang" onClick={()=>setLang(lang==="en"?"es":"en")}>EN/ES</button><Routes><Route path="/e2e/support/mounted-unit-review.html" element={<SelectedJobWorkRoute/>}/><Route path="*" element={<div>Navigation destination<Link to="/e2e/support/mounted-unit-review.html">Return to work</Link></div>}/></Routes>
 </LanguageContext.Provider></DesignContext.Provider></ViewAsRoleProvider></BrowserRouter></QueryClientProvider>;
}
createRoot(document.getElementById("root")!).render(<Harness/>);
