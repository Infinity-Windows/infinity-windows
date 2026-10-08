/** Dormant explicit version4 successor. Pure RecordV3 parser and original formats are reused.
 * Adds immutable attempt evidence; this file is not imported by the app.
 * Native journal. Importing this module neither opens a DB nor sends.
 * The caller must freeze original IDs/tap before its first await, explicitly
 * open the DB, and recheck live authentication immediately before any future RPC.
 */
import { activityUuid } from '../workActivity/protocol';
import { exactV2, freezeV2, timeTicksV2, wireTimeV2, parseSnapshotV2, parseCommandReplyV2, parseReceiptReplyV2, type FullSnapshotV2 } from '../workActivity/protocolV2';
import { predictAllocation, predecessorPosition, confirmAllocation, type AllocationPredecessor, type PredictedV2, type SubmissionProvenanceV2 } from '../workActivity/allocationPredecessor';
import { checkV2SendPrerequisites, type PlannerFencesV2, type PlanV2 } from '../workActivity/plannerV2';

import { freezeCrossJobOriginal, crossJobHead, parseCrossJobRecord, JournalV3Error, type HeadV3, type OriginalV3, type HoldV3, type RecordV3, type JournalContextV3, type ClaimV3 } from './crossJobStorageV3';
export { freezeCrossJobOriginal, crossJobHead, parseCrossJobRecord, crossJobDelivery } from './crossJobStorageV3';
export type { HeadV3, OriginalV3, HoldV3, RecordV3, JournalContextV3 } from './crossJobStorageV3';
export type ClaimV4 = ClaimV3;
export const CROSS_JOB_DB_NAME = 'iw-work-capture-journal-v1';
export const CROSS_JOB_DB_VERSION = 4;
export const CROSS_JOB_COMMANDS = 'cross_job_commands_v2';
export const CROSS_JOB_HEADS = 'cross_job_heads_v2';
export const CROSS_JOB_SEQUENCE_INDEX = 'by_owner_device_generation_sequence';
export const ATTEMPT_EVIDENCE = 'cross_job_attempt_evidence_v1';
export type AttemptFactV1 = Readonly<{kind:'not_invoked'}> | Readonly<{kind:'invoked';observedSqlError:null|Readonly<{source:'command_rpc_returned_error';code:'23514'|'42501'}>}>;
export interface AttemptEvidenceV1 {readonly encodingVersion:1;readonly contract:'cross_job_adapter_attempt_evidence_v1';readonly boundary:'bound_command_rpc_invocation';readonly ownerId:string;readonly deviceId:string;readonly commandId:string;readonly attemptToken:string;readonly localLoginGeneration:number;readonly originalCommandBytes:string;readonly settlementRevision:number;readonly fact:AttemptFactV1}
export type AttemptEvidenceReadV1 = {kind:'not_recorded'}|{kind:'unreadable'}|{kind:'recorded';evidence:AttemptEvidenceV1};
export type BoundCommandResultV4 = Readonly<{data:unknown;error:boolean;observedSqlState:'23514'|'42501'|null}>;
export type BoundRpcV4 = (name:string,args:Record<string,unknown>)=>PromiseLike<{data:unknown;error:unknown}>;
interface ActiveV4 {db:IDBDatabase;ticket:ClaimV4;original:OriginalV3;sendConsumed:boolean;invocationUsed:boolean;lifetimeOpen:boolean;invoked:boolean;observedCode:'23514'|'42501'|null}
const verifiedHandles=new WeakSet<IDBDatabase>(),closedHandles=new WeakSet<IDBDatabase>();
const activeHandles=new WeakMap<IDBDatabase,Set<ActiveV4>>();
function fail(reason='corrupt_journal'):never {throw new JournalV3Error(reason);}
const equal=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
const safe=(n:unknown)=>typeof n==='number'&&Number.isSafeInteger(n)&&n>=0;
const key=(owner:string,device:string)=>`${owner}:${device}`;
const holds:readonly HoldV3[]=['unknown','refused','conflict','context_changed','ancestor_held','admission_failed','intent_unproven','receipt_mismatch','authentication_changed','expired_observation','untrusted_stamp','unavailable','action_unavailable','predecessor_unknown','original_already_observed','needs_reaffirmation','retired_generation','head_conflict'];
const tickets=new WeakMap<ClaimV4,ActiveV4>();
function fences(value:PlannerFencesV2):PlannerFencesV2 {
  const v=freezeV2(value);exactV2(v,['userId','loginGeneration','deviceId','preview','foreground','selectedJobId','authorityToken']);
  if(v.userId===null||!safe(v.loginGeneration)||v.preview!==false||v.foreground!==true||typeof v.authorityToken!=='string'||!v.authorityToken)fail('context_changed');
  activityUuid(v.userId);activityUuid(v.deviceId);if(v.selectedJobId!==null)activityUuid(v.selectedJobId);return v;
}
function lockContext(context:JournalContextV3):JournalContextV3 {
  const current=context.current;return {expected:fences(context.expected),current:()=>current.call(context)};
}
function checkContext(context:JournalContextV3,expected:PlannerFencesV2):void {
  if(!equal(fences(context.current()),expected))fail('context_changed');
}
function parseHead(value:unknown):HeadV3|null {
  if(value===undefined||value===null)return null;const h=freezeV2(value) as HeadV3;
  exactV2(h,['key','ownerId','deviceId','loginGeneration','generation','commandId','sequence','afterRevision','allocationId','shiftId']);
  for(const id of [h.ownerId,h.deviceId,h.generation,h.commandId,h.shiftId])activityUuid(id);
  if(h.allocationId!==null)activityUuid(h.allocationId);
  if(h.key!==key(h.ownerId,h.deviceId)||![h.loginGeneration,h.sequence,h.afterRevision].every(safe))fail();return h;
}
function original(value:OriginalV3):OriginalV3 {
  exactV2(value,['command','prediction','predecessor','anchor','fences','expectedHead','commandBytes']);
  const {commandBytes,...rest}=value,v=freezeCrossJobOriginal(rest);if(v.commandBytes!==commandBytes)fail();return freezeV2(value);
}
/** No global factory lookup and no side effects until this explicit call. */
function schema(db:IDBDatabase,tx:IDBTransaction,version:number):void {
  const specs:[string,string|string[],string|null,string[]|null][]=[['commands','command.requestId','by_stream',['command.ownerId','command.deviceId','command.sequence']],['heads','streamKey',null,null]];
  if(version>=2)specs.push(['protocol_commands','commandId','by_stream_generation',['ownerId','payload.deviceId','payload.clientGeneration','payload.clientSequence']],['protocol_heads','key',null,null]);
  if(version>=3)specs.push([CROSS_JOB_COMMANDS,'commandId',CROSS_JOB_SEQUENCE_INDEX,['ownerId','deviceId','generation','sequence']],[CROSS_JOB_HEADS,'key',null,null]);
  if(version>=4)specs.push([ATTEMPT_EVIDENCE,['ownerId','deviceId','commandId','attemptToken'],null,null]);
  if(!equal([...db.objectStoreNames].sort(),specs.map(s=>s[0]).sort()))fail('schema_drift');
  for(const [name,path,index,indexPath] of specs){const store=tx.objectStore(name);if(!equal(store.keyPath,path)||store.autoIncrement||!equal([...store.indexNames],index?[index]:[]))fail('schema_drift');if(index){const i=store.index(index);if(!equal(i.keyPath,indexPath)||!i.unique||i.multiEntry)fail('schema_drift');}}
}
export function openCrossJobJournalV4(factory:IDBFactory):Promise<IDBDatabase> {
  return new Promise((resolve,reject)=>{
    let request:IDBOpenDBRequest,failed=false,timer:ReturnType<typeof setTimeout>;
    const refuse=(error:unknown)=>{if(failed)return;failed=true;clearTimeout(timer);try{request?.transaction?.abort();}catch{/* A completed/absent upgrade cannot be aborted. */}reject(error);};
    try{request=factory.open(CROSS_JOB_DB_NAME,CROSS_JOB_DB_VERSION);}catch(error){reject(error);return;}
    timer=setTimeout(()=>refuse(new JournalV3Error('open_timeout')),5000);
    request.onblocked=()=>refuse(new JournalV3Error('upgrade_blocked'));
    request.onerror=()=>refuse(request.error??new JournalV3Error('open_failed'));
    request.onupgradeneeded=event=>{
      // A rejected blocked/timed-out open must never perform a later migration.
      if(failed){request.transaction?.abort();return;}
      try{
        const db=request.result;if(event.oldVersion>0)schema(db,request.transaction!,event.oldVersion);
        if(!db.objectStoreNames.contains('commands')){const s=db.createObjectStore('commands',{keyPath:'command.requestId'});s.createIndex('by_stream',['command.ownerId','command.deviceId','command.sequence'],{unique:true});}
        if(!db.objectStoreNames.contains('heads'))db.createObjectStore('heads',{keyPath:'streamKey'});
        if(!db.objectStoreNames.contains('protocol_commands')){const s=db.createObjectStore('protocol_commands',{keyPath:'commandId'});s.createIndex('by_stream_generation',['ownerId','payload.deviceId','payload.clientGeneration','payload.clientSequence'],{unique:true});}
        if(!db.objectStoreNames.contains('protocol_heads'))db.createObjectStore('protocol_heads',{keyPath:'key'});
        if(event.oldVersion<3){const s=db.createObjectStore(CROSS_JOB_COMMANDS,{keyPath:'commandId'});s.createIndex(CROSS_JOB_SEQUENCE_INDEX,['ownerId','deviceId','generation','sequence'],{unique:true});db.createObjectStore(CROSS_JOB_HEADS,{keyPath:'key'});}
        db.createObjectStore(ATTEMPT_EVIDENCE,{keyPath:['ownerId','deviceId','commandId','attemptToken']});
      }catch(error){request.transaction?.abort();refuse(error);}
    };
    request.onsuccess=()=>{const db=request.result;if(failed){db.close();return;}clearTimeout(timer);try{schema(db,db.transaction([...db.objectStoreNames],'readonly'),4);}catch(error){db.close();refuse(error);return;}verifiedHandles.add(db);activeHandles.set(db,new Set());db.onversionchange=()=>{closedHandles.add(db);for(const a of activeHandles.get(db)??[]){a.lifetimeOpen=false;tickets.delete(a.ticket);}activeHandles.get(db)?.clear();db.close();};resolve(db);};
  });
}
function transaction<T>(db:IDBDatabase,context:JournalContextV3,mode:IDBTransactionMode,work:(tx:IDBTransaction,done:(value:T)=>void,abort:(error:unknown)=>void,guard:()=>void)=>void):Promise<T> {
  const expected=fences(context.expected);checkContext(context,expected);
  return new Promise((resolve,reject)=>{
    let tx:IDBTransaction;try{if(db.name!==CROSS_JOB_DB_NAME||db.version!==4||!verifiedHandles.has(db)||closedHandles.has(db))fail('wrong_database');tx=db.transaction([CROSS_JOB_COMMANDS,CROSS_JOB_HEADS,'protocol_commands','protocol_heads',ATTEMPT_EVIDENCE],mode,mode==='readwrite'?{durability:'strict'}:undefined);}catch(error){reject(error);return;}
    let result:T,complete=false,failure:unknown;const guard=()=>checkContext(context,expected);
    const abort=(error:unknown)=>{failure=error;try{tx.abort();}catch{reject(error);}};
    tx.onabort=()=>reject(failure??tx.error??new JournalV3Error('transaction_aborted'));
    tx.onerror=()=>{failure??=tx.error??new JournalV3Error('transaction_failed');};
    tx.oncomplete=()=>{try{guard();if(!complete)fail('missing_result');resolve(result);}catch(error){reject(new JournalV3Error(error instanceof Error?error.message:'context_changed_after_commit',mode==='readwrite'));}};
    const done=(value:T)=>{guard();result=value;complete=true;};
    try{if(mode==='readwrite'&&tx.durability!=='strict')fail('strict_durability_unavailable');guard();work(tx,done,abort,guard);}catch(error){abort(error);}
  });
}
function request<T>(r:IDBRequest<T>,abort:(error:unknown)=>void,callback:(value:T)=>void):void { r.onsuccess=()=>{try{callback(r.result);}catch(error){abort(error);}}; }
function scoped(r:RecordV3,expected:PlannerFencesV2):boolean {return r.ownerId===expected.userId&&r.deviceId===expected.deviceId&&r.original.fences.loginGeneration===expected.loginGeneration;}
function currentParent(r:RecordV3):PredictedV2 {
  const prediction=predictAllocation(r.original.command,r.original.prediction.status);
  if(r.hold!==null||r.everAttempted&&!r.historical?.confirmed)return freezeV2({...prediction,confirmation:{kind:'held',reason:'parent_unknown'}});
  return r.historical?.confirmed??prediction;
}
interface OldHeadV3 {key:string;ownerId:string;deviceId:string;clientGeneration:string;sequence:number;commandId:string}
function oldHead(value:unknown):OldHeadV3|null {
  if(value===undefined)return null;const h=freezeV2(value) as OldHeadV3;
  exactV2(h,['key','ownerId','deviceId','clientGeneration','sequence','commandId']);
  for(const id of [h.ownerId,h.deviceId,h.clientGeneration,h.commandId])activityUuid(id);
  if(h.key!==key(h.ownerId,h.deviceId)||!safe(h.sequence))fail('v1_head_conflict');return h;
}
function oldParent(tx:IDBTransaction,p:AllocationPredecessor,abort:(error:unknown)=>void,done:()=>void):void {
  if(p.protocol!==1)fail();const position=predecessorPosition(p);
  request(tx.objectStore('protocol_heads').get(key(p.ownerId,p.payload.deviceId)),abort,rawHead=>{
    const h=oldHead(rawHead);
    if(!h||h.key!==key(p.ownerId,p.payload.deviceId)||h.ownerId!==p.ownerId||h.deviceId!==p.payload.deviceId||h.clientGeneration!==position.generation||h.commandId!==p.commandId||h.sequence!==position.sequence)fail('v1_head_conflict');
    request(tx.objectStore('protocol_commands').get(p.commandId),abort,row=>{
      if(row)exactV2(row,['encodingVersion','commandId','ownerId','payload','uncertain','receipt']);
      if(!row||row.encodingVersion!==2||row.ownerId!==p.ownerId||row.commandId!==p.commandId||row.uncertain!==false||!equal(row.payload,p.payload)||!equal(row.receipt,p.receipt))fail('v1_handoff_unproven');done();
    });
  });
}
export async function appendCrossJobOriginalV4(db:IDBDatabase,input:OriginalV3,context:JournalContextV3):Promise<{record:RecordV3;created:boolean}> {
  context=lockContext(context);const o=original(input),c=o.command,p=c.payload; // Before the first await.
  try{return await transaction(db,context,'readwrite',(tx,done,abort,guard)=>{
    if(!equal(o.fences,context.expected))fail('context_changed');const commands=tx.objectStore(CROSS_JOB_COMMANDS),heads=tx.objectStore(CROSS_JOB_HEADS);
    request(commands.get(c.commandId),abort,prior=>{
      guard();if(prior!==undefined){const r=parseCrossJobRecord(prior);if(!equal(r.original,o)||!scoped(r,context.expected))fail('original_identity_conflict');done({record:r,created:false});return;}
      request(heads.get(key(c.ownerId,p.deviceId)),abort,raw=>{
        guard();const h=parseHead(raw);if(!equal(h,o.expectedHead))fail('head_conflict');
        const save=(hold:HoldV3|null=null)=>{
          guard();const row=parseCrossJobRecord({encodingVersion:3,commandId:c.commandId,ownerId:c.ownerId,deviceId:p.deviceId,generation:p.clientGeneration,sequence:p.clientSequence,original:o,revision:0,everAttempted:false,attemptToken:null,hold,historical:null});
          commands.add(row);heads.put(crossJobHead(row));
          request(commands.get(c.commandId),abort,()=>{guard();done({record:row,created:true});});
        };
        if(o.predecessor?.protocol===1){oldParent(tx,o.predecessor,abort,()=>save());return;}
        if(h){request(commands.get(h.commandId),abort,rawParent=>{
          const previous=parseCrossJobRecord(rawParent);if(!equal(crossJobHead(previous),h)||!scoped(previous,context.expected))fail('head_conflict');
          if(o.predecessor?.protocol===2){if(!equal(previous.original.command,o.predecessor.command)||!equal(previous.original.prediction,o.predecessor.prediction))fail('lineage_conflict');save(currentParent(previous).confirmation.kind==='held'?'ancestor_held':null);}
          else {if(p.intent.kind!=='establish_stream'||p.intent.previousGeneration!==h.generation||p.intent.previousHeadCommandId!==h.commandId||p.clientGeneration===h.generation)fail('invalid_genesis');save();}
        });return;}
        if(o.predecessor!==null||p.intent.kind!=='establish_stream')fail('missing_predecessor');
        request(tx.objectStore('protocol_heads').get(key(c.ownerId,p.deviceId)),abort,rawOld=>{
          const old=oldHead(rawOld);
          if(old!==null&&(p.intent.kind!=='establish_stream'||old.clientGeneration!==p.intent.previousGeneration||old.commandId!==p.intent.previousHeadCommandId||old.ownerId!==c.ownerId||old.deviceId!==p.deviceId))fail('v1_head_conflict');save();
        });
      });
    });
  });}catch(error){throw new JournalV3Error(error instanceof Error?error.message:'unsaved',error instanceof JournalV3Error&&error.committed,o);}
}
export function readCrossJobOriginalV4(db:IDBDatabase,commandId:string,context:JournalContextV3):Promise<RecordV3|null> {
  context=lockContext(context);activityUuid(commandId);return transaction(db,context,'readonly',(tx,done,abort)=>request(tx.objectStore(CROSS_JOB_COMMANDS).get(commandId),abort,raw=>{
    if(raw===undefined){done(null);return;}const r=parseCrossJobRecord(raw);done(scoped(r,context.expected)?r:null);
  }));
}
export interface AdmissionV3 {snapshot:unknown;elapsedMs:number;serverNow:string}
/** Admission is replaceable caller evidence, never part of the saved original.
 * Exact keys prevent injected parents/currentFences overriding trusted inputs. */
