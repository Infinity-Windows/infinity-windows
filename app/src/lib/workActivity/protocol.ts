/** Protocol-one boundary. No network/storage calls and no inferred source IDs. */
export type SourceKind = 'custom' | 'unit' | 'task' | 'service' | 'phase' | 'setup';
export type MachineKind = 'forklift' | 'tele_handler' | 'scissor_lift' | 'spider_suction';
export type Answers = Record<string, string | number | boolean | string[]>;
export interface Receipt {
  protocolVersion: 1; commandId: string; status: 'applied' | 'noop' | 'conflict' | 'refused';
  reasonCode: string | null; beforeRevision: number; afterRevision: number;
  transitionId: string | null; effectiveAt: string | null;
}
export type ReceiptReply = { protocolVersion: 1; availability: 'available'; receipt: Receipt }
  | { protocolVersion: 1; availability: 'unavailable'; receipt: null };
export interface UnitCommandBasis {
  id: string; operationalRevision: number; factId: string; factRevision: number;
  incarnationEpoch: number; bindingEpoch: number; projectEpoch: number; openingEpoch: number | null;
  originProjectEpoch: number | null; originOpeningEpoch: number | null;
}
export interface OriginalDimensions {
  width: number; height: number; unit: 'in' | 'ft' | 'mm' | 'cm';
  source: 'measured' | 'plans' | 'estimated'; sourceReference: string | null;
}
export interface UnitBasis {
  id: string; projectId: string | null; openingId: string | null; operationalRevision: number;
  incarnationEpoch: number; bindingEpoch: number; projectEpoch: number | null; openingEpoch: number | null;
  fact: null | { id: string; revision: number; eventKind: 'observation' | 'legacy_observation' | 'incomplete' | 'cleared' | 'relink';
    originProjectEpoch: number | null; originOpeningEpoch: number | null;
    dimensions: null | { widthIn: number; heightIn: number; source: OriginalDimensions['source']; original: OriginalDimensions | null };
    estimated: boolean | null };
  eligibleForCapture: boolean; ineligibleReason: 'unassigned' | 'missing_observation' | 'incomplete_dimensions' | null;
}
export type UnitBasisReply = { protocolVersion: 1; asOf: string; availability: 'available'; unit: UnitBasis }
  | { protocolVersion: 1; asOf: string; availability: 'unavailable'; unit: null };
export type ProjectView = { visibility: 'available'; id: string; name: string; jobCode: string | null }
  | { visibility: 'unassigned' | 'unavailable'; id: null; name: null; jobCode: null };
export interface CaptureView {
  definitionVersionId: string; menuVersionId: string; selectionId: string; selectionRevision: number;
  scope: 'general' | 'specific'; labelEn: string; labelEs: string; machineKind: MachineKind | null;
  values: Answers; unitAtStart: UnitCommandBasis | null;
}
export type ActivityView = { visibility: 'unavailable' } | { visibility: 'available';
  source: { kind: SourceKind; id: string }; startedAt: string; project: ProjectView;
  capture: CaptureView | null; unit: UnitBasis | null };
export interface PersonalState {
  revision: number; lastTransitionId: string | null; integrity: 'clean' | 'legacy_conflict' | 'review';
  status: 'off_clock' | 'on_break' | 'setup' | 'running' | 'unclassified' | 'review'; choiceRequired: boolean;
  actions: { canEstablishStream: boolean; canSwitch: boolean; canFinishSetup: boolean; canStop: boolean };
  shift: null | { id: string; clockInCommandId: string | null; clockInAt: string;
    breakStartedAt: string | null; breakType: 'lunch' | 'rest' | 'other' | null; status: 'open'; project: ProjectView };
  activity: ActivityView | null;
}
export interface Observation {
  id: string; revision: number; lastTransitionId: string | null; issuedAt: string; expiresAt: string;
  shiftRef: { kind: 'shift'; id: string } | null; currentGeneration: string | null; currentHeadCommandId: string | null;
}
export interface Snapshot {
  protocolVersion: 1; asOf: string; deviceId: string;
  capability: { mode: 'unavailable' | 'active' | 'closing_only'; reasonCode: 'not_ready' | 'starts_disabled' | null };
  observation: Observation | null;
  stream: null | { clientGeneration: string; headSequence: number; headCommandId: string; headAfterRevision: number; status: 'active' | 'blocked' };
  state: PersonalState | null;
}
export type Intent = { kind: 'establish_stream'; previousGeneration: string | null; previousHeadCommandId: string | null }
  | { kind: 'stop' } | { kind: 'finish_setup'; projectId: string; costCodeId: string | null }
  | { kind: 'switch'; projectId: string; selectionId: string; selectionRevision: number; menuVersionId: string;
    definitionVersionId: string; scope: 'general' | 'specific'; unit: UnitCommandBasis | null; machineKind: MachineKind | null; values: Answers };
