/** Static K6 fixtures derived from 0847 SHA-256
 * c0eaccc11ca212853a3950bb64d47805990a2b4af824755a04d92b3fdf170c07.
 * work_activity_command (884-887, 1033-1044), work_cross_job_snapshot
 * (1102-1135), work_cross_job_receipt (1152-1154). Not runtime proof. */
import type { FullSnapshotV2, PayloadV2, ReceiptReplyV2 } from './protocolV2';
import type { OriginalTapV2, PlannerFencesV2 } from './plannerV2';
import type { PredictedV2, SettledV1, SubmissionProvenanceV2 } from './allocationPredecessor';
export const id=(n:number)=>`00000000-0000-0000-0000-${String(n).padStart(12,'0')}`;
export const at='2026-10-05T06:00:00.123456Z';
export function snapshot():FullSnapshotV2{return {protocolVersion:2,asOf:at,deviceId:id(2),capability:{mode:'active',reasonCode:null},
  observation:{id:id(4),revision:1,lastTransitionId:id(9),issuedAt:at,expiresAt:'2026-10-05T06:00:10.123456Z',shiftRef:{kind:'shift',id:id(7)},currentGeneration:id(3),currentHeadCommandId:id(5)},
  stream:{clientGeneration:id(3),headSequence:0,headCommandId:id(5),headAfterRevision:1,status:'active'},
  state:{revision:1,lastTransitionId:id(9),integrity:'clean',status:'unclassified',choiceRequired:true,actions:{canEstablishStream:true,canSwitch:true,canFinishSetup:false,canStop:false},
    shift:{id:id(7),clockInCommandId:id(8),clockInAt:'2026-10-05T05:00:00.000000Z',breakStartedAt:null,breakType:null,status:'open',project:{visibility:'unassigned',id:null,name:null,jobCode:null},allocationId:null},activity:null}};}
export function head():SettledV1{return {protocol:1,commandId:id(5),ownerId:id(1),allocationId:null,
  payload:{deviceId:id(2),clientGeneration:id(3),clientSequence:0,predecessorCommandId:null,expectedRevision:1,basis:{observationId:id(20)},shiftRef:{kind:'shift',id:id(7)},tappedAt:at,clockCheckedAt:at,clockSkewMs:0,intent:{kind:'establish_stream',previousGeneration:null,previousHeadCommandId:null}},
  receipt:{protocolVersion:1,commandId:id(5),status:'noop',reasonCode:null,beforeRevision:1,afterRevision:1,transitionId:null,effectiveAt:null}};}
export const switchIntent=(project=10):Extract<PayloadV2['intent'],{kind:'switch'}>=>({kind:'switch',projectId:id(project),selectionId:id(11),selectionRevision:1,menuVersionId:id(12),definitionVersionId:id(13),scope:'general',unit:null,machineKind:null,values:{checked:false,count:0,note:'original'}});
export const original=(command=6,project=10):OriginalTapV2=>({ownerId:id(1),deviceId:id(2),commandId:id(command),action:switchIntent(project),stamp:{tappedAt:'2026-10-05T00:00:00.123456-06:00',clockCheckedAt:at,clockSkewMs:0}});
export const fences=(project=10):PlannerFencesV2=>({userId:id(1),loginGeneration:2,deviceId:id(2),preview:false,foreground:true,selectedJobId:id(project),authorityToken:'observed-auth-generation-7'});
export const payload=():PayloadV2=>({...head().payload,clientSequence:1,predecessorCommandId:id(5),basis:{observationId:id(4)},intent:switchIntent(),expectedAllocationId:null,boundaryMode:'trusted_original_tap'});
export function lookup(p:PredictedV2):ReceiptReplyV2{
  const {command,prediction}=p,c=command.payload,applied=prediction.status==='applied';
  const effectiveAt=new Date(Date.parse(c.tappedAt)-(c.clockSkewMs??0)).toISOString().replace('Z','456Z');
  return {protocolVersion:2,availability:'available',receipt:{protocolVersion:2,commandId:command.commandId,status:prediction.status,reasonCode:null,beforeRevision:c.expectedRevision,afterRevision:prediction.afterRevision,transitionId:applied?id(90+c.clientSequence):null,effectiveAt:applied?effectiveAt:null},
    allocation:applied&&['switch','finish_setup'].includes(c.intent.kind)?{id:command.commandId,predecessorId:c.expectedAllocationId,boundaryMode:'trusted_original_tap',originalTappedAt:at,effectiveAt,shiftId:id(7),transitionId:id(90+c.clientSequence)}:null};
}
export function snapshotAfter(p:PredictedV2):FullSnapshotV2{
  const s=snapshot(),c=p.command.payload;s.state!.revision=p.prediction.afterRevision;s.observation!.revision=p.prediction.afterRevision;
  s.state!.lastTransitionId=id(90+c.clientSequence);s.observation!.lastTransitionId=s.state!.lastTransitionId;
  s.state!.shift!.allocationId=p.prediction.allocationId;s.state!.shift!.project={visibility:'available',id:'projectId'in c.intent?c.intent.projectId:id(10),name:'Allocation job',jobCode:null};
  s.stream={clientGeneration:c.clientGeneration,headSequence:c.clientSequence,headCommandId:p.command.commandId,headAfterRevision:p.prediction.afterRevision,status:'active'};
  s.observation!.currentHeadCommandId=p.command.commandId;s.observation!.currentGeneration=c.clientGeneration;
  if(c.intent.kind==='switch'){s.state!.status='running';s.state!.actions.canStop=true;s.state!.activity={visibility:'available',source:{kind:'custom',id:id(70)},startedAt:at,project:s.state!.shift!.project,capture:null,unit:null};}
  return s;
}

/** Test-only synthetic request/response coupling; no transport has run. */
export function submission(p:PredictedV2):SubmissionProvenanceV2 {
  const {allocation:_,...reply}=lookup(p);return {command:p.command,reply};
}
