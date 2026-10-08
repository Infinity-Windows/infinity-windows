/** Pure, dormant allocation lineage. A prediction is never a server receipt. */
import { activityUuid, parsePayload, parseReceiptReply, type Payload, type Receipt } from './protocol';
import { exactV2, freezeV2, parsePayloadV2, parseCommandReplyV2, parseReceiptReplyV2, timeTicksV2, type PayloadV2, type ReceiptReplyV2, type CommandReplyV2 } from './protocolV2';
export interface AllocationCommand {protocol:2;ownerId:string;commandId:string;payload:PayloadV2}
export interface AllocationPrediction {sequence:number;afterRevision:number;allocationId:string|null;status:'applied'|'noop'}
export type AllocationHold='parent_unknown'|'parent_refused'|'parent_conflict'|'prediction_mismatch'|'intent_unproven';
/** Future transport must couple this exact saved request to its actual response.
 * A lookup cannot construct this evidence: SQL intentionally omits intent from
 * lookup receipts. This pure type is not authentication or transport proof. */
export interface SubmissionProvenanceV2 {command:AllocationCommand;reply:CommandReplyV2}
export type Confirmation={kind:'pending'}|{kind:'confirmed';reply:ReceiptReplyV2;submission:SubmissionProvenanceV2}|{kind:'held';reason:AllocationHold};
export interface PredictedV2 {protocol:2;command:AllocationCommand;prediction:AllocationPrediction;confirmation:Confirmation}
export interface SettledV1 {protocol:1;ownerId:string;commandId:string;payload:Payload;receipt:Receipt;allocationId:string|null}
export type AllocationPredecessor=SettledV1|PredictedV2;
export function allocationCommand(value:AllocationCommand):AllocationCommand{
  const command=freezeV2(value);exactV2(command,['protocol','ownerId','commandId','payload']);if(command.protocol!==2)throw new Error('Invalid allocation command');
  return freezeV2({protocol:2,ownerId:activityUuid(command.ownerId),commandId:activityUuid(command.commandId),payload:parsePayloadV2(command.payload)});
}
export function predictAllocation(value:AllocationCommand,status:'applied'|'noop'):PredictedV2{
  const command=allocationCommand(value),p=command.payload,kind=p.intent.kind;
  if(!['applied','noop'].includes(status)||(kind==='establish_stream'?status!=='noop':kind!=='stop'&&status!=='applied')||(status==='applied'&&p.expectedRevision>=Number.MAX_SAFE_INTEGER))throw new Error('Invalid allocation prediction');
  const creates=kind==='switch'||kind==='finish_setup';
  return freezeV2({protocol:2,command,prediction:{sequence:p.clientSequence,afterRevision:p.expectedRevision+(status==='applied'?1:0),allocationId:creates?command.commandId:p.expectedAllocationId,status},confirmation:{kind:'pending'}});
}
/** Unknown/unavailable is an outcome requiring retained review, not permission
 * to retry. Once held, later evidence cannot silently revive this original. */