function admissionInput(value:AdmissionV3,deviceId:string):AdmissionV3|null {
  try {
    const a=freezeV2(value);exactV2(a,['snapshot','elapsedMs','serverNow']);
    if(typeof a.elapsedMs!=='number'||!Number.isFinite(a.elapsedMs)||a.elapsedMs<0)return null;
    wireTimeV2(a.serverNow);parseSnapshotV2(a.snapshot,deviceId);return a;
  }catch{return null;}
}
/** Only coherent caller evidence can reach the planner. This is not server
 * authentication or a production network-latency allowance. Lower revisions
 * are never used to invalidate an original: they can be cached or reset data. */
function freshAdmission(r:RecordV3,a:AdmissionV3):FullSnapshotV2|null {
  const s=parseSnapshotV2(a.snapshot,r.deviceId);
  // A valid full reply may omit its current observation; the protected
  // parser then requires every action false. This is incomplete current
  // admission evidence, even alongside absent stream or changed pointers.
  // Wait for an observation before making a durable source/time judgment.
  if('availability'in s||s.capability.mode==='unavailable'||!s.state||s.observation===null)return null;
  const start=timeTicksV2(r.original.anchor.asOf),now=timeTicksV2(a.serverNow),asOf=timeTicksV2(s.asOf);
  const elapsed=Math.ceil(a.elapsedMs*1000),delta=now-start;
  if(!Number.isSafeInteger(elapsed)||delta<0n||delta>BigInt(elapsed)||BigInt(elapsed)-delta>=1000n||
    asOf<start||asOf>now||now-asOf>=1000n||s.state.revision<r.original.command.payload.expectedRevision)return null;
  const p=r.original.command.payload;
  // A coherent cached read can still predate this tap/check. A later read can
  // fix these two trust failures; never make them durable untrusted_stamp.
  if(p.clockSkewMs!==null&&Math.abs(p.clockSkewMs)<=120000&&asOf<timeTicksV2(p.tappedAt)-BigInt(p.clockSkewMs)*1000n)return null;
  if(p.clockCheckedAt!==null&&asOf<timeTicksV2(p.clockCheckedAt)-120n*1000000n)return null;
  return s;
}
function plan(r:RecordV3):Exclude<PlanV2,{kind:'held'}> {
  const o=r.original,c=o.command,p=c.payload,intent=p.intent;
  return {kind:'ready',original:{ownerId:c.ownerId,deviceId:p.deviceId,commandId:c.commandId,action:intent.kind==='establish_stream'?{kind:'establish_stream',newGeneration:p.clientGeneration}:intent,stamp:{tappedAt:p.tappedAt,clockCheckedAt:p.clockCheckedAt,clockSkewMs:p.clockSkewMs}},command:predictAllocation(c,o.prediction.status),parents:o.predecessor?[o.predecessor]:[],fences:o.fences,lease:{asOf:o.anchor.asOf,expiresAt:o.anchor.observation!.expiresAt}};
}
/** This is an at-most-once local claim, not permission from a server or transport.
 * Crashed claims cannot be reconstructed from a row or reclaimed by elapsed time. */
