/** Dormant V2 transport. Importing performs no auth, storage or RPC work.
 * Production SDK loading is lazy and occurs only inside an explicit call.
 * Local login counters and caller clocks/fences are NOT durable auth proof. */
import {signInMark,stillSignedInAs,type SignInMark} from '../signedIn';
import {activityUuid} from './protocol';
import {freezeV2,exactV2,parseSnapshotV2,parseCommandReplyV2,parseReceiptReplyV2,type SnapshotV2,type CommandReplyV2,type ReceiptReplyV2} from './protocolV2';
import {consumeCrossJobSend,prepareCrossJobSendCheck,settleCrossJobClaim,type ClaimV3,type JournalContextV3,type OriginalV3,type RecordV3} from '../workCapture/crossJobStorageV3';
import type {SubmissionProvenanceV2} from './allocationPredecessor';

export interface RpcPortsV2 {
  getSession:()=>Promise<{data:{session:{access_token:string;user:{id:string}}|null};error:unknown}>;
  clientWithToken:(token:string)=>{rpc:(name:string,args:Record<string,unknown>)=>PromiseLike<{data:unknown;error:{code?:string}|null}>};
}
export interface SendEnvironmentV2 {
  context:JournalContextV3;
  /** Coherent elapsed/server time supplied by a future authenticated adapter.
   * Strict existing journal limits remain; no network allowance is invented. */
  clock:()=>{elapsedMs:number;serverNow:string};
}
/** receipt means a strict actual wire reply (including refusal/unavailable),
 * not current admission. record:null means local persistence was not confirmed. */
export type SendResultV2 = {kind:'not_sent';reason:string;record:RecordV3|null}
  | {kind:'unknown';record:RecordV3|null;sqlState?:'23514'|'42501'}
  | {kind:'receipt';reply:CommandReplyV2;record:RecordV3|null};
const online=()=>typeof navigator==='undefined'||navigator.onLine!==false;
const sameAuth=(mark:SignInMark)=>!!mark.userId&&stillSignedInAs(mark,mark.userId);
const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
const unavailable=()=>new Error('Cross-job information is unavailable. Refresh before changing work.');
function capture(context:JournalContextV3,mark:SignInMark){
  const expected=freezeV2(context.expected),current=context.current;
  exactV2(expected,['userId','loginGeneration','deviceId','preview','foreground','selectedJobId','authorityToken']);
  activityUuid(expected.userId);activityUuid(expected.deviceId);if(expected.selectedJobId!==null)activityUuid(expected.selectedJobId);
  const locked={expected,current:()=>current.call(context)};
  const valid=()=>sameAuth(mark)&&mark.userId===expected.userId&&Number.isSafeInteger(expected.loginGeneration)&&expected.loginGeneration>=0&&mark.generation===expected.loginGeneration&&expected.preview===false&&expected.foreground===true&&typeof expected.authorityToken==='string'&&expected.authorityToken.length>0&&online()&&same(freezeV2(locked.current()),expected);
  return {locked,valid};
}
async function checkedToken(ports:RpcPortsV2,mark:SignInMark,valid:()=>boolean):Promise<string>{
  if(!valid())throw unavailable();const {data,error}=await ports.getSession();
  if(!valid()||error||!data.session?.access_token||data.session.user.id!==mark.userId)throw unavailable();
  return data.session.access_token;
}
/** Explicitly injected ports prove control flow in tests, not provider behavior.
 * The exported production adapter below uses existing bound-token SDK exports. */
