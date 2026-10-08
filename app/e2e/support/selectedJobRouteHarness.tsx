// Fixture only: actual WorkScreen/route/components; test server supplies all data.
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { WorkScreen } from "../../src/pages/work/WorkScreen";
import { DesignContext } from "../../src/lib/design/context";
import { LanguageContext } from "../../src/lib/i18n/context";
import { CATALOG } from "../../src/lib/i18n/catalog";
import { translate, type Lang } from "../../src/lib/i18n/translate";
import { rememberSignedIn } from "../../src/lib/signedIn";
import "../../src/index.css";
const OWNER="00000000-0000-4000-8000-0000000000e2";
rememberSignedIn({user:{id:OWNER}});
const qc=new QueryClient({defaultOptions:{queries:{retry:false}}});
export function Harness(){
 const [lang,setLang]=useState<Lang>("en");
 return <QueryClientProvider client={qc}><MemoryRouter><DesignContext.Provider value={{design:"new",choice:"new",masterOn:true,setChoice:()=>{}}}>
 <LanguageContext.Provider value={{lang,t:(k,v)=>translate(CATALOG,lang,k,v),setLang,needsChoice:false}}>
 <style>{`html,body,#root{margin:0;min-width:0;width:100%}*,*::before,*::after{box-sizing:border-box}.fixture-lang{position:relative;margin-top:60px}`}</style>
 <button className="fixture-lang" onClick={()=>setLang(lang==="en"?"es":"en")}>EN/ES</button><WorkScreen/>
 </LanguageContext.Provider></DesignContext.Provider></MemoryRouter></QueryClientProvider>;
}
createRoot(document.getElementById("root")!).render(<Harness/>);
