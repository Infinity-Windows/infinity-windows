/** Synthetic isolated storage fixtures. No actual auth, server, or transport. */
import { freezeCrossJobOriginal, crossJobHead, type RecordV3, type OriginalV3 } from './crossJobStorageV3';
import { predictAllocation } from '../workActivity/allocationPredecessor';
import { snapshot, fences, id, head, payload, snapshotAfter } from '../workActivity/protocolV2.fixtures';
export { id, fences, snapshot, snapshotAfter, lookup, submission } from '../workActivity/protocolV2.fixtures';
export function genesis(n=50):OriginalV3 {
  const anchor=snapshot(),p=payload();p.clientGeneration=id(80);p.clientSequence=0;p.predecessorCommandId=null;p.intent={kind:'establish_stream',previousGeneration:id(3),previousHeadCommandId:id(5)};
  const command={protocol:2 as const,ownerId:id(1),commandId:id(n),payload:p};
  return freezeCrossJobOriginal({command,prediction:predictAllocation(command,'noop').prediction,predecessor:null,anchor,fences:fences(),expectedHead:null});
}
export function handoff():OriginalV3 {
  const command={protocol:2 as const,ownerId:id(1),commandId:id(6),payload:payload()};
  return freezeCrossJobOriginal({command,prediction:predictAllocation(command,'applied').prediction,predecessor:head(),anchor:snapshot(),fences:fences(),expectedHead:null});
}
export function child(row:RecordV3,n=51,project=10):OriginalV3 {
  const prior=row.historical?.confirmed??predictAllocation(row.original.command,row.original.prediction.status),p=payload();
  p.clientGeneration=prior.command.payload.clientGeneration;p.clientSequence=prior.prediction.sequence+1;p.predecessorCommandId=prior.command.commandId;p.expectedRevision=prior.prediction.afterRevision;p.expectedAllocationId=prior.prediction.allocationId;
  if(p.intent.kind==='switch')p.intent.projectId=id(project);
  const command={protocol:2 as const,ownerId:id(1),commandId:id(n),payload:p};
  return freezeCrossJobOriginal({command,prediction:predictAllocation(command,'applied').prediction,predecessor:prior,anchor:snapshotAfter(prior),fences:fences(project),expectedHead:crossJobHead(row)});
}
export function row(o=genesis()):RecordV3 {
  const c=o.command,p=c.payload;return {encodingVersion:3,commandId:c.commandId,ownerId:c.ownerId,deviceId:p.deviceId,generation:p.clientGeneration,sequence:p.clientSequence,original:o,revision:0,everAttempted:false,attemptToken:null,hold:null,historical:null};
}

/** A queued child keeps the real pre-parent observation. Its expected revision
 * is a prediction; no server has returned the parent-after snapshot yet. */
export function queuedChild(r:RecordV3,n=51,project=10):OriginalV3 {
  const {commandBytes:_,...o}=child(r,n,project);
  return freezeCrossJobOriginal({...o,anchor:r.original.anchor});
}
/** Synthetic fresh read at a later fixture instant, never a measured clock. */
export function admissionAt(o:OriginalV3,s=structuredClone(o.anchor),elapsedMs=1) {
  const asOf=new Date(Date.parse(o.anchor.asOf)+elapsedMs).toISOString().replace('Z','456Z');
  s=structuredClone(s);s.asOf=asOf;
  if(s.observation){s.observation.id=id(49);s.observation.issuedAt=asOf;s.observation.expiresAt=new Date(Date.parse(asOf)+10000).toISOString().replace('Z','456Z');}
  return {snapshot:s,elapsedMs,serverNow:asOf};
}

/** A real-shaped saved observation before a later tap; the lease is original. */
export function timedGenesis(futureCheck=false):OriginalV3 {
  const {commandBytes:_,...o}=structuredClone(genesis());
  o.anchor.asOf='2026-10-05T09:00:00.123456Z';
  o.anchor.observation!.issuedAt=o.anchor.asOf;o.anchor.observation!.expiresAt='2026-10-05T10:00:00.123456Z';
  o.command.payload.tappedAt=futureCheck?o.anchor.asOf:'2026-10-05T09:06:00.123456Z';
  o.command.payload.clockCheckedAt=futureCheck?'2026-10-05T09:06:00.123456Z':o.anchor.asOf;
  return freezeCrossJobOriginal(o);
}
export function actionHandoff(kind:'stop'|'finish_setup'):OriginalV3 {
  const {commandBytes:_,...o}=structuredClone(handoff());
  o.command.payload.intent=kind==='stop'?{kind}:{kind,projectId:id(10),costCodeId:null};
  const s=o.anchor.state!;s.status=kind==='stop'?'running':'setup';s.actions.canStop=true;s.actions.canFinishSetup=kind==='finish_setup';s.actions.canSwitch=kind!=='finish_setup';
  s.activity={visibility:'available',source:{kind:kind==='stop'?'custom':'setup',id:id(70)},startedAt:o.anchor.asOf,project:s.shift!.project,capture:null,unit:null};
  o.prediction=predictAllocation(o.command,'applied').prediction;
  return freezeCrossJobOriginal(o);
}

/** First establishment has real nullable stream pointers, not unavailable data. */
export function virginGenesis():OriginalV3 {
  const {commandBytes:_,...o}=structuredClone(genesis());o.anchor.stream=null;
  o.anchor.observation!.currentGeneration=null;o.anchor.observation!.currentHeadCommandId=null;
  o.anchor.observation!.lastTransitionId=null;o.anchor.state!.lastTransitionId=null;o.anchor.state!.shift!.clockInCommandId=null;
  o.command.payload.intent={kind:'establish_stream',previousGeneration:null,previousHeadCommandId:null};
  return freezeCrossJobOriginal(o);
}
/** Null observation is a valid temporary reply only with every action false. */
export function withoutObservation(s:ReturnType<typeof snapshot>) {
  s=structuredClone(s);s.observation=null;
  s.state!.actions={canEstablishStream:false,canSwitch:false,canFinishSetup:false,canStop:false};return s;
}
