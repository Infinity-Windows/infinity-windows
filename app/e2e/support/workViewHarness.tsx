// Disposable controlled-component fixture. No backend, payroll or activity client.
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { ProjectActivityView, type ActivityChoice, type ActivityIntent, type ActivityScope } from "../../src/components/work/ProjectActivityView";
import { DimensionObservationFields } from "../../src/components/work/DimensionObservationFields";
import { LanguageContext } from "../../src/lib/i18n/context";
import { CATALOG } from "../../src/lib/i18n/catalog";
import { translate, type Lang } from "../../src/lib/i18n/translate";
import type { DimensionDraft } from "../../src/lib/workUnitObservations/model";
const PROJECT="00000000-0000-4000-8000-000000000001", UNIT="00000000-0000-4000-8000-000000000002";
function choices(scope:ActivityScope):ActivityChoice[] {
  return ["Unloading and preparing unusually long aluminum assemblies","Moving heavy units using machinery","Checking floor and opening dimensions"].map((label,index)=>({
    selectionId:"00000000-0000-4000-8000-000000000003",selectionRevision:2,menuVersionId:"00000000-0000-4000-8000-000000000004",
    definitionVersionId:`00000000-0000-4000-8000-00000000001${index}`,scope,
    label:{en:label,es:index===1?"Mover unidades pesadas con maquinaria":"Comprobar dimensiones de unidades de aluminio muy largas"},
    fields:index===2?[
      {id:"count",type:"number",unit:"count",required:true,label_en:"Count",label_es:"Cantidad"},
      {id:"ready",type:"boolean",required:true,label_en:"Ready",label_es:"Listo"},
    ]:[],kind:index===1?"machinery":"activity",personalSeconds:index===2?null:1800,scopeTotalSeconds:index===2?null:9000,eligible:true,
  }));
}
const GENERAL=choices("general"),SPECIFIC=choices("specific");
function Harness(){
  const [locale,setLocale]=useState<Lang>("en"),[tab,setTab]=useState<ActivityScope>("general"),[pending,setPending]=useState(false),[unavailable,setUnavailable]=useState(false);
  const [draft,setDraft]=useState<DimensionDraft>({width:"",height:"",unit:"in",source:"",reference:""});
  const [intents,setIntents]=useState<ActivityIntent[]>([]),[controls,setControls]=useState<string[]>([]);
  const control=(name:string)=>()=>setControls(old=>[...old,name]);
  return <LanguageContext.Provider value={{lang:locale,t:(key,vars)=>translate(CATALOG,locale,key,vars),setLang:setLocale,needsChoice:false}}>
    <style>{`body{margin:0;font-family:system-ui;background:#f3f7f3}button,input,select{font:inherit}input,select{min-height:44px}input{border:1px solid #a8bfb0;border-radius:8px;padding:8px} .fixture-controls{display:flex;flex-wrap:wrap;gap:8px;padding:8px; margin-top:70px} .fixture-output{overflow-wrap:anywhere;padding:8px}`}</style>
    <div className="fixture-controls"><button onClick={()=>setLocale(locale==="en"?"es":"en")}>Change language</button><button onClick={()=>setPending(!pending)}>Toggle pending</button><button onClick={()=>setUnavailable(!unavailable)}>Toggle unavailable</button></div>
    <ProjectActivityView locale={locale} project={{id:PROJECT,name:"Long synthetic project name for phone portrait and landscape checks",code:"FIXTURE"}}
      tab={tab} onTabChange={setTab} paidSeconds={12345} scopeSeconds={{general:1800,specific:7200}}
      running={{projectId:PROJECT,definitionVersionId:GENERAL[0].definitionVersionId,unitId:null,label:GENERAL[0].label,scope:"general",status:"confirmed"}}
      catalog={{status:unavailable?"unavailable":"ready",capturable:!unavailable,general:GENERAL,specific:SPECIFIC}}
      units={[{id:UNIT,label:"Unit 12 with an unusually long description of an aluminum assembly and components",detail:"Third floor · Plans A12"}]}
      selectedUnitId={UNIT} selectedUnitState="ready" selectedUnitBasis={{id:UNIT,operationalRevision:5,factId:"00000000-0000-4000-8000-000000000020",factRevision:3,incarnationEpoch:1,bindingEpoch:2,projectEpoch:3,openingEpoch:4,originProjectEpoch:2,originOpeningEpoch:3}}
      onSelectUnit={()=>{}} onAddUnit={control("add")} dimensionsSlot={<DimensionObservationFields value={draft} onChange={setDraft}/>}
      activityPending={pending} onStartActivity={async intent=>{setIntents(old=>[...old,intent]);setPending(true);}}
      onOpenClock={control("clock")} onBreak={control("break")} onClockOut={control("out")} onSchedule={control("schedule")} onAsk={control("ask")}/>
    <div className="fixture-output"><output data-testid="intent-count">{intents.length}</output><output data-testid="intent-json">{JSON.stringify(intents)}</output><output data-testid="controls-json">{JSON.stringify(controls)}</output></div>
  </LanguageContext.Provider>;
}
createRoot(document.getElementById("root")!).render(<Harness/>);
