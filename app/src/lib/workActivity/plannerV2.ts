/** Dormant pure prerequisites only. No durable append, send, retry or policy switch. */
import { activityUuid, type Intent } from './protocol';
import { exactV2, freezeV2, parsePayloadV2, parseSnapshotV2, timeTicksV2, wireTimeV2, type FullSnapshotV2 } from './protocolV2';
import { predecessorPosition, predictAllocation, type AllocationPredecessor, type PredictedV2 } from './allocationPredecessor';
type Action=Exclude<Intent,{kind:'establish_stream'}>|{kind:'establish_stream';newGeneration:string};
export interface OriginalTapV2 {ownerId:string;deviceId:string;commandId:string;action:Action;stamp:{tappedAt:string;clockCheckedAt:string|null;clockSkewMs:number|null}}
/** Supplied by the future authenticated caller; this module does not read login,
 * preview, catalog authority, selected job or device state on its own. */
export interface PlannerFencesV2 {userId:string|null;loginGeneration:number;deviceId:string;preview:boolean;foreground:boolean;selectedJobId:string|null;authorityToken:string}
export type HoldReasonV2='authentication_changed'|'context_changed'|'unavailable'|'expired_observation'|'untrusted_stamp'|'action_unavailable'|'predecessor_unknown'|'ancestor_held'|'original_already_observed'|'needs_reaffirmation'|'malformed';
interface Planned {original:OriginalTapV2;command:PredictedV2;parents:readonly AllocationPredecessor[];fences:PlannerFencesV2;lease:{asOf:string;expiresAt:string}}
export type PlanV2=({kind:'ready'|'descendant'}&Planned)|{kind:'held';permanent:true;reason:HoldReasonV2;original:OriginalTapV2;retained:Planned|null};
const hold=(original:OriginalTapV2,reason:HoldReasonV2,retained:Planned|null=null):PlanV2=>freezeV2({kind:'held',permanent:true,reason,original,retained});
function fenceReason(original:OriginalTapV2,a:PlannerFencesV2,b:PlannerFencesV2):HoldReasonV2|null{
  if(a.userId!==original.ownerId||b.userId!==original.ownerId||!Number.isSafeInteger(a.loginGeneration)||a.loginGeneration<0||a.loginGeneration!==b.loginGeneration)return 'authentication_changed';
  if(a.deviceId!==original.deviceId||b.deviceId!==original.deviceId||a.preview!==false||b.preview!==false||a.foreground!==true||b.foreground!==true||typeof a.authorityToken!=='string'||!a.authorityToken||a.authorityToken!==b.authorityToken||a.selectedJobId!==b.selectedJobId)return 'context_changed';
  if('projectId'in original.action&&original.action.projectId!==a.selectedJobId)return 'context_changed';return null;
}
function leaseValid(asOf:string,expiresAt:string,elapsedMs:number,stop:boolean):boolean{
  return Number.isFinite(elapsedMs)&&elapsedMs>=0&&elapsedMs<=16*3600000&&(stop||timeTicksV2(expiresAt)-timeTicksV2(asOf)>BigInt(Math.ceil(elapsedMs*1000)));
}
function trusted(original:OriginalTapV2,serverNow:string):boolean{
  const {stamp}=original;if(stamp.clockCheckedAt===null||stamp.clockSkewMs===null||!Number.isInteger(stamp.clockSkewMs)||Math.abs(stamp.clockSkewMs)>120000)return false;
  const now=timeTicksV2(wireTimeV2(serverNow)),checked=timeTicksV2(stamp.clockCheckedAt),corrected=timeTicksV2(stamp.tappedAt)-BigInt(stamp.clockSkewMs)*1000n;
  return now-checked<=24n*3600n*1000000n&&checked<=now+120n*1000000n&&corrected<=now&&now-corrected<=16n*3600n*1000000n;
}
function clockWithinLease(asOf:string,elapsedMs:number,serverNow:string):boolean{
  const now=timeTicksV2(wireTimeV2(serverNow)),start=timeTicksV2(asOf);
  return now>=start&&now<=start+BigInt(Math.ceil(elapsedMs*1000));
}
const phase=(s:FullSnapshotV2):'setup'|'running'|'none'=>s.state?.status==='setup'?'setup':s.state?.activity?'running':'none';
const afterPhase=(p:PredictedV2,current:ReturnType<typeof phase>)=>p.command.payload.intent.kind==='switch'?'running':p.command.payload.intent.kind==='establish_stream'?current:'none';
function fits(kind:Action['kind'],p:ReturnType<typeof phase>):boolean{return kind==='finish_setup'?p==='setup':kind==='switch'?p!=='setup':true;}
/** serverNow is explicit fixture/caller clock evidence, never Date.now(). A ready
 * result proves only these pure inputs; the backend still decides tap trust. */
