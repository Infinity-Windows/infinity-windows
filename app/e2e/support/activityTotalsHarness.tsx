import { useState } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient,QueryClientProvider } from "@tanstack/react-query";
import { ViewAsRoleProvider } from "../../src/lib/viewAsRole";
import { useViewAsRole } from "../../src/lib/viewAsRoleContext";
import { LanguageContext } from "../../src/lib/i18n/context";
import { ActivityTotalsPanel } from "../../src/components/work/ActivityTotalsPanel";
import { useActivityTotals } from "../../src/lib/workActivityTotals/useActivityTotals";
import { choiceTotals } from "../../src/lib/workActivityTotals/format";
import { createUnitReviewSelectionSource } from "../../src/lib/workUnitReview/useUnitReviewCoordinator";
import * as auth from "../../src/lib/signedIn";
import corpus from "../../src/lib/workActivityTotals/__fixtures__/sourceMatchedWire.json";
import "../../src/index.css";
import "../../src/pages/work/work.css";
const initial=corpus.calls[Number(new URLSearchParams(location.search).get("index")??0)].result.totals??corpus.calls[0].result.totals!;
auth.rememberSignedIn({user:{id:initial.actorId}});
const client=new QueryClient({defaultOptions:{queries:{retry:false,staleTime:Infinity}}});
client.setQueryData(["myRealProfile"],{id:initial.actorId,role:"owner",retired_at:null});
const source=createUnitReviewSelectionSource();let admitted=true,viewAs:ReturnType<typeof useViewAsRole>|null=null;
let selectUnit:((unit:string|null)=>void)|null=null;
export function Fixture(){
 const [unit,setUnit]=useState<string|null>(null);selectUnit=setUnit;viewAs=useViewAsRole();
 const totals=useActivityTotals(initial.projectId,unit,source,()=>admitted);
 const locale=new URLSearchParams(location.search).get("lang")==="es"?"es":"en";
 const one=totals.data?.activities[0];const values=one?choiceTotals(totals.data,one.definitionVersionId,totals.liveElapsedMicros):null;
 return <LanguageContext.Provider value={{lang:locale,setLang:()=>{},t:key=>key,needsChoice:false}}><main style={{padding:12,maxWidth:600,margin:"auto"}}>
  <output aria-label="Tile totals">{values?.personalSeconds??"unknown"}/{values?.scopeTotalSeconds??"unknown"}</output>
  <ActivityTotalsPanel totals={totals} onRefresh={async()=>{source.invalidate();}} />
 </main></LanguageContext.Provider>;
}
// Only synthetic fixture controls. No operational storage or write endpoint.
Object.assign(window,{activityTotalsFixture:{
 corpus,source,
 select(unit:string|null){source.invalidate();if(unit){source.select({login:auth.signInMark(),realRole:"owner",selectedJobId:initial.projectId,selectedUnitId:unit,binding:{unitId:unit,projectId:initial.projectId},admitted:()=>admitted});}selectUnit?.(unit);},
 hold(){admitted=false;source.invalidate();},
 check(){admitted=true;source.invalidate();},
 previewABA(){viewAs?.setPreviewRole("installer");viewAs?.setPreviewRole(null);},
 logoutABA(){auth.rememberSignedIn(null);auth.rememberSignedIn({user:{id:initial.actorId}});},
 profileInvalidated(){void client.invalidateQueries({queryKey:["myRealProfile"]});},
}});
createRoot(document.getElementById("root")!).render(<QueryClientProvider client={client}><ViewAsRoleProvider><Fixture/></ViewAsRoleProvider></QueryClientProvider>);
