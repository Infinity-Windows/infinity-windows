// Synthetic read/write routes are supplied by the spec. Production release
// admission stays off; this fixture explicitly opts into the isolated route.
import {useState} from "react";
import {createRoot} from "react-dom/client";
import {MemoryRouter} from "react-router-dom";
import {QueryClient,QueryClientProvider} from "@tanstack/react-query";
import ClockFlowBridge from "../../src/lib/paidClock/ClockFlowBridge";
import {ClockSheet} from "../../src/components/clock/ClockSheet";
import type {NativeClockFlow} from "../../src/lib/paidClock/flow";
import {LanguageContext} from "../../src/lib/i18n/context";
import {CATALOG} from "../../src/lib/i18n/catalog";
import {translate,type Lang} from "../../src/lib/i18n/translate";
import {rememberSignedIn} from "../../src/lib/signedIn";
import {localDateOf} from "../../src/lib/toolboxSign";
import "../../src/index.css";
const OWNER="00000000-0000-4000-8000-0000000000e2";
const releaseAuthorized=new URLSearchParams(location.search).get("classic")!=="true";
rememberSignedIn({user:{id:OWNER}});
const queryClient=new QueryClient({defaultOptions:{queries:{retry:false,staleTime:Infinity,refetchOnMount:false}}});
const day=localDateOf(new Date());
for(const key of [["projects"],["clockCostCodes","all"],["recentJobs",OWNER],["mySchedule",OWNER,day,day],
  ["myActivePhases",OWNER],["myOpenings",OWNER]])queryClient.setQueryData(key,[]);
queryClient.setQueryData(["todayTalk",day],null);queryClient.setQueryData(["toolboxToday",OWNER],{id:"fixture-signed"});
declare global {interface Window {paidScreen:{language:(lang:Lang)=>void;flow:()=>NativeClockFlow|null};}}
export function Harness(){
  const [flow,setFlow]=useState<NativeClockFlow|null>(null),[lang,setLang]=useState<Lang>("en"),[closed,setClosed]=useState(false);
  window.paidScreen={language:setLang,flow:()=>flow};
  return <QueryClientProvider client={queryClient}><MemoryRouter>
    <LanguageContext.Provider value={{lang,setLang,t:(key,vars)=>translate(CATALOG,lang,key,vars),needsChoice:false}}>
      <ClockFlowBridge profileId={OWNER} legacyReady legacyShift={null} legacyPending={null} onFlow={setFlow} releaseAuthorized={releaseAuthorized}/>
      <output hidden data-testid="screen-state">{flow?.route}:{flow?.currentRead}:{flow?.current?.kind}</output>
      <output hidden data-testid="screen-closed">{String(closed)}</output>
      {flow && !closed && <ClockSheet profileId={OWNER} nativeFlow={flow} admissionReady={flow.nativeRead!=="loading"} shift={flow.current?.shift ?? null}
        onClose={()=>setClosed(true)} onChanged={flow.refresh}/>}
    </LanguageContext.Provider>
  </MemoryRouter></QueryClientProvider>;
}
createRoot(document.getElementById("root")!).render(<Harness/>);