export async function claimCrossJobOriginalV4(db:IDBDatabase,commandId:string,token:string,context:JournalContextV3,admission:AdmissionV3):Promise<ClaimV4|null> {
  context=lockContext(context);activityUuid(commandId);activityUuid(token);const a=admissionInput(admission,context.expected.deviceId);if(!a)return null;
  const record=await transaction<RecordV3|null>(db,context,'readwrite',(tx,done,abort,guard)=>{
    const commands=tx.objectStore(CROSS_JOB_COMMANDS);request(commands.get(commandId),abort,raw=>{
      guard();const r=parseCrossJobRecord(raw);
      // Caller login counters are page-local, not durable authentication epochs.
      // Neither higher nor lower values authorize mutation of a saved original.
      if(r.ownerId!==context.expected.userId||r.deviceId!==context.expected.deviceId)fail('context_changed');
      if(r.everAttempted||r.hold!==null){done(null);return;}
      const retainHold=(reason:HoldV3)=>{guard();const held=parseCrossJobRecord({...r,hold:reason,revision:r.revision+1});commands.put(held);done(null);};
      if(r.original.fences.loginGeneration!==context.expected.loginGeneration){done(null);return;}
      const apply=(parents:AllocationPredecessor[])=>{
        guard();let checked:PlanV2,snapshot:FullSnapshotV2|null,positions:ReturnType<typeof predecessorPosition>[];
        // Resolve the durable predecessor first. A queued child expects the
        // parent's future revision; today's pre-parent snapshot is not a
        // conflict. Use the foundation's validated predecessor semantics.
        try{positions=parents.map(predecessorPosition);}catch{done(null);return;}
        // Storage errors from retaining a proven ancestor hold must abort; they
        // are not incoming-evidence parse failures.
        if(positions.some(p=>p.status==='held')){retainHold('ancestor_held');return;}
        if(positions.some(p=>p.status==='pending')){done(null);return;}
        try{
          snapshot=freshAdmission(r,a);
          if(!snapshot){done(null);return;}
          checked=checkV2SendPrerequisites(plan(r),{parents,currentFences:context.current(),snapshot,elapsedMs:a.elapsedMs,serverNow:a.serverNow});
        }catch{done(null);return;}
        if(checked.kind==='descendant'){done(null);return;}
        if(checked.kind==='held'){
          // The foundation owns exact source/stream/prediction comparisons.
          // Protected V2 parsing rejects state-present/null-shift shapes; do
          // not bypass it to manufacture a revision conflict from invalid wire.
          if(checked.reason==='needs_reaffirmation'){
            // The protected planner combines a disabled establish action with
            // source mismatch in one reason. Reuse that exact planner solely
            // to distinguish the disabled-action case, never to authorize it.
            if(r.original.command.payload.intent.kind==='establish_stream'&&!snapshot.state!.actions.canEstablishStream){
              try{
                const diagnostic={...snapshot,state:{...snapshot.state!,actions:{...snapshot.state!.actions,canEstablishStream:true}}};
                const withoutDisabledAction=checkV2SendPrerequisites(plan(r),{parents,currentFences:context.current(),snapshot:diagnostic,elapsedMs:a.elapsedMs,serverNow:a.serverNow});
                if(withoutDisabledAction.kind!=='held'||withoutDisabledAction.reason!=='needs_reaffirmation'){done(null);return;}
              }catch{done(null);return;}
            }
            retainHold(checked.reason);return;
          }
          if(checked.reason==='action_unavailable'){
            const state=snapshot.state!,shift=state.shift,p=r.original.command.payload;
            const changedPhase=shift!==null&&(shift.breakStartedAt!==null||
              (p.intent.kind==='finish_setup'&&state.status!=='setup')||(p.intent.kind==='switch'&&state.status==='setup'));
            if(changedPhase){retainHold('needs_reaffirmation');return;}
            done(null);return;
          }
          // Every remaining foundation reason has an explicit journal policy.
          // Its permanent result describes these inputs, not necessarily the
          // durable original. Future/unrecognized reasons default to no-write.
          switch(checked.reason){
            case 'untrusted_stamp':{
              const p=r.original.command.payload,now=timeTicksV2(a.serverNow),skew=p.clockSkewMs;
              const immutable=p.clockCheckedAt===null||skew===null||!Number.isInteger(skew)||Math.abs(skew)>120000;
              const aged=(p.clockCheckedAt!==null&&now-timeTicksV2(p.clockCheckedAt)>24n*3600n*1000000n)||
                (skew!==null&&now-(timeTicksV2(p.tappedAt)-BigInt(skew)*1000n)>16n*3600n*1000000n);
              if(immutable||aged){retainHold('untrusted_stamp');return;}
              done(null);return;
            }
            case 'expired_observation':{
              const lease=r.original.anchor.observation!,elapsed=BigInt(Math.ceil(a.elapsedMs*1000));
              if(a.elapsedMs>16*3600000||(r.original.command.payload.intent.kind!=='stop'&&
                timeTicksV2(lease.expiresAt)-timeTicksV2(r.original.anchor.asOf)<=elapsed)){retainHold('expired_observation');return;}
              done(null);return;
            }
            case 'authentication_changed':case 'context_changed':case 'malformed':case 'unavailable':
            case 'predecessor_unknown':case 'original_already_observed':case 'ancestor_held':
              done(null);return;
            default:done(null);return;
          }
        }
        // Exact protected-planner ready behavior is authoritative here. In
        // particular allocation stop and establish_stream have their own
        // capability/integrity rules. Neither is paid clock_out.
        const next=parseCrossJobRecord({...r,everAttempted:true,attemptToken:token,revision:r.revision+1});guard();commands.put(next);request(commands.get(commandId),abort,()=>{guard();done(next);});
      };
      request(tx.objectStore(CROSS_JOB_HEADS).get(key(r.ownerId,r.deviceId)),abort,rawHead=>{
      const h=parseHead(rawHead);if(!h){retainHold('head_conflict');return;}if(h.loginGeneration!==r.original.fences.loginGeneration){retainHold('head_conflict');return;}if(h.generation!==r.generation){retainHold('retired_generation');return;}
      request(commands.get(h.commandId),abort,tail=>{if(!equal(crossJobHead(parseCrossJobRecord(tail)),h)){retainHold('head_conflict');return;}
      const predecessor=r.original.predecessor;
      if(predecessor?.protocol===2){request(commands.get(predecessor.command.commandId),abort,rawParent=>{
        const saved=parseCrossJobRecord(rawParent);if(!equal(saved.original.command,predecessor.command)||!scoped(saved,context.expected))fail('lineage_conflict');apply([currentParent(saved)]);
      });}
      else if(predecessor?.protocol===1)oldParent(tx,predecessor,abort,()=>apply([predecessor]));else apply([]);
      });
      });
    });
  });
  if(!record)return null;try{checkContext(context,context.expected);}catch{throw new JournalV3Error('context_changed_after_commit',true,record.original);}const ticket=freezeV2({command:record.original.command,token});const active:ActiveV4={db,ticket,original:record.original,sendConsumed:false,invocationUsed:false,lifetimeOpen:false,invoked:false,observedCode:null};tickets.set(ticket,active);activeHandles.get(db)!.add(active);return ticket;
}
/** Consume before the first transport/authentication await. The native claim
 * is private and DB-handle-bound; copies/reloads cannot reconstruct this right.
 * Consumption is permanent and independent of the one settlement permission. */