export function confirmAllocation(value:PredictedV2,raw:unknown,submitted?:SubmissionProvenanceV2):PredictedV2{
  const original=freezeV2(value);
  if(original.confirmation.kind==='held')return original;
  const expected=predictAllocation(original.command,original.prediction.status);
  const hold=(reason:AllocationHold):PredictedV2=>freezeV2({...original,confirmation:{kind:'held',reason}});
  if(JSON.stringify(expected.prediction)!==JSON.stringify(original.prediction))return hold('prediction_mismatch');
  if(raw===null)return hold('parent_unknown');
  let reply:ReceiptReplyV2;try{reply=parseReceiptReplyV2(raw,original.command.commandId);}catch{return hold('prediction_mismatch');}
  if(reply.availability==='unavailable')return hold('parent_unknown');
  const r=reply.receipt,p=original.command.payload;
  if(r.status==='refused')return hold('parent_refused');if(r.status==='conflict')return hold('parent_conflict');
  if(r.status!==expected.prediction.status||r.beforeRevision!==p.expectedRevision||r.afterRevision!==expected.prediction.afterRevision)return hold('prediction_mismatch');
  if(r.status==='applied'&&(p.clockSkewMs===null||!r.effectiveAt||timeTicksV2(r.effectiveAt)!==timeTicksV2(p.tappedAt)-BigInt(p.clockSkewMs)*1000n))return hold('prediction_mismatch');
  const creates=p.intent.kind==='switch'||p.intent.kind==='finish_setup';
  if(creates){
    const a=reply.allocation;
    if(!a||a.id!==expected.prediction.allocationId||a.predecessorId!==p.expectedAllocationId||p.shiftRef?.kind!=='shift'||a.shiftId!==p.shiftRef.id||p.clockSkewMs===null||timeTicksV2(a.originalTappedAt)!==timeTicksV2(p.tappedAt)||timeTicksV2(a.effectiveAt)!==timeTicksV2(p.tappedAt)-BigInt(p.clockSkewMs)*1000n)return hold('prediction_mismatch');
  }else if(reply.allocation!==null)return hold('prediction_mismatch');
  const provenance=submitted??(original.confirmation.kind==='confirmed'?original.confirmation.submission:undefined);
  if(!provenance)return hold('intent_unproven');
  let submission:SubmissionProvenanceV2;
  try{
    const proof=freezeV2(provenance);exactV2(proof,['command','reply']);allocationCommand(proof.command);
    // Deliberately compare the full saved bytes, not a subset of lineage fields.
    if(JSON.stringify(proof.command)!==JSON.stringify(original.command))return hold('intent_unproven');
    const commandReply=parseCommandReplyV2(proof.reply,original.command.commandId);
    if(commandReply.availability!=='available'||JSON.stringify(commandReply.receipt)!==JSON.stringify(reply.receipt))return hold('intent_unproven');
    submission={command:proof.command,reply:commandReply};
  }catch{return hold('intent_unproven');}
  if(original.confirmation.kind==='confirmed'&&JSON.stringify(original.confirmation.reply)!==JSON.stringify(reply))return hold('prediction_mismatch');
  return freezeV2({...original,confirmation:{kind:'confirmed',reply,submission}});
}
export function predecessorPosition(value:AllocationPredecessor):{ownerId:string;deviceId:string;generation:string;commandId:string;sequence:number;afterRevision:number;allocationId:string|null;status:'pending'|'confirmed'|'held'}{
  const p=freezeV2(value);
  if(p.protocol===1){
    const payload=parsePayload(p.payload),reply=parseReceiptReply({protocolVersion:1,availability:'available',receipt:p.receipt},p.commandId);
    if(reply.availability!=='available'||!['applied','noop'].includes(reply.receipt.status)||reply.receipt.beforeRevision!==payload.expectedRevision)throw new Error('Unsettled version-one predecessor');
    return {ownerId:activityUuid(p.ownerId),deviceId:payload.deviceId,generation:payload.clientGeneration,commandId:activityUuid(p.commandId),sequence:payload.clientSequence,afterRevision:reply.receipt.afterRevision,allocationId:p.allocationId===null?null:activityUuid(p.allocationId),status:'confirmed'};
  }
  if(p.protocol!==2)throw new Error('Invalid predecessor protocol');
  const valid=predictAllocation(p.command,p.prediction.status);
  if(JSON.stringify(valid.prediction)!==JSON.stringify(p.prediction))throw new Error('Invalid predecessor prediction');
  const checked=p.confirmation.kind==='confirmed'?confirmAllocation(p,p.confirmation.reply):p;
  if(!['pending','confirmed','held'].includes(checked.confirmation.kind))throw new Error('Invalid predecessor confirmation');
  return {ownerId:valid.command.ownerId,deviceId:valid.command.payload.deviceId,generation:valid.command.payload.clientGeneration,commandId:valid.command.commandId,...valid.prediction,status:checked.confirmation.kind};
}
