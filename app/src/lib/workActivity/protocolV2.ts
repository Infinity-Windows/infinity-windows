/** Dormant K6 wire boundary. No transport, storage, clock or registration effects. */
import { ActivityProtocolError, activityUuid, parsePayload, parseReceiptReply, parseSnapshot,
  type Payload, type Receipt, type Snapshot, type PersonalState } from './protocol';

export type PayloadV2 = Payload & { expectedAllocationId: string | null; boundaryMode: 'trusted_original_tap' };
export type ReceiptV2 = Omit<Receipt,'protocolVersion'> & {protocolVersion:2};
export type CommandReplyV2 = {protocolVersion:2;availability:'unavailable';receipt:null}
  | {protocolVersion:2;availability:'available';receipt:ReceiptV2};
export interface AllocationView {id:string;predecessorId:string|null;boundaryMode:'trusted_original_tap';originalTappedAt:string;effectiveAt:string;shiftId:string;transitionId:string}
export type ReceiptReplyV2 = CommandReplyV2 & {allocation:AllocationView|null};
export type PersonalStateV2 = Omit<PersonalState,'shift'> & {shift:(NonNullable<PersonalState['shift']> & {allocationId:string|null})|null};
export type FullSnapshotV2 = Omit<Snapshot,'protocolVersion'|'state'> & {protocolVersion:2;state:PersonalStateV2|null};
export type SnapshotV2 = FullSnapshotV2 | {protocolVersion:2;availability:'unavailable';state:null};
const fail=():never=>{throw new ActivityProtocolError();};
export function exactV2(value:unknown,keys:readonly string[]):Record<string,unknown>{
  if(!value || typeof value!=='object' || Array.isArray(value))return fail();
  const o=value as Record<string,unknown>;
  if(Object.keys(o).length!==keys.length || keys.some(k=>!Object.hasOwn(o,k)))return fail();return o;
}
/** Bounded JSON copy rejects accessors, cycles, sparse arrays and non-JSON numbers. */
export function freezeV2<T>(value:T,maxBytes=100000):T{
  const seen=new Set<object>();let nodes=0;
  const walk=(v:unknown,depth:number):void=>{
    if(++nodes>10000 || depth>24)return fail();
    if(v===null || typeof v==='boolean')return;
    if(typeof v==='number'){if(!Number.isFinite(v))return fail();return;}
    if(typeof v==='string'){if(v.includes('\0') || Array.from(v).some(c=>{const n=c.codePointAt(0)!;return n>=0xd800&&n<=0xdfff;}))return fail();return;}
    if(!v || typeof v!=='object' || seen.has(v))return fail();
    const array=Array.isArray(v),proto=Object.getPrototypeOf(v);
    if((array?proto!==Array.prototype:proto!==Object.prototype&&proto!==null)||Object.getOwnPropertySymbols(v).length)return fail();
    const descriptors=Object.getOwnPropertyDescriptors(v);
    if(array&&(Object.keys(descriptors).length!==v.length+1||Array.from({length:v.length},(_,i)=>String(i)).some(k=>!Object.hasOwn(descriptors,k))))return fail();
    seen.add(v);
    for(const [key,d]of Object.entries(descriptors)){if(array&&key==='length')continue;if(!d.enumerable||!('value'in d))return fail();walk(key,depth+1);walk(d.value,depth+1);}
    seen.delete(v);
  };
  walk(value,0);const bytes=JSON.stringify(value);if(typeof bytes!=='string'||new TextEncoder().encode(bytes).length>maxBytes)return fail();
  const copy=JSON.parse(bytes) as T;
  const freeze=(v:unknown):void=>{if(v&&typeof v==='object'){Object.values(v).forEach(freeze);Object.freeze(v);}};freeze(copy);return copy;
}
export function wireTimeV2(value:unknown):string{
  if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(value))return fail();
  const ms=Date.parse(value);if(!Number.isFinite(ms)||new Date(ms).toISOString()!==value.slice(0,23)+'Z'||value.startsWith('0000'))return fail();return value;
}
/** Input timestamps have already passed the shared exact calendar parser. */
export function timeTicksV2(value:string):bigint{
  const ms=Date.parse(value);if(!Number.isFinite(ms))return fail();
  const fraction=/\.(\d{1,6})(?:Z|[+-]\d\d:\d\d)$/.exec(value)?.[1]??'';
  return BigInt(ms)*1000n+BigInt(fraction.padEnd(6,'0').slice(3));
}
export function parsePayloadV2(value:unknown):PayloadV2{
  const o=exactV2(freezeV2(value,21000),['deviceId','clientGeneration','clientSequence','predecessorCommandId','expectedRevision','basis','shiftRef','tappedAt','clockCheckedAt','clockSkewMs','intent','expectedAllocationId','boundaryMode']);
  if(o.boundaryMode!=='trusted_original_tap')return fail();
  const expectedAllocationId=o.expectedAllocationId===null?null:activityUuid(o.expectedAllocationId);
  const {expectedAllocationId:_allocation,boundaryMode:_boundary,...base}=o;
  const parsed=parsePayload(base);
  // SQL's shared envelope casts skew to a PostgreSQL integer.
  if(parsed.clockSkewMs!==null&&(!Number.isInteger(parsed.clockSkewMs)||parsed.clockSkewMs< -2147483648||parsed.clockSkewMs>2147483647))return fail();
  return freezeV2({...parsed,expectedAllocationId,boundaryMode:'trusted_original_tap'});
}
export function parseCommandReplyV2(value:unknown,commandId:string):CommandReplyV2{
  const o=exactV2(freezeV2(value,20000),['protocolVersion','availability','receipt']);activityUuid(commandId);
  if(o.protocolVersion!==2)return fail();
  if(o.availability==='unavailable'){if(o.receipt!==null)return fail();return {protocolVersion:2,availability:'unavailable',receipt:null};}
  if(o.availability!=='available')return fail();
  const r=exactV2(o.receipt,['protocolVersion','commandId','status','reasonCode','beforeRevision','afterRevision','transitionId','effectiveAt']);
  if(r.protocolVersion!==2)return fail();
  const parsed=parseReceiptReply({protocolVersion:1,availability:'available',receipt:{...r,protocolVersion:1}},commandId);
  if(parsed.availability!=='available'||(['applied','noop'].includes(parsed.receipt.status)&&parsed.receipt.reasonCode!==null))return fail();
  return freezeV2({protocolVersion:2,availability:'available',receipt:{...parsed.receipt,protocolVersion:2}} as const);
}
/** Receipt lookup adds allocation; command submission deliberately does not. */
export function parseReceiptReplyV2(value:unknown,commandId:string):ReceiptReplyV2{
  const o=exactV2(freezeV2(value,20000),['protocolVersion','availability','receipt','allocation']);
  const reply=parseCommandReplyV2({protocolVersion:o.protocolVersion,availability:o.availability,receipt:o.receipt},commandId);
  if(reply.availability==='unavailable'){if(o.allocation!==null)return fail();return {...reply,allocation:null};}
  let allocation:AllocationView|null=null;
  if(o.allocation!==null){
    const a=exactV2(o.allocation,['id','predecessorId','boundaryMode','originalTappedAt','effectiveAt','shiftId','transitionId']);
    if(a.boundaryMode!=='trusted_original_tap'||activityUuid(a.id)!==commandId||reply.receipt.status!=='applied')return fail();
    allocation={id:commandId,predecessorId:a.predecessorId===null?null:activityUuid(a.predecessorId),boundaryMode:'trusted_original_tap',originalTappedAt:wireTimeV2(a.originalTappedAt),effectiveAt:wireTimeV2(a.effectiveAt),shiftId:activityUuid(a.shiftId),transitionId:activityUuid(a.transitionId)};
    if(allocation.transitionId!==reply.receipt.transitionId||allocation.effectiveAt!==reply.receipt.effectiveAt||allocation.predecessorId===allocation.id)return fail();
  }
  return freezeV2({...reply,allocation});
}
export function parseSnapshotV2(value:unknown,deviceId:string):SnapshotV2{
  const copy=freezeV2(value);activityUuid(deviceId);
  if(copy&&typeof copy==='object'&&Object.hasOwn(copy,'availability')){
    const o=exactV2(copy,['protocolVersion','availability','state']);if(o.protocolVersion!==2||o.availability!=='unavailable'||o.state!==null)return fail();return {protocolVersion:2,availability:'unavailable',state:null};
  }
  const o=exactV2(copy,['protocolVersion','asOf','deviceId','capability','observation','stream','state']);if(o.protocolVersion!==2)return fail();
  let allocationId:string|null=null;let state=o.state;
  if(state!==null){
    const s=exactV2(state,['revision','lastTransitionId','integrity','status','choiceRequired','actions','shift','activity']);
    if(s.shift!==null){const h=exactV2(s.shift,['id','clockInCommandId','clockInAt','breakStartedAt','breakType','status','project','allocationId']);allocationId=h.allocationId===null?null:activityUuid(h.allocationId);const {allocationId:_id,...shift}=h;state={...s,shift};}
  }
  const parsed=parseSnapshot({...o,protocolVersion:1,state},deviceId);
  if(parsed.capability.mode!=='unavailable'&&!parsed.state?.shift)return fail();
  return freezeV2({...parsed,protocolVersion:2,state:parsed.state?{...parsed.state,shift:parsed.state.shift?{...parsed.state.shift,allocationId}:null}:null});
}