export function planActivityV2(input:{original:OriginalTapV2;snapshot:unknown;sourceFences:PlannerFencesV2;currentFences:PlannerFencesV2;elapsedMs:number;serverNow:string;chain:readonly AllocationPredecessor[]}):PlanV2{
  const original=freezeV2(input.original);activityUuid(original.ownerId);activityUuid(original.deviceId);activityUuid(original.commandId);
  try{
    exactV2(original,['ownerId','deviceId','commandId','action','stamp']);exactV2(original.stamp,['tappedAt','clockCheckedAt','clockSkewMs']);
    if(original.action.kind==='establish_stream')exactV2(original.action,['kind','newGeneration']);
  }catch{return hold(original,'malformed');}
  const fence=fenceReason(original,input.sourceFences,input.currentFences);if(fence)return hold(original,fence);
  const parsed=parseSnapshotV2(input.snapshot,original.deviceId);
  if('availability'in parsed||!parsed.state||!parsed.observation||!parsed.state.shift||parsed.capability.mode==='unavailable')return hold(original,'unavailable');
  const snapshot=parsed,{state,observation,stream}=parsed,shift=parsed.state.shift,action=original.action,stop=action.kind==='stop';
  if(!leaseValid(snapshot.asOf,observation.expiresAt,input.elapsedMs,stop))return hold(original,'expired_observation');
  if(!clockWithinLease(snapshot.asOf,input.elapsedMs,input.serverNow))return hold(original,'untrusted_stamp');
  let generation:string,sequence:number,predecessor:string|null,revision=state.revision,allocationId=shift.allocationId,intent:Intent;
  const parents=freezeV2(input.chain);let pending=false,currentPhase=phase(snapshot);
  if(original.commandId===stream?.headCommandId||original.commandId===allocationId||parents.some(p=>predecessorPosition(p).commandId===original.commandId))return hold(original,'needs_reaffirmation');
  if(action.kind==='establish_stream'){
    if(!state.actions.canEstablishStream)return hold(original,'action_unavailable');generation=activityUuid(action.newGeneration);
    if(generation===stream?.clientGeneration||parents.some(p=>predecessorPosition(p).generation===generation))return hold(original,'needs_reaffirmation');
    sequence=0;predecessor=null;intent={kind:'establish_stream',previousGeneration:observation.currentGeneration,previousHeadCommandId:observation.currentHeadCommandId};
  }else{
    if(!stream||stream.status!=='active'||!parents.length||parents.length>100)return hold(original,'predecessor_unknown');
    let head=predecessorPosition(parents[0]);
    const rootPayload=parents[0].protocol===1?parents[0].payload:parents[0].command.payload;
    if(rootPayload.shiftRef?.kind!=='shift'||rootPayload.shiftRef.id!==shift.id)return hold(original,'needs_reaffirmation');
    if(head.status!=='confirmed'||head.ownerId!==original.ownerId||head.deviceId!==original.deviceId||head.generation!==stream.clientGeneration||head.sequence!==stream.headSequence||head.commandId!==stream.headCommandId||head.afterRevision!==state.revision||stream.headAfterRevision!==state.revision||head.allocationId!==allocationId)return hold(original,'needs_reaffirmation');
    for(const parent of parents.slice(1)){
      if(parent.protocol!==2)return hold(original,'needs_reaffirmation');
      const p=parent.command.payload,next=predecessorPosition(parent);
      if(next.status==='held')return hold(original,'ancestor_held');
      if(p.intent.kind==='establish_stream'||!fits(p.intent.kind,currentPhase)||next.ownerId!==original.ownerId||next.deviceId!==original.deviceId||next.generation!==head.generation||p.clientSequence!==head.sequence+1||p.predecessorCommandId!==head.commandId||p.expectedRevision!==head.afterRevision||p.expectedAllocationId!==head.allocationId||p.basis.observationId!==observation.id||p.shiftRef?.kind!=='shift'||p.shiftRef.id!==shift.id||parent.prediction.status!==(p.intent.kind==='stop'&&currentPhase==='none'?'noop':'applied'))return hold(original,'needs_reaffirmation');
      pending ||= next.status==='pending';head=next;currentPhase=afterPhase(parent,currentPhase);
    }
    if(parents.some(p=>predecessorPosition(p).commandId===original.commandId)||head.sequence>=Number.MAX_SAFE_INTEGER)return hold(original,'needs_reaffirmation');
    const permitted=action.kind==='switch'?state.actions.canSwitch:action.kind==='finish_setup'?state.actions.canFinishSetup:state.actions.canStop;
    if(!fits(action.kind,currentPhase)||(parents.length===1&&!permitted)||(stop&&currentPhase==='none')||(!stop&&(snapshot.capability.mode!=='active'||state.integrity!=='clean'))||shift.breakStartedAt!==null)return hold(original,'action_unavailable');
    generation=head.generation;sequence=head.sequence+1;predecessor=head.commandId;revision=head.afterRevision;allocationId=head.allocationId;intent=action;
  }
  try{
    const payload=parsePayloadV2({deviceId:original.deviceId,clientGeneration:generation,clientSequence:sequence,predecessorCommandId:predecessor,expectedRevision:revision,basis:{observationId:observation.id},shiftRef:{kind:'shift',id:shift.id},...original.stamp,intent,expectedAllocationId:allocationId,boundaryMode:'trusted_original_tap'});
    if(!trusted(original,input.serverNow))return hold(original,'untrusted_stamp');
    if(action.kind!=='establish_stream'){
      const tapped=timeTicksV2(payload.tappedAt)-BigInt(payload.clockSkewMs!)*1000n;
      const boundaries=[shift.clockInAt];
      if(state.activity?.visibility==='available')boundaries.push(state.activity.startedAt);
      for(const parent of parents){
        if(parent.protocol===1){if(parent.receipt.effectiveAt)boundaries.push(parent.receipt.effectiveAt);}
        else if(parent.prediction.status==='applied'){
          const p=parent.command.payload;if(p.clockSkewMs===null||tapped<timeTicksV2(p.tappedAt)-BigInt(p.clockSkewMs)*1000n)return hold(original,'untrusted_stamp');
        }
      }
      if(boundaries.some(at=>tapped<timeTicksV2(at)))return hold(original,'untrusted_stamp');
    }
    const command=predictAllocation({protocol:2,ownerId:original.ownerId,commandId:original.commandId,payload},action.kind==='establish_stream'?'noop':'applied');
    return freezeV2({kind:pending?'descendant':'ready',original,command,parents:action.kind==='establish_stream'?[]:parents,fences:input.sourceFences,lease:{asOf:snapshot.asOf,expiresAt:observation.expiresAt}});
  }catch{return hold(original,'malformed');}
}
/** Recheck exact saved predictions; never regenerate a payload from fresh state.
 * A held original stays held even if the caller later supplies a new stream. */
