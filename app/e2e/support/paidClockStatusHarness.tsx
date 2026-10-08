import { useState } from "react";
import { createRoot } from "react-dom/client";
import { PaidClockQueueStatus } from "../../src/components/clock/PaidClockQueueStatus";
import { LanguageContext } from "../../src/lib/i18n/context";
import { CATALOG } from "../../src/lib/i18n/catalog";
import { translate, type Lang } from "../../src/lib/i18n/translate";
import { rememberSignedIn } from "../../src/lib/signedIn";
import { AUTH_STORAGE_KEY } from "../../src/lib/supabase";
// Synthetic fixture identity only; supabaseFixtures.ts itself is Node-only.
const OWNER="00000000-0000-4000-8000-0000000000e2";
if(localStorage.getItem(AUTH_STORAGE_KEY)) rememberSignedIn({user:{id:OWNER}});
function Harness(){
  const [lang,setLang]=useState<Lang>("en"),[mount,setMount]=useState(0);
  return <LanguageContext.Provider value={{lang,t:(key,vars)=>translate(CATALOG,lang,key,vars),setLang,needsChoice:false}}>
    <style>{`html,body,#root{margin:0;width:100%;min-width:0;font:16px system-ui}*{box-sizing:border-box}main{padding:12px}button{font:inherit;min-height:44px}.fixture-tools{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:12px}`}</style>
    <main><div className="fixture-tools">
      <button type="button" onClick={()=>setLang(lang==="en"?"es":"en")}>EN / ES</button>
      <button type="button" onClick={()=>setMount(v=>v+1)}>Remount reader</button>
      <button type="button" onClick={()=>rememberSignedIn(null)}>Logout fixture</button>
      <button type="button" onClick={()=>rememberSignedIn({user:{id:OWNER}})}>Login fixture</button>
    </div><PaidClockQueueStatus key={mount} profileId={OWNER} includeHistory/></main>
  </LanguageContext.Provider>;
}
createRoot(document.getElementById("root")!).render(<Harness/>);