export function createActivityTransportV2(loadPorts:()=>Promise<RpcPortsV2>){
  async function fetchSnapshot(deviceId:string,context:JournalContextV3):Promise<SnapshotV2>{
    try{
      activityUuid(deviceId);const mark={...signInMark()},scope=capture(context,mark);
      if(scope.locked.expected.deviceId!==deviceId||!scope.valid())throw unavailable();
      const ports=await loadPorts();if(!scope.valid())throw unavailable();
      const token=await checkedToken(ports,mark,scope.valid);if(!scope.valid())throw unavailable();
      const client=ports.clientWithToken(token),rpc=client.rpc.bind(client);
      if(!scope.valid())throw unavailable();
      const {data,error}=await rpc('work_cross_job_snapshot',{p_device_id:deviceId});
      if(error||!scope.valid())throw unavailable();return parseSnapshotV2(data,deviceId);
    }catch{throw unavailable();}
  }
  /** Read-only UUID evidence never includes or manufactures full-request
   * submission provenance, and never mints another send permission. */
  async function lookupReceipt(commandId:string,login:SignInMark=signInMark()):Promise<ReceiptReplyV2|null>{
    try{
      activityUuid(commandId);const mark={...login},valid=()=>sameAuth(mark)&&online();
      if(!valid())return null;const ports=await loadPorts();if(!valid())return null;
      const token=await checkedToken(ports,mark,valid);if(!valid())return null;
      const client=ports.clientWithToken(token),rpc=client.rpc.bind(client);if(!valid())return null;
      const {data,error}=await rpc('work_cross_job_receipt',{p_command_id:commandId});
      if(error||!sameAuth(mark))return null;return parseReceiptReplyV2(data,commandId);
    }catch{return null;}
  }
  async function submitClaim(db:IDBDatabase,ticket:ClaimV3,environment:SendEnvironmentV2):Promise<SendResultV2>{
    // This synchronous burn precedes even lazy SDK import/authentication. A
    // second concurrent call, structural copy or wrong handle cannot proceed.
    let original:OriginalV3;
    try{original=consumeCrossJobSend(db,ticket);}catch{return {kind:'not_sent',reason:'send_capability_missing',record:null};}
    const mark={...signInMark()},clock=environment.clock;
    let sent=false;
    // History is owner/login-scoped, not new action admission. UI job, device,
    // foreground or connectivity changes after a reply do not erase it.
    const historicalContext:JournalContextV3={expected:original.fences,current:()=>{
      if(!sameAuth(mark)||mark.userId!==original.command.ownerId||mark.generation!==original.fences.loginGeneration)throw unavailable();
      return original.fences;
    }};
    const persist=async(submission:SubmissionProvenanceV2|null,lookup:ReceiptReplyV2|null):Promise<RecordV3|null>=>{
      if(!sameAuth(mark))return null;
      try{const record=await settleCrossJobClaim(db,ticket,historicalContext,submission,lookup);return sameAuth(mark)?record:null;}
      catch{return null;} // A consumed send/settlement right is never restored.
    };
    try{
      const scope=capture(environment.context,mark);
      if(!same(scope.locked.expected,original.fences)||!scope.valid())throw unavailable();
      const ports=await loadPorts();if(!scope.valid())throw unavailable();
      const token=await checkedToken(ports,mark,scope.valid);if(!scope.valid())throw unavailable();
      const client=ports.clientWithToken(token),rpc=client.rpc.bind(client);
      if(!scope.valid())throw unavailable();
      const snapshotResult=await rpc('work_cross_job_snapshot',{p_device_id:original.command.payload.deviceId});
      if(snapshotResult.error||!scope.valid())throw unavailable();
      const snapshot=parseSnapshotV2(snapshotResult.data,original.command.payload.deviceId);
      const ready=await prepareCrossJobSendCheck(db,ticket,scope.locked);
      if(!scope.valid())throw unavailable();
      const timing=freezeV2(clock.call(environment));exactV2(timing,['elapsedMs','serverNow']);
      // No await between this last full predicate and invoking the bound RPC.
      if(!ready({snapshot,elapsedMs:timing.elapsedMs,serverNow:timing.serverNow})||!scope.valid())throw unavailable();
      sent=true;
      const {data,error}=await rpc('work_activity_command',{p_command_id:original.command.commandId,p_protocol_version:2,p_payload:original.command.payload});
      if(!sameAuth(mark))return {kind:'unknown',record:null};
      if(error){const record=await persist(null,null);return {kind:'unknown',record,...(error.code==='23514'||error.code==='42501'?{sqlState:error.code}:{})};}
      const reply=parseCommandReplyV2(data,original.command.commandId);
      const proof=reply.availability==='available'?freezeV2({command:original.command,reply}):null;
      let lookup:ReceiptReplyV2|null=null;
      if(proof&&online()&&sameAuth(mark)){
        try{
          const answer=await rpc('work_cross_job_receipt',{p_command_id:original.command.commandId});
          if(!sameAuth(mark))return {kind:'unknown',record:null};
          if(!answer.error)lookup=parseReceiptReplyV2(answer.data,original.command.commandId);
        }catch{if(!sameAuth(mark))return {kind:'unknown',record:null};}
      }
      const record=await persist(proof,lookup);
      if(!sameAuth(mark))return {kind:'unknown',record:null};
      return {kind:'receipt',reply,record};
    }catch{
      const record=await persist(null,null);
      return sent?{kind:'unknown',record}:{kind:'not_sent',reason:'admission_or_auth_unavailable',record};
    }
  }
  return {fetchSnapshot,lookupReceipt,submitClaim};
}

const production=createActivityTransportV2(async()=>{
  // supabase.ts initializes SDK/storage listeners at import time. Delay that
  // import until an explicitly invoked operation, after send consumption.
  const {supabase,clientWithToken}=await import('../supabase');
  return {getSession:()=>supabase.auth.getSession(),clientWithToken};
});
export const fetchActivitySnapshotV2=production.fetchSnapshot;
export const lookupActivityReceiptV2=production.lookupReceipt;
export const submitCrossJobClaimV2=production.submitClaim;