/** Consumed once, returned only into one adapter call's lexical lifetime.
 * No ticket-based invocation function is exported. The caller must forfeit in
 * a finally immediately enclosing every operation after consume. */
export function consumeCrossJobSendV4(db:IDBDatabase,ticket:ClaimV4){
  const active=tickets.get(ticket);
  if(!active||active.db!==db||active.sendConsumed||closedHandles.has(db))fail('send_capability_missing');
  active.sendConsumed=true;active.lifetimeOpen=true;
  const forfeit=()=>{active.lifetimeOpen=false;activeHandles.get(db)?.delete(active);};
  const invoke=(ready:()=>boolean,rpc:BoundRpcV4):Promise<BoundCommandResultV4>=>{
    if(tickets.get(ticket)!==active||!active.lifetimeOpen||active.invocationUsed||closedHandles.has(db))fail('send_capability_missing');
    active.invocationUsed=true;
    if(!ready()||tickets.get(ticket)!==active||!active.lifetimeOpen||closedHandles.has(db))fail('admission_unavailable');
    active.invoked=true;
    const pending=rpc('work_activity_command',{p_command_id:active.original.command.commandId,p_protocol_version:2,p_payload:active.original.command.payload});
    return Promise.resolve(pending).then(result=>{
      const data=ownData(result,'data'),error=ownData(result,'error');
      if(!data||!error||(error.value!==null&&(typeof error.value!=='object'||Array.isArray(error.value))))fail('invalid_command_result');
      const code=ownData(error.value,'code')?.value;
      const sql=code==='23514'||code==='42501'?code:null;
      if(tickets.get(ticket)===active&&active.lifetimeOpen)active.observedCode=sql;
      return Object.freeze({data:data.value,error:error.value!==null,observedSqlState:sql});
    });
  };
  return Object.freeze({original:active.original,invoke,forfeit,invocationStarted:()=>active.invoked});
}
function ownData(value:unknown,key:string):PropertyDescriptor|undefined {
  if(!value||typeof value!=='object'||Array.isArray(value))return undefined;
  const d=Object.getOwnPropertyDescriptor(value,key);return d&&Object.hasOwn(d,'value')?d:undefined;
}
/** Read-only final lineage capture. No new claim, hold, retry or permission.
 * The returned synchronous predicate reuses the protected planner and original
 * lease after the read await. It cannot make the DB snapshot atomic with a
 * later RPC; the backend still enforces revision/lineage and authorization. */
