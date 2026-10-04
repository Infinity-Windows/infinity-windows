import { cloneJson, typedFields, type TypedField } from '../workConfiguration/model';
import { activityUuid, parseUnitBasisReply, type UnitBasis } from './protocol';

export class ActivityCatalogUnavailableError extends Error {
  constructor(){super('Job activities are unavailable. Refresh before changing work.');this.name='ActivityCatalogUnavailableError';}
}
const fail=():never=>{throw new ActivityCatalogUnavailableError();};
function object(value:unknown,keys:readonly string[]):Record<string,unknown>{
  if(!value || typeof value!=='object' || Array.isArray(value))return fail();
  const o=value as Record<string,unknown>;
  if(Object.keys(o).length!==keys.length || keys.some(k=>!Object.hasOwn(o,k)))return fail();
  return o;
}
function integer(v:unknown,min:number,max=Number.MAX_SAFE_INTEGER):number{return typeof v==='number' && Number.isSafeInteger(v) && v>=min && v<=max?v:fail();}
function bool(v:unknown):boolean{return typeof v==='boolean'?v:fail();}
function label(v:unknown):string{return typeof v==='string' && [...v.trim()].length>=1 && [...v].length<=120?v:fail();}
function strings(value:unknown):void{
  if(typeof value==='string'){
    if(value.includes('\0'))fail();
    for(let i=0;i<value.length;i++){
      const n=value.charCodeAt(i);
      if(n>=0xd800 && n<=0xdbff){const next=value.charCodeAt(++i);if(!(next>=0xdc00 && next<=0xdfff))fail();}
      else if(n>=0xdc00 && n<=0xdfff)fail();
    }
  }else if(value && typeof value==='object')for(const [key,v] of Object.entries(value)){strings(key);strings(v);}
}
const REASONS=['disabled','menu_unavailable','definition_unavailable','unit_required','unit_dimensions'] as const;
export type CatalogReason=typeof REASONS[number];
export interface CatalogActivity {
  definitionId:string;definitionVersionId:string;position:number;enabled:boolean;
  scope:'general'|'specific';labelEn:string;labelEs:string;machineSelection:boolean;
  typedFields:TypedField[];eligibleNow:boolean;ineligibleReason:CatalogReason|null;
}
export interface CatalogSelection {selectionId:string;selectionRevision:number;menuVersionId:string;eligibleNow:boolean;activities:CatalogActivity[]}
export interface ActivityCatalog {
  protocolVersion:1;asOf:string;availability:'available'|'unavailable';projectId:string|null;
  unit:UnitBasis|null;selection:CatalogSelection|null;
  totals:{availability:'unavailable';reasonCode:'not_ready'};
}
/** A narrow fresh read supplies selection material, never a command observation
 * or invented timer. Every returned unit passes the exact protocol basis parser. */
export function parseActivityCatalog(raw:unknown,projectId:string,unitId:string|null):ActivityCatalog {
  try{
    activityUuid(projectId);if(unitId!==null)activityUuid(unitId);
    const copy=cloneJson(raw);strings(copy);
    if(new TextEncoder().encode(JSON.stringify(copy)).byteLength>100000)fail();
    const o=object(copy,['protocolVersion','asOf','availability','projectId','unit','selection','totals']);
    if(o.protocolVersion!==1 || (o.availability!=='available' && o.availability!=='unavailable'))fail();
    const asOf=parseUnitBasisReply({protocolVersion:1,asOf:o.asOf,availability:'unavailable',unit:null},projectId).asOf;
    const totals=object(o.totals,['availability','reasonCode']);
    if(totals.availability!=='unavailable' || totals.reasonCode!=='not_ready')fail();
    if(o.availability==='unavailable'){
      if(o.projectId!==null || o.unit!==null || o.selection!==null)fail();
      return {protocolVersion:1,asOf,availability:'unavailable',projectId:null,unit:null,selection:null,totals:{availability:'unavailable',reasonCode:'not_ready'}};
    }
    if(activityUuid(o.projectId)!==projectId)fail();
    let unit:UnitBasis|null=null;
    if(unitId===null){if(o.unit!==null)fail();}
    else {
      const parsed=parseUnitBasisReply({protocolVersion:1,asOf,availability:'available',unit:o.unit},unitId);
      if(parsed.availability!=='available' || parsed.unit.projectId!==projectId)fail();
      unit=parsed.unit;
    }
    let selection:CatalogSelection|null=null;
    if(o.selection!==null){
      const s=object(o.selection,['selectionId','selectionRevision','menuVersionId','eligibleNow','activities']);
      const rawActivities=s.activities;
      if(!Array.isArray(rawActivities) || rawActivities.length>200)return fail();
      const menuReady=bool(s.eligibleNow);
      const activities:CatalogActivity[]=rawActivities.map(v=>{
        const a=object(v,['definitionId','definitionVersionId','position','enabled','scope','labelEn','labelEs','machineSelection','typedFields','eligibleNow','ineligibleReason']);
        if(a.scope!=='general' && a.scope!=='specific')return fail();
        const eligibleNow=bool(a.eligibleNow),enabled=bool(a.enabled);
        const reason=a.ineligibleReason===null?null:REASONS.find(r=>r===a.ineligibleReason)??fail();
        if(eligibleNow!== (reason===null) || (eligibleNow && (!enabled || !menuReady || (a.scope==='specific' && !unit?.eligibleForCapture))))fail();
        return {definitionId:activityUuid(a.definitionId),definitionVersionId:activityUuid(a.definitionVersionId),position:integer(a.position,0,199),enabled,
          scope:a.scope,labelEn:label(a.labelEn),labelEs:label(a.labelEs),machineSelection:bool(a.machineSelection),typedFields:typedFields(a.typedFields),eligibleNow,ineligibleReason:reason};
      });
      for(const key of ['definitionId','definitionVersionId','position'] as const)if(new Set(activities.map(a=>a[key])).size!==activities.length)fail();
      if(activities.some((a,i)=>i>0 && a.position<=activities[i-1].position))fail();
      selection={selectionId:activityUuid(s.selectionId),selectionRevision:integer(s.selectionRevision,1),menuVersionId:activityUuid(s.menuVersionId),eligibleNow:menuReady,activities};
    }
    return {protocolVersion:1,asOf,availability:'available',projectId,unit,selection,totals:{availability:'unavailable',reasonCode:'not_ready'}};
  }catch{return fail();}
}
