import type { TimeShift } from "../timeclock";
import { cloneJson, postgresInstantMicros, uuid } from "../workConfiguration/model";
import { stillSignedInAs, subscribeSignedIn, type SignInMark } from "../signedIn";
import { ClockAccountChangedError, ownPaidClockClient } from "./api";
import { isPaidClockTransportFailure } from "./readFailure";

export interface CurrentLoginSafetyTarget {readonly ownerId:string;readonly loginGeneration:number;readonly shiftId:string;
  readonly observationVersion:number;readonly observedAt:string;}
type Observation={observedAt?:string;safetyTarget?:CurrentLoginSafetyTarget|null;clockInCommandId?:string|null};
export type OwnPaidClockCurrent = ({kind:"off";shift:null} | {kind:"open"|"needs_finish";shift:TimeShift}) & Observation;
const observedTargets=new WeakSet<object>();
let observationVersion=0,readSequence=0,target:CurrentLoginSafetyTarget|null=null,last:OwnPaidClockCurrent|null=null;
const observationListeners=new Set<()=>void>();
function observedChanged(){for(const listener of observationListeners){try{listener();}catch{/* Every authority listener must receive revocation. */}}}
export function subscribeObservedClockChanges(callback:()=>void):()=>void {observationListeners.add(callback);return()=>{observationListeners.delete(callback);};}
subscribeSignedIn(()=>{observationVersion++;readSequence++;target=null;last=null;observedChanged();});
export function invalidateObservedClockTarget(login:SignInMark,shiftId?:string):void {
  if(!login.userId || !stillSignedInAs(login,login.userId) || shiftId && target && target.shiftId!==shiftId)return;
  observationVersion++;readSequence++;target=null;last=null;observedChanged();
}
export function isCurrentLoginSafetyTarget(value:unknown,ownerId:string,shiftId:string,login:SignInMark):value is CurrentLoginSafetyTarget {
  if(!value || typeof value!=="object" || !observedTargets.has(value) || value!==target)return false;
  const t=value as CurrentLoginSafetyTarget;
  return t.ownerId===ownerId && t.shiftId===shiftId && t.loginGeneration===login.generation &&
    t.observationVersion===observationVersion && stillSignedInAs(login,ownerId);
}
export function readObservedClockTarget(login:SignInMark,shiftId:string):CurrentLoginSafetyTarget|null {
  return target && login.userId && isCurrentLoginSafetyTarget(target,login.userId,shiftId,login)?target:null;
}
export function readLastObservedPaidClock(login:SignInMark):OwnPaidClockCurrent|null {
  if(!login.userId || !stillSignedInAs(login,login.userId))return null;
  return last;
}
export function readObservedShiftBinding(login:SignInMark):{observationVersion:number;kind:"off"|"open"|"needs_finish";shiftId:string|null;clockInCommandId:string|null}|null {
  if(!login.userId || !stillSignedInAs(login,login.userId) || !last)return null;
  return {observationVersion,kind:last.kind,shiftId:last.shift?.id ?? null,clockInCommandId:last.clockInCommandId ?? null};
}
/** Minimal last-observed display, separate from current freshness. Job/office
 * text is never retained as offline history or used to choose an allocation. */
export function minimalObservedPaidClock(value:OwnPaidClockCurrent):OwnPaidClockCurrent {
  return value.kind==="off"?value:{...value,shift:{...value.shift,project_id:null,cost_code_id:null,
    projects:undefined,cost_codes:undefined,note:null,injury_note:null}};
}
function freezeObserved(value:OwnPaidClockCurrent):OwnPaidClockCurrent {
  if(value.shift) {
    if(value.shift.projects)Object.freeze(value.shift.projects);
    if(value.shift.cost_codes)Object.freeze(value.shift.cost_codes);
    Object.freeze(value.shift);
  }
  return Object.freeze(value);
}
const SELECT="id,profile_id,project_id,cost_code_id,client_id,clock_in_at,clock_out_at,break_seconds,break_started_at,break_type,injured,time_confirmed,status,created_at,note,injury_note,job_mode,review_reason,projects(job_code,name),cost_codes(code,label)";
function unavailable(): never { throw Error("Current paid time is unavailable. Refresh before another clock action."); }
function text(value:unknown):string { if(typeof value!=="string" || value.includes("\0")) return unavailable();return value; }
function nullable<T>(value:unknown,parse:(v:unknown)=>T):T|null {return value===null?null:parse(value);}
function instant(value:unknown):string {postgresInstantMicros(value);return value as string;}
function boolean(value:unknown):boolean {if(typeof value!=="boolean")return unavailable();return value;}
function pair(value:unknown,first:string,second:string):Record<string,string>|null {
  if(value===null)return null;
  if(!value || typeof value!=="object" || Array.isArray(value))return unavailable();
  const o=value as Record<string,unknown>;return {[first]:text(o[first]),[second]:text(o[second])};
}
/** Parse a fresh own query, never an RPC replay or a saved optimistic shift.
 * This display read is not the branded authority for a later safety write. */