export async function prepareCrossJobSendCheckV4(db:IDBDatabase,ticket:ClaimV4,context:JournalContextV3):Promise<(admission:AdmissionV3)=>boolean> {
  context=lockContext(context);const active=tickets.get(ticket);
  if(!active||active.db!==db||!active.sendConsumed||!active.lifetimeOpen||closedHandles.has(db))fail('send_capability_missing');
  const captured=await transaction<{record:RecordV3;parents:AllocationPredecessor[]}>(db,context,'readonly',(tx,done,abort)=>{
    const commands=tx.objectStore(CROSS_JOB_COMMANDS);
    request(commands.get(ticket.command.commandId),abort,raw=>{
      const r=parseCrossJobRecord(raw);
      if(!scoped(r,context.expected)||!r.everAttempted||r.attemptToken!==ticket.token||r.hold!==null||r.historical!==null||!equal(r.original,active.original))fail('claim_conflict');
      request(tx.objectStore(CROSS_JOB_HEADS).get(key(r.ownerId,r.deviceId)),abort,rawHead=>{
        const h=parseHead(rawHead);if(!h||h.generation!==r.generation||h.loginGeneration!==r.original.fences.loginGeneration)fail('head_conflict');
        request(commands.get(h.commandId),abort,tail=>{
          if(!equal(crossJobHead(parseCrossJobRecord(tail)),h))fail('head_conflict');
          const p=r.original.predecessor;
          if(p?.protocol===2)request(commands.get(p.command.commandId),abort,rawParent=>{
            const saved=parseCrossJobRecord(rawParent);if(!scoped(saved,context.expected)||!equal(saved.original.command,p.command))fail('lineage_conflict');done({record:r,parents:[currentParent(saved)]});
          });
          else if(p?.protocol===1)oldParent(tx,p,abort,()=>done({record:r,parents:[p]}));
          else done({record:r,parents:[]});
        });
      });
    });
  });
  return admission=>{
    try{
      if(tickets.get(ticket)!==active||!active.lifetimeOpen||closedHandles.has(db))return false;
      checkContext(context,context.expected);
      const a=admissionInput(admission,context.expected.deviceId);if(!a)return false;
      const snapshot=freshAdmission(captured.record,a);if(!snapshot)return false;
      return checkV2SendPrerequisites(plan(captured.record),{parents:captured.parents,currentFences:context.current(),snapshot,elapsedMs:a.elapsedMs,serverNow:a.serverNow}).kind==='ready';
    }catch{return false;}
  };
}
/** One live in-memory claim may append actual request/reply provenance once.
 * It is a caller/transport obligation; this module cannot authenticate a reply. */