export interface Payload {
  deviceId: string; clientGeneration: string; clientSequence: number; predecessorCommandId: string | null;
  expectedRevision: number; basis: { observationId: string }; shiftRef: { kind: 'shift' | 'clock_command'; id: string } | null;
  tappedAt: string; clockCheckedAt: string | null; clockSkewMs: number | null; intent: Intent;
}
export class ActivityProtocolError extends Error {
  constructor() { super('Activity information is unavailable. Refresh before changing work.'); this.name = 'ActivityProtocolError'; }
}
const fail = (): never => { throw new ActivityProtocolError(); };
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail();
  const o = value as Record<string, unknown>;
  if (Object.keys(o).length !== keys.length || keys.some(k => !Object.hasOwn(o,k))) return fail();
  return o;
}
const enumeration = <const T extends string>(value: unknown, choices: readonly T[]): T =>
  typeof value === 'string' && choices.includes(value as T) ? value as T : fail();
const integer = (value: unknown, min=0): number => typeof value === 'number' && Number.isSafeInteger(value) && value >= min ? value : fail();
const number = (value: unknown): number => typeof value === 'number' && Number.isFinite(value) ? value : fail();
const bool = (value: unknown): boolean => typeof value === 'boolean' ? value : fail();
const nullable = <T>(value: unknown, parser: (v: unknown) => T): T | null => value === null ? null : parser(value);
export const activityUuid = (value: unknown): string => typeof value === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value) ? value : fail();
function text(value: unknown, max: number, min=0): string {
  if (typeof value !== 'string') return fail();
  const points=Array.from(value);
  if (points.length < min || points.length > max || value.includes('\0') || points.some(c => { const n=c.codePointAt(0)!; return n>=0xd800 && n<=0xdfff; })) return fail();
  return value;
}
/** Reject accessors/prototypes before invoking JSON.stringify or reading values. */
function plainClone<T>(value: T, maxBytes: number): T {
  const seen=new Set<object>(); let nodes=0;
  const visit=(v: unknown, depth: number): void => {
    if (++nodes>10000 || depth>24) return fail();
    if (v===null || typeof v==='boolean') return;
    if (typeof v==='number') { number(v); return; }
    if (typeof v==='string') { text(v,maxBytes); return; }
    if (!v || typeof v!=='object' || seen.has(v)) return fail();
    const proto=Object.getPrototypeOf(v);
    if ((Array.isArray(v) ? proto!==Array.prototype : proto!==Object.prototype && proto!==null) || Object.getOwnPropertySymbols(v).length) return fail();
    seen.add(v);
    for (const [k,d] of Object.entries(Object.getOwnPropertyDescriptors(v))) {
      if (Array.isArray(v) && k==='length') continue;
      text(k,120); if (!d.enumerable || !('value' in d)) return fail(); visit(d.value,depth+1);
    }
    seen.delete(v);
  };
  visit(value,0); const encoded=JSON.stringify(value);
  if (typeof encoded!=='string' || new TextEncoder().encode(encoded).byteLength>maxBytes) return fail();
  return JSON.parse(encoded) as T;
}
function timestamp(value: unknown, input=false): string {
  if (typeof value!=='string') return fail();
  const regex=input ? /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(?:Z|[+-](?:0\d|1[0-4]):[0-5]\d)$/ : /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{6})Z$/;
  const m=regex.exec(value); if (!m) return fail();
  const [y,mo,d,h,mi,s]=m.slice(1,7).map(Number);
  const leap=y%4===0 && (y%100!==0 || y%400===0);
  const days=[31,leap?29:28,31,30,31,30,31,31,30,31,30,31];
  if (y<1 || mo<1 || mo>12 || d<1 || d>days[mo-1] || h>23 || mi>59 || s>59 || !Number.isFinite(Date.parse(value))) return fail();
  return value;
}
// PostgreSQL emits microseconds; Date.parse alone loses the final three digits.
const ticks = (value: string): bigint => BigInt(Date.parse(value))*1000n + BigInt(value.slice(23,26));
function machine(value: unknown): MachineKind | null { return nullable(value,v=>enumeration(v,['forklift','tele_handler','scissor_lift','spider_suction'])); }
function answers(value: unknown): Answers {
  if (!value || typeof value!=='object' || Array.isArray(value) || Object.keys(value).length>40) return fail();
  const result: Answers=Object.create(null);
  for (const [key,v] of Object.entries(value)) {
    if (!/^[a-z][a-z0-9_]{0,79}$/.test(key)) return fail();
    if (typeof v==='string') result[key]=text(v,500);
    else if (typeof v==='number') result[key]=number(v);
    else if (typeof v==='boolean') result[key]=v;
    else if (Array.isArray(v) && v.length<=50) {
      const ids=v.map(item=>text(item,80,1)); if(new Set(ids).size!==ids.length) return fail(); result[key]=ids;
    } else return fail();
  }
  return result;
}
function unitCommand(value: unknown): UnitCommandBasis {
  const o=object(value,['id','operationalRevision','factId','factRevision','incarnationEpoch','bindingEpoch','projectEpoch','openingEpoch','originProjectEpoch','originOpeningEpoch']);
  return {id:activityUuid(o.id),operationalRevision:integer(o.operationalRevision),factId:activityUuid(o.factId),factRevision:integer(o.factRevision,1),incarnationEpoch:integer(o.incarnationEpoch),bindingEpoch:integer(o.bindingEpoch),projectEpoch:integer(o.projectEpoch),openingEpoch:nullable(o.openingEpoch,integer),originProjectEpoch:nullable(o.originProjectEpoch,integer),originOpeningEpoch:nullable(o.originOpeningEpoch,integer)};
}
function project(value: unknown): ProjectView {
  const o=object(value,['visibility','id','name','jobCode']);
  if(o.visibility==='available') return {visibility:'available',id:activityUuid(o.id),name:text(o.name,100000,1),jobCode:nullable(o.jobCode,v=>text(v,100000))};
  const visibility=enumeration(o.visibility,['unavailable','unassigned']);
  if(o.id!==null || o.name!==null || o.jobCode!==null) return fail();
  return {visibility,id:null,name:null,jobCode:null};
}
function unit(value: unknown): UnitBasis {
  const o=object(value,['id','projectId','openingId','operationalRevision','incarnationEpoch','bindingEpoch','projectEpoch','openingEpoch','fact','eligibleForCapture','ineligibleReason']);
  const projectId=nullable(o.projectId,activityUuid), openingId=nullable(o.openingId,activityUuid);
  const projectEpoch=nullable(o.projectEpoch,integer), openingEpoch=nullable(o.openingEpoch,integer);
  if((projectId===null)!==(projectEpoch===null) || (openingId===null)!==(openingEpoch===null)) return fail();
  const fact=nullable(o.fact,v=>{
    const f=object(v,['id','revision','eventKind','originProjectEpoch','originOpeningEpoch','dimensions','estimated']);
    const dimensions=nullable(f.dimensions,v=>{
      const d=object(v,['widthIn','heightIn','source','original']);
      const widthIn=number(d.widthIn),heightIn=number(d.heightIn); if(widthIn<=0 || heightIn<=0 || widthIn>100000 || heightIn>100000) return fail();
      const source=enumeration(d.source,['measured','plans','estimated']);
      const original=nullable(d.original,v=>{
        const r=object(v,['width','height','unit','source','sourceReference']);
        const width=number(r.width),height=number(r.height),u=enumeration(r.unit,['in','ft','mm','cm']);
        if(width<=0 || height<=0 || r.source!==source) return fail();
        const scale=u==='in'?1:u==='ft'?12:u==='mm'?1/25.4:1/2.54;
        for(const [actual,expected] of [[widthIn,width*scale],[heightIn,height*scale]]) if(!Number.isFinite(expected) || Math.abs(actual-expected)>Math.max(actual,expected)*1e-12) return fail();
        return {width,height,unit:u,source,sourceReference:nullable(r.sourceReference,v=>text(v,500,1))};
      });
      return {widthIn,heightIn,source,original};
    });
    const estimated=nullable(f.estimated,bool);
    if(dimensions && estimated!==(dimensions.source==='estimated')) return fail();
    const eventKind=enumeration(f.eventKind,['observation','legacy_observation','incomplete','cleared','relink']);
    if((eventKind==='cleared' || eventKind==='incomplete') && dimensions!==null) return fail();
    return {id:activityUuid(f.id),revision:integer(f.revision,1),eventKind,originProjectEpoch:nullable(f.originProjectEpoch,integer),originOpeningEpoch:nullable(f.originOpeningEpoch,integer),dimensions,estimated};
  });
  const eligibleForCapture=bool(o.eligibleForCapture);
  const ineligibleReason=nullable(o.ineligibleReason,v=>enumeration(v,['unassigned','missing_observation','incomplete_dimensions']));
  if(eligibleForCapture ? projectId===null || !fact?.dimensions?.original || ineligibleReason!==null : ineligibleReason===null) return fail();
  return {id:activityUuid(o.id),projectId,openingId,operationalRevision:integer(o.operationalRevision),incarnationEpoch:integer(o.incarnationEpoch),bindingEpoch:integer(o.bindingEpoch),projectEpoch,openingEpoch,fact,eligibleForCapture,ineligibleReason};
}
function capture(value: unknown): CaptureView {
  const o=object(value,['definitionVersionId','menuVersionId','selectionId','selectionRevision','scope','labelEn','labelEs','machineKind','values','unitAtStart']);
  const scope=enumeration(o.scope,['general','specific']), unitAtStart=nullable(o.unitAtStart,unitCommand),machineKind=machine(o.machineKind);
  if((scope==='general')!==(unitAtStart===null) || (scope==='general' && machineKind!==null && !['forklift','tele_handler'].includes(machineKind))) return fail();
  return {definitionVersionId:activityUuid(o.definitionVersionId),menuVersionId:activityUuid(o.menuVersionId),selectionId:activityUuid(o.selectionId),selectionRevision:integer(o.selectionRevision,1),scope,labelEn:text(o.labelEn,120,1),labelEs:text(o.labelEs,120,1),machineKind,values:answers(o.values),unitAtStart};
}
function activity(value: unknown): ActivityView {
  if(value && typeof value==='object' && (value as Record<string,unknown>).visibility==='unavailable') { object(value,['visibility']); return {visibility:'unavailable'}; }
  const o=object(value,['visibility','source','startedAt','project','capture','unit']);
  if(o.visibility!=='available') return fail(); const s=object(o.source,['kind','id']);
  return {visibility:'available',source:{kind:enumeration(s.kind,['custom','unit','task','service','phase','setup']),id:activityUuid(s.id)},startedAt:timestamp(o.startedAt),project:project(o.project),capture:nullable(o.capture,capture),unit:nullable(o.unit,unit)};
}
function state(value: unknown): PersonalState {
  const o=object(value,['revision','lastTransitionId','integrity','status','choiceRequired','actions','shift','activity']);
  const a=object(o.actions,['canEstablishStream','canSwitch','canFinishSetup','canStop']);
  const shift=nullable(o.shift,v=>{
    const s=object(v,['id','clockInCommandId','clockInAt','breakStartedAt','breakType','status','project']);
    if(s.status!=='open') return fail(); const breakStartedAt=nullable(s.breakStartedAt,timestamp),breakType=nullable(s.breakType,v=>enumeration(v,['lunch','rest','other']));
    if((breakStartedAt===null)!==(breakType===null)) return fail();
    return {id:activityUuid(s.id),clockInCommandId:nullable(s.clockInCommandId,activityUuid),clockInAt:timestamp(s.clockInAt),breakStartedAt,breakType,status:'open' as const,project:project(s.project)};
  });
  const status=enumeration(o.status,['off_clock','on_break','setup','running','unclassified','review']),active=nullable(o.activity,activity);
  if((status==='off_clock' && shift!==null) || (status==='on_break' && (!shift?.breakStartedAt || active!==null)) || (['running','setup'].includes(status) && (!shift || !active))) return fail();
  return {revision:integer(o.revision),lastTransitionId:nullable(o.lastTransitionId,activityUuid),integrity:enumeration(o.integrity,['clean','legacy_conflict','review']),status,choiceRequired:bool(o.choiceRequired),actions:{canEstablishStream:bool(a.canEstablishStream),canSwitch:bool(a.canSwitch),canFinishSetup:bool(a.canFinishSetup),canStop:bool(a.canStop)},shift,activity:active};
}
export function parseReceiptReply(value: unknown, expectedCommandId: string): ReceiptReply {
  const o=object(plainClone(value,20000),['protocolVersion','availability','receipt']);
  if(o.protocolVersion!==1) return fail();
  if(o.availability==='unavailable') { if(o.receipt!==null) return fail(); return {protocolVersion:1,availability:'unavailable',receipt:null}; }
  if(o.availability!=='available') return fail();
  const r=object(o.receipt,['protocolVersion','commandId','status','reasonCode','beforeRevision','afterRevision','transitionId','effectiveAt']);
  const status=enumeration(r.status,['applied','noop','conflict','refused']),beforeRevision=integer(r.beforeRevision),afterRevision=integer(r.afterRevision);
  const transitionId=nullable(r.transitionId,activityUuid),effectiveAt=nullable(r.effectiveAt,timestamp),reasonCode=nullable(r.reasonCode,v=>text(v,80,1));
  if(r.protocolVersion!==1 || activityUuid(r.commandId)!==activityUuid(expectedCommandId) ||
    (status==='applied' ? beforeRevision>=Number.MAX_SAFE_INTEGER || afterRevision!==beforeRevision+1 || transitionId===null || effectiveAt===null : afterRevision!==beforeRevision || transitionId!==null || effectiveAt!==null) ||
    (['conflict','refused'].includes(status) && reasonCode===null)) return fail();
  return {protocolVersion:1,availability:'available',receipt:{protocolVersion:1,commandId:expectedCommandId,status,reasonCode,beforeRevision,afterRevision,transitionId,effectiveAt}};
}
export function parseUnitBasisReply(value: unknown, expectedUnitId: string): UnitBasisReply {
  const o=object(plainClone(value,100000),['protocolVersion','asOf','availability','unit']);
  if(o.protocolVersion!==1) return fail(); const asOf=timestamp(o.asOf);
  if(o.availability==='unavailable') { if(o.unit!==null) return fail(); return {protocolVersion:1,asOf,availability:'unavailable',unit:null}; }
  if(o.availability!=='available') return fail(); const parsed=unit(o.unit);
  if(parsed.id!==activityUuid(expectedUnitId)) return fail(); return {protocolVersion:1,asOf,availability:'available',unit:parsed};
}
export function parseSnapshot(value: unknown, expectedDeviceId: string): Snapshot {
  const o=object(plainClone(value,100000),['protocolVersion','asOf','deviceId','capability','observation','stream','state']);
  if(o.protocolVersion!==1 || activityUuid(o.deviceId)!==activityUuid(expectedDeviceId)) return fail();
  const c=object(o.capability,['mode','reasonCode']),mode=enumeration(c.mode,['unavailable','active','closing_only']);
  const reasonCode=nullable(c.reasonCode,v=>enumeration(v,['not_ready','starts_disabled']));
  if((mode==='unavailable' && reasonCode!=='not_ready') || (mode==='active' && reasonCode!==null) || (mode==='closing_only' && reasonCode!=='starts_disabled')) return fail();
  const observation=nullable(o.observation,v=>{
    const b=object(v,['id','revision','lastTransitionId','issuedAt','expiresAt','shiftRef','currentGeneration','currentHeadCommandId']);
    const issuedAt=timestamp(b.issuedAt),expiresAt=timestamp(b.expiresAt),currentGeneration=nullable(b.currentGeneration,activityUuid),currentHeadCommandId=nullable(b.currentHeadCommandId,activityUuid);
    if(ticks(expiresAt)<=ticks(issuedAt) || ticks(expiresAt)-ticks(issuedAt)>16n*60n*60n*1000000n || (currentGeneration===null)!==(currentHeadCommandId===null)) return fail();
    const shiftRef=nullable(b.shiftRef,v=>{const r=object(v,['kind','id']);if(r.kind!=='shift') return fail();return {kind:'shift' as const,id:activityUuid(r.id)};});
    return {id:activityUuid(b.id),revision:integer(b.revision),lastTransitionId:nullable(b.lastTransitionId,activityUuid),issuedAt,expiresAt,shiftRef,currentGeneration,currentHeadCommandId};
  });
  const stream=nullable(o.stream,v=>{
    const s=object(v,['clientGeneration','headSequence','headCommandId','headAfterRevision','status']);
    return {clientGeneration:activityUuid(s.clientGeneration),headSequence:integer(s.headSequence),headCommandId:activityUuid(s.headCommandId),headAfterRevision:integer(s.headAfterRevision),status:enumeration(s.status,['active','blocked'])};
  });
  const personal=nullable(o.state,state);
  if(mode==='unavailable' && (observation!==null || stream!==null || personal!==null)) return fail();
  if(mode!=='unavailable' && personal===null) return fail();
  if(observation && (!personal || observation.revision!==personal.revision || observation.lastTransitionId!==personal.lastTransitionId || observation.shiftRef?.id!==(personal.shift?.id) || observation.currentGeneration!==(stream?.clientGeneration??null) || observation.currentHeadCommandId!==(stream?.headCommandId??null))) return fail();
  if(personal && ((mode!=='active' && (personal.actions.canSwitch || personal.actions.canFinishSetup)) || (!observation && Object.values(personal.actions).some(Boolean)))) return fail();
  return {protocolVersion:1,asOf:timestamp(o.asOf),deviceId:expectedDeviceId,capability:{mode,reasonCode},observation,stream,state:personal};
}
/** Exact admitted payload, schema-specific answers are validated separately. */
export function parsePayload(value: unknown): Payload {
  const o=object(plainClone(value,20000),['deviceId','clientGeneration','clientSequence','predecessorCommandId','expectedRevision','basis','shiftRef','tappedAt','clockCheckedAt','clockSkewMs','intent']);
  const b=object(o.basis,['observationId']),clientSequence=integer(o.clientSequence),predecessorCommandId=nullable(o.predecessorCommandId,activityUuid);
  const shiftRef=nullable(o.shiftRef,v=>{const s=object(v,['kind','id']);return {kind:enumeration(s.kind,['shift','clock_command']),id:activityUuid(s.id)};});
  if((clientSequence===0)!==(predecessorCommandId===null)) return fail();
  const raw=o.intent as Record<string,unknown>; let intent: Intent;
  if(raw?.kind==='establish_stream') {
    const i=object(raw,['kind','previousGeneration','previousHeadCommandId']);
    const previousGeneration=nullable(i.previousGeneration,activityUuid),previousHeadCommandId=nullable(i.previousHeadCommandId,activityUuid);
    if(clientSequence!==0 || shiftRef?.kind==='clock_command' || (previousGeneration===null)!==(previousHeadCommandId===null)) return fail();
    intent={kind:'establish_stream',previousGeneration,previousHeadCommandId};
  } else {
    if(clientSequence===0 || !shiftRef) return fail();
    if(raw?.kind==='stop') {object(raw,['kind']);intent={kind:'stop'};}
    else if(raw?.kind==='finish_setup') {const i=object(raw,['kind','projectId','costCodeId']);intent={kind:'finish_setup',projectId:activityUuid(i.projectId),costCodeId:nullable(i.costCodeId,activityUuid)};}
    else {
      const i=object(raw,['kind','projectId','selectionId','selectionRevision','menuVersionId','definitionVersionId','scope','unit','machineKind','values']);
      if(i.kind!=='switch') return fail(); const scope=enumeration(i.scope,['general','specific']),basis=nullable(i.unit,unitCommand),machineKind=machine(i.machineKind);
      if((scope==='general')!==(basis===null) || (scope==='general' && machineKind!==null && !['forklift','tele_handler'].includes(machineKind))) return fail();
      intent={kind:'switch',projectId:activityUuid(i.projectId),selectionId:activityUuid(i.selectionId),selectionRevision:integer(i.selectionRevision,1),menuVersionId:activityUuid(i.menuVersionId),definitionVersionId:activityUuid(i.definitionVersionId),scope,unit:basis,machineKind,values:answers(i.values)};
    }
  }
  return {deviceId:activityUuid(o.deviceId),clientGeneration:activityUuid(o.clientGeneration),clientSequence,predecessorCommandId,expectedRevision:integer(o.expectedRevision),basis:{observationId:activityUuid(b.observationId)},shiftRef,tappedAt:timestamp(o.tappedAt,true),clockCheckedAt:nullable(o.clockCheckedAt,v=>timestamp(v,true)),clockSkewMs:nullable(o.clockSkewMs,number),intent};
}
/** Copy all tokens from one eligible response; never derive missing IDs/epochs. */
export function unitCommandBasis(value: unknown): UnitCommandBasis {
  const u=unit(plainClone(value,100000));
  if(!u.eligibleForCapture || !u.fact || u.projectEpoch===null) return fail();
  return {id:u.id,operationalRevision:u.operationalRevision,factId:u.fact.id,factRevision:u.fact.revision,incarnationEpoch:u.incarnationEpoch,bindingEpoch:u.bindingEpoch,projectEpoch:u.projectEpoch,openingEpoch:u.openingEpoch,originProjectEpoch:u.fact.originProjectEpoch,originOpeningEpoch:u.fact.originOpeningEpoch};
}

/** Plain, bounded persistence copy; no caller serializer or accessor runs. */
export const activityJsonClone = <T>(value:T):T => plainClone(value,45000);