export function checkV2SendPrerequisites(plan:PlanV2,input:{parents:readonly AllocationPredecessor[];currentFences:PlannerFencesV2;snapshot:unknown;elapsedMs:number;serverNow:string}):PlanV2{
  if(plan.kind==='held')return plan;
  const blocked=(reason:HoldReasonV2)=>hold(plan.original,reason,plan);
  // This checks an unattempted original only. Confirmation or uncertainty about
  // this command must never be converted into another send-ready result.
  if(plan.command.confirmation.kind!=='pending')return blocked('original_already_observed');
  const saved=plan.command.command,original=plan.original,payload=saved.payload;
  if(saved.ownerId!==original.ownerId||saved.commandId!==original.commandId||payload.deviceId!==original.deviceId||payload.tappedAt!==original.stamp.tappedAt||payload.clockCheckedAt!==original.stamp.clockCheckedAt||payload.clockSkewMs!==original.stamp.clockSkewMs||
    (original.action.kind==='establish_stream'?payload.intent.kind!=='establish_stream'||payload.clientGeneration!==original.action.newGeneration:JSON.stringify(parsePayloadV2(payload).intent)!==JSON.stringify(parsePayloadV2({...payload,intent:original.action}).intent)))return blocked('needs_reaffirmation');
  if(JSON.stringify(predictAllocation(saved,plan.command.prediction.status).prediction)!==JSON.stringify(plan.command.prediction))return blocked('needs_reaffirmation');
  const fence=fenceReason(plan.original,plan.fences,input.currentFences);if(fence)return blocked(fence);
  if(!leaseValid(plan.lease.asOf,plan.lease.expiresAt,input.elapsedMs,plan.command.command.payload.intent.kind==='stop'))return blocked('expired_observation');
  if(!clockWithinLease(plan.lease.asOf,input.elapsedMs,input.serverNow)||!trusted(plan.original,input.serverNow))return blocked('untrusted_stamp');
  if(input.parents.length!==plan.parents.length)return blocked('predecessor_unknown');
  let pending=false;
  for(let i=0;i<plan.parents.length;i++){
    const old=plan.parents[i],fresh=input.parents[i],a=predecessorPosition(old),b=predecessorPosition(fresh);
    if(b.status==='held')return blocked('ancestor_held');
    pending ||= b.status==='pending';
    if(a.ownerId!==b.ownerId||a.deviceId!==b.deviceId||a.generation!==b.generation||a.commandId!==b.commandId||a.sequence!==b.sequence||a.afterRevision!==b.afterRevision||a.allocationId!==b.allocationId||old.protocol!==fresh.protocol)return blocked('needs_reaffirmation');
    if(JSON.stringify(old.protocol===2?old.command:old)!==JSON.stringify(fresh.protocol===2?fresh.command:fresh))return blocked('needs_reaffirmation');
  }
  if(pending)return freezeV2({...plan,kind:'descendant'});
  const snapshot=parseSnapshotV2(input.snapshot,plan.original.deviceId),p=plan.command.command.payload;
  if('availability'in snapshot||!snapshot.state?.shift||snapshot.capability.mode==='unavailable'||snapshot.state.shift.id!==p.shiftRef?.id||snapshot.state.revision!==p.expectedRevision||snapshot.state.shift.allocationId!==p.expectedAllocationId)return blocked('needs_reaffirmation');
  if(p.intent.kind!=='establish_stream'&&(!snapshot.stream||snapshot.stream.status!=='active'||snapshot.stream.clientGeneration!==p.clientGeneration||snapshot.stream.headCommandId!==p.predecessorCommandId||snapshot.stream.headSequence+1!==p.clientSequence||snapshot.stream.headAfterRevision!==p.expectedRevision))return blocked('needs_reaffirmation');
  if(p.intent.kind==='establish_stream'){
    if(!snapshot.state.actions.canEstablishStream||!snapshot.observation||snapshot.observation.currentGeneration!==p.intent.previousGeneration||snapshot.observation.currentHeadCommandId!==p.intent.previousHeadCommandId||snapshot.stream?.clientGeneration===p.clientGeneration)return blocked('needs_reaffirmation');
  }else{
    const permitted=p.intent.kind==='switch'?snapshot.state.actions.canSwitch:p.intent.kind==='finish_setup'?snapshot.state.actions.canFinishSetup:snapshot.state.actions.canStop;
    if(!permitted||!fits(p.intent.kind,phase(snapshot))||snapshot.state.shift.breakStartedAt!==null||(p.intent.kind!=='stop'&&(snapshot.capability.mode!=='active'||snapshot.state.integrity!=='clean')))return blocked('action_unavailable');
  }
  return freezeV2({...plan,kind:'ready'});
}