export function settleCrossJobClaimV4(db:IDBDatabase,ticket:ClaimV4,context:JournalContextV3,submission:SubmissionProvenanceV2|null,lookup:unknown):Promise<RecordV3> {
  context=lockContext(context);const active=tickets.get(ticket);if(!active||active.db!==db)fail('claim_capability_missing');tickets.delete(ticket);active.lifetimeOpen=false;activeHandles.get(db)?.delete(active);
  const fact:AttemptFactV1|null=!active.sendConsumed?null:active.invoked?{kind:'invoked',observedSqlError:active.observedCode===null?null:{source:'command_rpc_returned_error',code:active.observedCode}}:{kind:'not_invoked'};
  const proof=submission===null?null:freezeV2(submission),view=lookup===null?null:freezeV2(lookup);
  return transaction(db,context,'readwrite',(tx,done,abort,guard)=>{
    const store=tx.objectStore(CROSS_JOB_COMMANDS);request(store.get(ticket.command.commandId),abort,raw=>{
      guard();const r=parseCrossJobRecord(raw);if(!scoped(r,context.expected)||r.attemptToken!==ticket.token||!r.everAttempted||!equal(r.original,active.original)||r.historical!==null)fail('claim_conflict');
      if(fact&&(fact.kind==='not_invoked'||fact.observedSqlError!==null)&&(proof!==null||view!==null))fail('evidence_provenance_conflict');
      let hold:HoldV3='unknown',historical:RecordV3['historical']=null;
      if(proof!==null){
        exactV2(proof,['command','reply']);if(!equal(proof.command,r.original.command))fail('submission_identity_conflict');const reply=parseCommandReplyV2(proof.reply,r.commandId);
        if(reply.availability==='available'){
          const parsed=view===null?null:parseReceiptReplyV2(view,r.commandId),confirmed=confirmAllocation(predictAllocation(r.original.command,r.original.prediction.status),parsed,proof);
          historical={submission:proof,lookup:parsed,confirmed:confirmed.confirmation.kind==='confirmed'?confirmed:null};
          hold=reply.receipt.status==='refused'?'refused':reply.receipt.status==='conflict'?'conflict':confirmed.confirmation.kind==='confirmed'?'unknown':'intent_unproven';
        }
      }
      const next=parseCrossJobRecord({...r,revision:r.revision+1,historical,hold:r.hold??(historical?.confirmed?null:hold)});let expectedEvidence:Readonly<AttemptEvidenceV1>|null=null;if(fact!==null){const e=parseAttemptEvidenceV1({encodingVersion:1,contract:'cross_job_adapter_attempt_evidence_v1',boundary:'bound_command_rpc_invocation',ownerId:r.ownerId,deviceId:r.deviceId,commandId:r.commandId,attemptToken:r.attemptToken,localLoginGeneration:r.original.fences.loginGeneration,originalCommandBytes:r.original.commandBytes,settlementRevision:next.revision,fact},next);expectedEvidence=e;tx.objectStore(ATTEMPT_EVIDENCE).add(e);}
      store.put(next);request(store.get(r.commandId),abort,saved=>{guard();const parsed=parseCrossJobRecord(saved);if(!equal(parsed,next))fail('settlement_readback');if(fact===null){done(parsed);return;}request(tx.objectStore(ATTEMPT_EVIDENCE).get([r.ownerId,r.deviceId,r.commandId,r.attemptToken!]),abort,evidence=>{if(!equal(parseAttemptEvidenceV1(evidence,parsed),expectedEvidence))fail('evidence_readback');guard();done(parsed);});});
    });
  });
}
/** Later unavailable/conflicting lookup can close admission but never erase or
 * replace the historical request/response association and successful receipt. */