export function parseOwnPaidClockCurrent(raw:unknown,owner:string):OwnPaidClockCurrent {
  uuid(owner);if(raw===null)return {kind:"off",shift:null};
  const value=cloneJson(raw);
  if(!value || typeof value!=="object" || Array.isArray(value))return unavailable();
  const o=value as Record<string,unknown>;
  if(o.profile_id!==owner || !["open","needs_finish"].includes(o.status as string) || o.clock_out_at!==null ||
    typeof o.break_seconds!=="number" || !Number.isSafeInteger(o.break_seconds) || o.break_seconds<0 || o.break_seconds>2147483647 ||
    ![null,"lunch","rest","other"].includes(o.break_type as null|string) || ![null,"data","tracking"].includes(o.job_mode as null|string))return unavailable();
  const shift:TimeShift={id:uuid(o.id),profile_id:owner,project_id:nullable(o.project_id,uuid),cost_code_id:nullable(o.cost_code_id,uuid),
    clock_in_at:instant(o.clock_in_at),clock_out_at:null,break_seconds:o.break_seconds,break_started_at:nullable(o.break_started_at,instant),
    break_type:o.break_type as TimeShift["break_type"],injured:nullable(o.injured,boolean),time_confirmed:nullable(o.time_confirmed,boolean),
    status:o.status as "open"|"needs_finish",created_at:instant(o.created_at),note:nullable(o.note,text),injury_note:nullable(o.injury_note,text),
    job_mode:o.job_mode as TimeShift["job_mode"],review_reason:nullable(o.review_reason,text),
    projects:pair(o.projects,"job_code","name") as TimeShift["projects"],cost_codes:pair(o.cost_codes,"code","label") as TimeShift["cost_codes"]};
  return {kind:shift.status as "open"|"needs_finish",shift,clockInCommandId:o.client_id===undefined?null:nullable(o.client_id,uuid)};
}
export async function fetchOwnPaidClockCurrent(login:SignInMark):Promise<OwnPaidClockCurrent> {
  const owner=login.userId;
  if(!owner || !stillSignedInAs(login,owner))throw new ClockAccountChangedError();
  const sequence=++readSequence;
  try {
  const client=await ownPaidClockClient(login);
  if(!stillSignedInAs(login,owner))throw new ClockAccountChangedError();
  const {data,error}=await client.from("time_shifts").select(SELECT).eq("profile_id",owner)
    .in("status",["open","needs_finish"]).is("clock_out_at",null).order("clock_in_at",{ascending:false}).limit(1).maybeSingle();
  if(!stillSignedInAs(login,owner))throw new ClockAccountChangedError();
  if(error)throw error;
  const current=parseOwnPaidClockCurrent(data,owner);
  if(sequence!==readSequence)throw Error("Current clock read superseded");
  observationVersion++;target=null;
  const observedAt=new Date().toISOString();
  if(current.kind==="open") {
    target=Object.freeze({ownerId:owner,loginGeneration:login.generation,shiftId:current.shift.id,observationVersion,observedAt});
    observedTargets.add(target);
  }
  const result=freezeObserved({...current,observedAt,safetyTarget:target});
  last=freezeObserved(minimalObservedPaidClock(result));observedChanged();return result;
  } catch(error) {
    if(sequence===readSequence && !isPaidClockTransportFailure(error))invalidateObservedClockTarget(login);
    throw error;
  }
}
