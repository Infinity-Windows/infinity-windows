import type { ClockTrustStamp } from '../clockSkew';
import type { ActivityCommandRecord } from './journal';
import { activityUuid, parsePayload, parseReceiptReply, parseSnapshot, type Intent, type Payload, type Snapshot } from './protocol';

export type ActivityPlan = {kind:'ready';commandId:string;ownerId:string;payload:Payload}
  | {kind:'held';reason:'unavailable'|'expired_observation'|'action_unavailable'|'predecessor_unknown'|'needs_reaffirmation'};
type Action = Exclude<Intent,{kind:'establish_stream'}> | {kind:'establish_stream';newGeneration:string};
const ticks=(at:string)=>BigInt(Date.parse(at))*1000n+BigInt(at.slice(23,26));

/** Plan one explicit tap against fresh server evidence and the exact durable
 * local head. No ID minting, storage, retry, payroll call or automatic rebase.
 * elapsedMs starts BEFORE the fresh RPC, conservatively including transit.
 * Device wall time only supplies tap evidence; it never measures this lease. */
export function planActivityCommand(input:{ownerId:string;deviceId:string;commandId:string;
  snapshot:Snapshot;elapsedMs:number;head:ActivityCommandRecord|null;action:Action;stamp:ClockTrustStamp}):ActivityPlan {
  const ownerId=activityUuid(input.ownerId),deviceId=activityUuid(input.deviceId),commandId=activityUuid(input.commandId);
  const snapshot=parseSnapshot(input.snapshot,deviceId),{state,observation,stream}=snapshot;
  const hold=(reason:Extract<ActivityPlan,{kind:'held'}>['reason']):ActivityPlan=>({kind:'held',reason});
  if(!state || !observation || snapshot.capability.mode==='unavailable')return hold('unavailable');
  if(!Number.isFinite(input.elapsedMs) || input.elapsedMs<0 || input.elapsedMs>16*60*60*1000 ||
    ticks(observation.expiresAt)-ticks(snapshot.asOf)<=BigInt(Math.ceil(input.elapsedMs*1000)))return hold('expired_observation');
  const head=input.head;
  if(head){
    activityUuid(head.commandId);
    if(head.encodingVersion!==2 || head.ownerId!==ownerId || head.payload.deviceId!==deviceId || typeof head.uncertain!=='boolean')return hold('needs_reaffirmation');
    parsePayload(head.payload);
    if(head.receipt)parseReceiptReply({protocolVersion:1,availability:'available',receipt:head.receipt},head.commandId);
    if(commandId===head.commandId)return hold('needs_reaffirmation');
    // Explicit establishment may retire an uncertain older generation. Keep
    // that original journal row for reconciliation. The server fences the race
    // against the exact observed previous head; no descendant is auto-rebased.
    if(input.action.kind!=='establish_stream' && (!head.receipt || head.uncertain))return hold('predecessor_unknown');
  }
  let generation:string,sequence:number,predecessor:string|null,intent:Intent;
  if(input.action.kind==='establish_stream'){
    if(!state.actions.canEstablishStream)return hold('action_unavailable');
    generation=activityUuid(input.action.newGeneration);
    if(generation===stream?.clientGeneration || generation===head?.payload.clientGeneration)return hold('needs_reaffirmation');
    sequence=0;predecessor=null;
    intent={kind:'establish_stream',previousGeneration:observation.currentGeneration,previousHeadCommandId:observation.currentHeadCommandId};
  }else{
    if(!stream || !head || stream.status!=='active' || stream.clientGeneration!==head.payload.clientGeneration ||
      stream.headCommandId!==head.commandId || stream.headSequence!==head.payload.clientSequence ||
      stream.headAfterRevision!==state.revision || head.receipt!.afterRevision!==state.revision ||
      !['applied','noop'].includes(head.receipt!.status) || stream.headSequence>=Number.MAX_SAFE_INTEGER)return hold('needs_reaffirmation');
    const permitted=input.action.kind==='stop'?state.actions.canStop:
      input.action.kind==='finish_setup'?state.actions.canFinishSetup:state.actions.canSwitch;
    if(!permitted || (input.action.kind!=='stop' && (snapshot.capability.mode!=='active' || state.integrity!=='clean')))return hold('action_unavailable');
    if(!observation.shiftRef)return hold('needs_reaffirmation');
    generation=stream.clientGeneration;sequence=stream.headSequence+1;predecessor=stream.headCommandId;intent=input.action;
  }
  // The protocol parser freezes answers/tokens and enforces the whole envelope.
  const payload=parsePayload({deviceId,clientGeneration:generation,clientSequence:sequence,predecessorCommandId:predecessor,
    expectedRevision:observation.revision,basis:{observationId:observation.id},shiftRef:observation.shiftRef,
    tappedAt:input.stamp.tappedAt,clockCheckedAt:input.stamp.clockCheckedAt,clockSkewMs:input.stamp.clockSkewMs,intent});
  return {kind:'ready',commandId,ownerId,payload};
}