export function holdCrossJobOriginalV4(db:IDBDatabase,commandId:string,context:JournalContextV3,reason:HoldV3):Promise<RecordV3> {
  context=lockContext(context);activityUuid(commandId);if(!holds.includes(reason))fail('invalid_hold');return transaction(db,context,'readwrite',(tx,done,abort)=>{
    const store=tx.objectStore(CROSS_JOB_COMMANDS);request(store.get(commandId),abort,raw=>{const r=parseCrossJobRecord(raw);if(!scoped(r,context.expected))fail('context_changed');const next=parseCrossJobRecord({...r,revision:r.revision+1,hold:r.hold??reason});store.put(next);request(store.get(commandId),abort,()=>done(next));});
  });
}


/** Pure exact envelope + complete unchanged RecordV3 parser, never a capability. */
export function parseAttemptEvidenceV1(value:unknown,record:unknown):Readonly<AttemptEvidenceV1>{
  const r=parseCrossJobRecord(record),e=freezeV2(value,250000) as AttemptEvidenceV1;
  exactV2(e,['encodingVersion','contract','boundary','ownerId','deviceId','commandId','attemptToken','localLoginGeneration','originalCommandBytes','settlementRevision','fact']);
  if(e.encodingVersion!==1||e.contract!=='cross_job_adapter_attempt_evidence_v1'||e.boundary!=='bound_command_rpc_invocation'||!r.everAttempted||r.attemptToken===null)fail('invalid_attempt_evidence');
  for(const k of ['ownerId','deviceId','commandId','attemptToken'] as const){activityUuid(e[k]);if(e[k]!==r[k])fail('attempt_identity_conflict');}
  if(!safe(e.localLoginGeneration)||e.localLoginGeneration!==r.original.fences.loginGeneration||e.originalCommandBytes!==r.original.commandBytes||!safe(e.settlementRevision)||e.settlementRevision<2||e.settlementRevision>r.revision)fail('attempt_identity_conflict');
  if(e.fact.kind==='not_invoked')exactV2(e.fact,['kind']);
  else if(e.fact.kind==='invoked'){exactV2(e.fact,['kind','observedSqlError']);if(e.fact.observedSqlError!==null){exactV2(e.fact.observedSqlError,['source','code']);if(e.fact.observedSqlError.source!=='command_rpc_returned_error'||!['23514','42501'].includes(e.fact.observedSqlError.code))fail('invalid_attempt_evidence');}}
  else fail('invalid_attempt_evidence');return e;
}
/** Missing evidence is not noninvocation; no row can reconstruct a send right. */
export function readAttemptEvidenceV1(db:IDBDatabase,commandId:string,context:JournalContextV3):Promise<AttemptEvidenceReadV1|null>{
  context=lockContext(context);activityUuid(commandId);
  return transaction(db,context,'readonly',(tx,done,abort)=>{request(tx.objectStore(CROSS_JOB_COMMANDS).get(commandId),abort,raw=>{
    if(raw===undefined){done(null);return;}const r=parseCrossJobRecord(raw);if(!scoped(r,context.expected)){done(null);return;}
    if(!r.everAttempted||r.attemptToken===null){done({kind:'not_recorded'});return;}
    request(tx.objectStore(ATTEMPT_EVIDENCE).get([r.ownerId,r.deviceId,r.commandId,r.attemptToken]),abort,rawEvidence=>{
      if(rawEvidence===undefined){done({kind:'not_recorded'});return;}let result:AttemptEvidenceReadV1;try{result={kind:'recorded',evidence:parseAttemptEvidenceV1(rawEvidence,r)};}catch{result={kind:'unreadable'};}done(result);
    });
  });});
}
