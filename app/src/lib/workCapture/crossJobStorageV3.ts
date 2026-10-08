/** Dormant native journal. Importing this module neither opens a DB nor sends.
 * The caller must freeze original IDs/tap before its first await, explicitly
 * open the DB, and recheck live authentication immediately before any future RPC.
 */
import { activityUuid, parsePayload, parseReceiptReply } from '../workActivity/protocol';
import { exactV2, freezeV2, timeTicksV2, wireTimeV2, parseSnapshotV2, parseCommandReplyV2, parseReceiptReplyV2, type FullSnapshotV2, type ReceiptReplyV2 } from '../workActivity/protocolV2';
import { allocationCommand, predictAllocation, predecessorPosition, confirmAllocation, type AllocationCommand, type AllocationPredecessor, type PredictedV2, type SubmissionProvenanceV2 } from '../workActivity/allocationPredecessor';
import { checkV2SendPrerequisites, type PlannerFencesV2, type PlanV2 } from '../workActivity/plannerV2';

export const CROSS_JOB_DB_NAME = 'iw-work-capture-journal-v1';
export const CROSS_JOB_DB_VERSION = 3;
export const CROSS_JOB_COMMANDS = 'cross_job_commands_v2';
export const CROSS_JOB_HEADS = 'cross_job_heads_v2';
export const CROSS_JOB_SEQUENCE_INDEX = 'by_owner_device_generation_sequence';
export interface HeadV3 { key:string; ownerId:string; deviceId:string; loginGeneration:number; generation:string; commandId:string; sequence:number; afterRevision:number; allocationId:string|null; shiftId:string }
export interface OriginalV3 {
  command:AllocationCommand; commandBytes:string; prediction:PredictedV2['prediction']; predecessor:AllocationPredecessor|null;
  anchor:FullSnapshotV2; fences:PlannerFencesV2; expectedHead:HeadV3|null;
}
export type HoldV3 = 'unknown'|'refused'|'conflict'|'context_changed'|'ancestor_held'|'admission_failed'|'intent_unproven'|'receipt_mismatch'
  |'authentication_changed'|'expired_observation'|'untrusted_stamp'|'unavailable'|'action_unavailable'|'predecessor_unknown'|'original_already_observed'|'needs_reaffirmation'|'retired_generation'|'head_conflict';
export interface RecordV3 {
  encodingVersion:3; commandId:string; ownerId:string; deviceId:string; generation:string; sequence:number;
  original:OriginalV3; revision:number; everAttempted:boolean; attemptToken:string|null; hold:HoldV3|null;
  historical:{submission:SubmissionProvenanceV2; lookup:ReceiptReplyV2|null; confirmed:PredictedV2|null}|null;
}
export interface JournalContextV3 { expected:PlannerFencesV2; current:()=>PlannerFencesV2 }
export interface ClaimV3 { command:AllocationCommand; token:string }
export class JournalV3Error extends Error {
  readonly reason:string; readonly committed:boolean; readonly original:OriginalV3|null;
  constructor(reason:string, committed=false, original:OriginalV3|null=null) { super(reason); this.name='JournalV3Error';this.reason=reason;this.committed=committed;this.original=original; }
}
function fail(reason='corrupt_journal'):never {throw new JournalV3Error(reason);}
const equal=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
const safe=(n:unknown)=>typeof n==='number'&&Number.isSafeInteger(n)&&n>=0;
const key=(owner:string,device:string)=>`${owner}:${device}`;
const holds:readonly HoldV3[]=['unknown','refused','conflict','context_changed','ancestor_held','admission_failed','intent_unproven','receipt_mismatch','authentication_changed','expired_observation','untrusted_stamp','unavailable','action_unavailable','predecessor_unknown','original_already_observed','needs_reaffirmation','retired_generation','head_conflict'];
const tickets=new WeakMap<ClaimV3,{db:IDBDatabase;original:OriginalV3;sendConsumed:boolean}>();
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
function parent(value:AllocationPredecessor):AllocationPredecessor {
  const p=freezeV2(value);
  if(p.protocol===1){exactV2(p,['protocol','ownerId','commandId','payload','receipt','allocationId']);parsePayload(p.payload);parseReceiptReply({protocolVersion:1,availability:'available',receipt:p.receipt},p.commandId);}
  else if(p.protocol===2){
    exactV2(p,['protocol','command','prediction','confirmation']);allocationCommand(p.command);
    exactV2(p.prediction,['sequence','afterRevision','allocationId','status']);
    if(p.confirmation.kind==='pending')exactV2(p.confirmation,['kind']);
    else if(p.confirmation.kind==='held'){exactV2(p.confirmation,['kind','reason']);if(!['parent_unknown','parent_refused','parent_conflict','prediction_mismatch','intent_unproven'].includes(p.confirmation.reason))fail();}
    else if(p.confirmation.kind==='confirmed'){exactV2(p.confirmation,['kind','reply','submission']);if(confirmAllocation(p,p.confirmation.reply).confirmation.kind!=='confirmed')fail();}
    else fail();
  }else fail();predecessorPosition(p);return p;
}
/** Synchronous clone/freeze. Validation never replaces the original byte order,
 * timezone spelling, IDs, or tap. Malformed input throws before any storage use. */
export function freezeCrossJobOriginal(input:Omit<OriginalV3,'commandBytes'>):OriginalV3 {
  const v=freezeV2(input);exactV2(v,['command','prediction','predecessor','anchor','fences','expectedHead']);allocationCommand(v.command);
  const c=v.command,p=c.payload,predicted=predictAllocation(c,v.prediction.status),f=fences(v.fences);
  if(!equal(predicted.prediction,v.prediction)||c.ownerId!==f.userId||p.deviceId!==f.deviceId||('projectId'in p.intent&&p.intent.projectId!==f.selectedJobId))fail('invalid_original');
  const anchor=parseSnapshotV2(v.anchor,p.deviceId);
  if('availability'in anchor||!anchor.state?.shift||!anchor.observation||anchor.capability.mode==='unavailable'||p.shiftRef?.kind!=='shift'||p.shiftRef.id!==anchor.state.shift.id||p.basis.observationId!==anchor.observation.id)fail('invalid_anchor');
  const prior=v.predecessor===null?null:parent(v.predecessor),h=parseHead(v.expectedHead);
  if(h&&(h.ownerId!==c.ownerId||h.deviceId!==p.deviceId||h.loginGeneration!==f.loginGeneration))fail('head_conflict');
  if(p.intent.kind==='establish_stream'){
    if(prior!==null||p.clientSequence!==0||p.predecessorCommandId!==null||p.expectedRevision!==anchor.state.revision||p.expectedAllocationId!==anchor.state.shift.allocationId||p.intent.previousGeneration!==anchor.observation.currentGeneration||p.intent.previousHeadCommandId!==anchor.observation.currentHeadCommandId)fail('invalid_genesis');
  }else{
    if(!prior)fail('missing_predecessor');const position=predecessorPosition(prior),pp=prior.protocol===1?prior.payload:prior.command.payload;
    if(position.ownerId!==c.ownerId||position.deviceId!==p.deviceId||position.generation!==p.clientGeneration||position.commandId!==p.predecessorCommandId||position.sequence+1!==p.clientSequence||position.afterRevision!==p.expectedRevision||position.allocationId!==p.expectedAllocationId||pp.shiftRef?.kind!=='shift'||pp.shiftRef.id!==p.shiftRef.id)fail('lineage_conflict');
    if(prior.protocol===1&&(h!==null||position.status!=='confirmed'||anchor.stream?.headCommandId!==position.commandId||anchor.stream.headSequence!==position.sequence||anchor.stream.clientGeneration!==position.generation||anchor.state.revision!==position.afterRevision||anchor.state.shift.allocationId!==position.allocationId))fail('invalid_v1_handoff');
    if(prior.protocol===2&&(!h||h.commandId!==position.commandId||h.generation!==position.generation||h.sequence!==position.sequence||h.afterRevision!==position.afterRevision||h.allocationId!==position.allocationId||h.shiftId!==p.shiftRef.id))fail('head_conflict');
  }
  return freezeV2({...v,commandBytes:JSON.stringify(v.command)});
}
function original(value:OriginalV3):OriginalV3 {
  exactV2(value,['command','prediction','predecessor','anchor','fences','expectedHead','commandBytes']);
  const {commandBytes,...rest}=value,v=freezeCrossJobOriginal(rest);if(v.commandBytes!==commandBytes)fail();return freezeV2(value);
}
export function crossJobHead(record:RecordV3):HeadV3 {
  const r=parseCrossJobRecord(record),c=r.original.command,p=c.payload;
  return freezeV2({key:key(c.ownerId,p.deviceId),ownerId:c.ownerId,deviceId:p.deviceId,loginGeneration:r.original.fences.loginGeneration,generation:p.clientGeneration,commandId:c.commandId,sequence:p.clientSequence,afterRevision:r.original.prediction.afterRevision,allocationId:r.original.prediction.allocationId,shiftId:p.shiftRef!.id});
}
export function parseCrossJobRecord(value:unknown):RecordV3 {
  const r=freezeV2(value,250000) as RecordV3;exactV2(r,['encodingVersion','commandId','ownerId','deviceId','generation','sequence','original','revision','everAttempted','attemptToken','hold','historical']);
  const o=original(r.original),c=o.command,p=c.payload;
  if(r.encodingVersion!==3||r.commandId!==c.commandId||r.ownerId!==c.ownerId||r.deviceId!==p.deviceId||r.generation!==p.clientGeneration||r.sequence!==p.clientSequence||!safe(r.revision)||typeof r.everAttempted!=='boolean'||(r.hold!==null&&!holds.includes(r.hold))||r.everAttempted!==(r.attemptToken!==null))fail();
  if(r.attemptToken!==null)activityUuid(r.attemptToken);
  if((r.everAttempted&&r.revision<1)||(!r.everAttempted&&r.hold===null&&r.revision!==0)||(r.historical!==null&&r.revision<2))fail();
  if(r.historical!==null){
    if(!r.everAttempted)fail();exactV2(r.historical,['submission','lookup','confirmed']);const h=r.historical;
    exactV2(h.submission,['command','reply']);allocationCommand(h.submission.command);
    if(!equal(h.submission.command,c)||parseCommandReplyV2(h.submission.reply,c.commandId).availability!=='available')fail();
    if(h.lookup!==null)parseReceiptReplyV2(h.lookup,c.commandId);
    if(h.confirmed!==null){const confirmed=confirmAllocation(predictAllocation(c,o.prediction.status),h.lookup,h.submission);if(confirmed.confirmation.kind!=='confirmed'||!equal(confirmed,h.confirmed))fail();}
    else if(r.hold===null)fail();
  }
  return r;
}
/** No global factory lookup and no side effects until this explicit call. */
function schema(db:IDBDatabase,tx:IDBTransaction,version:number):void {
  const specs:[string,string,string|null,string[]|null][]=[['commands','command.requestId','by_stream',['command.ownerId','command.deviceId','command.sequence']],['heads','streamKey',null,null]];
  if(version>=2)specs.push(['protocol_commands','commandId','by_stream_generation',['ownerId','payload.deviceId','payload.clientGeneration','payload.clientSequence']],['protocol_heads','key',null,null]);
  if(version>=3)specs.push([CROSS_JOB_COMMANDS,'commandId',CROSS_JOB_SEQUENCE_INDEX,['ownerId','deviceId','generation','sequence']],[CROSS_JOB_HEADS,'key',null,null]);
  if(!equal([...db.objectStoreNames].sort(),specs.map(s=>s[0]).sort()))fail('schema_drift');
  for(const [name,path,index,indexPath] of specs){const store=tx.objectStore(name);if(store.keyPath!==path||store.autoIncrement||!equal([...store.indexNames],index?[index]:[]))fail('schema_drift');if(index){const i=store.index(index);if(!equal(i.keyPath,indexPath)||!i.unique||i.multiEntry)fail('schema_drift');}}
}
export function openCrossJobJournalV3(factory:IDBFactory):Promise<IDBDatabase> {
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
        const s=db.createObjectStore(CROSS_JOB_COMMANDS,{keyPath:'commandId'});s.createIndex(CROSS_JOB_SEQUENCE_INDEX,['ownerId','deviceId','generation','sequence'],{unique:true});
        db.createObjectStore(CROSS_JOB_HEADS,{keyPath:'key'});
      }catch(error){request.transaction?.abort();refuse(error);}
    };
    request.onsuccess=()=>{const db=request.result;if(failed){db.close();return;}clearTimeout(timer);try{schema(db,db.transaction([...db.objectStoreNames],'readonly'),3);}catch(error){db.close();refuse(error);return;}db.onversionchange=()=>db.close();resolve(db);};
  });
}
function transaction<T>(db:IDBDatabase,context:JournalContextV3,mode:IDBTransactionMode,work:(tx:IDBTransaction,done:(value:T)=>void,abort:(error:unknown)=>void,guard:()=>void)=>void):Promise<T> {
  const expected=fences(context.expected);checkContext(context,expected);
  return new Promise((resolve,reject)=>{
    let tx:IDBTransaction;try{if(db.name!==CROSS_JOB_DB_NAME||db.version!==3)fail('wrong_database');tx=db.transaction([CROSS_JOB_COMMANDS,CROSS_JOB_HEADS,'protocol_commands','protocol_heads'],mode,mode==='readwrite'?{durability:'strict'}:undefined);}catch(error){reject(error);return;}
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
export async function appendCrossJobOriginal(db:IDBDatabase,input:OriginalV3,context:JournalContextV3):Promise<{record:RecordV3;created:boolean}> {
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
export function readCrossJobOriginal(db:IDBDatabase,commandId:string,context:JournalContextV3):Promise<RecordV3|null> {
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
export async function claimCrossJobOriginal(db:IDBDatabase,commandId:string,token:string,context:JournalContextV3,admission:AdmissionV3):Promise<ClaimV3|null> {
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
  if(!record)return null;try{checkContext(context,context.expected);}catch{throw new JournalV3Error('context_changed_after_commit',true,record.original);}const ticket=freezeV2({command:record.original.command,token});tickets.set(ticket,{db,original:record.original,sendConsumed:false});return ticket;
}
/** Consume before the first transport/authentication await. The native claim
 * is private and DB-handle-bound; copies/reloads cannot reconstruct this right.
 * Consumption is permanent and independent of the one settlement permission. */
export function consumeCrossJobSend(db:IDBDatabase,ticket:ClaimV3):OriginalV3 {
  const active=tickets.get(ticket);
  if(!active||active.db!==db||active.sendConsumed)fail('send_capability_missing');
  active.sendConsumed=true;return active.original;
}
/** Read-only final lineage capture. No new claim, hold, retry or permission.
 * The returned synchronous predicate reuses the protected planner and original
 * lease after the read await. It cannot make the DB snapshot atomic with a
 * later RPC; the backend still enforces revision/lineage and authorization. */
export async function prepareCrossJobSendCheck(db:IDBDatabase,ticket:ClaimV3,context:JournalContextV3):Promise<(admission:AdmissionV3)=>boolean> {
  context=lockContext(context);const active=tickets.get(ticket);
  if(!active||active.db!==db||!active.sendConsumed)fail('send_capability_missing');
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
      if(tickets.get(ticket)!==active)return false;
      checkContext(context,context.expected);
      const a=admissionInput(admission,context.expected.deviceId);if(!a)return false;
      const snapshot=freshAdmission(captured.record,a);if(!snapshot)return false;
      return checkV2SendPrerequisites(plan(captured.record),{parents:captured.parents,currentFences:context.current(),snapshot,elapsedMs:a.elapsedMs,serverNow:a.serverNow}).kind==='ready';
    }catch{return false;}
  };
}
/** One live in-memory claim may append actual request/reply provenance once.
 * It is a caller/transport obligation; this module cannot authenticate a reply. */
export function settleCrossJobClaim(db:IDBDatabase,ticket:ClaimV3,context:JournalContextV3,submission:SubmissionProvenanceV2|null,lookup:unknown):Promise<RecordV3> {
  context=lockContext(context);const active=tickets.get(ticket);if(!active||active.db!==db)fail('claim_capability_missing');tickets.delete(ticket);
  const proof=submission===null?null:freezeV2(submission),view=lookup===null?null:freezeV2(lookup);
  return transaction(db,context,'readwrite',(tx,done,abort,guard)=>{
    const store=tx.objectStore(CROSS_JOB_COMMANDS);request(store.get(ticket.command.commandId),abort,raw=>{
      guard();const r=parseCrossJobRecord(raw);if(!scoped(r,context.expected)||r.attemptToken!==ticket.token||!r.everAttempted||!equal(r.original,active.original)||r.historical!==null)fail('claim_conflict');
      let hold:HoldV3='unknown',historical:RecordV3['historical']=null;
      if(proof!==null){
        exactV2(proof,['command','reply']);if(!equal(proof.command,r.original.command))fail('submission_identity_conflict');const reply=parseCommandReplyV2(proof.reply,r.commandId);
        if(reply.availability==='available'){
          const parsed=view===null?null:parseReceiptReplyV2(view,r.commandId),confirmed=confirmAllocation(predictAllocation(r.original.command,r.original.prediction.status),parsed,proof);
          historical={submission:proof,lookup:parsed,confirmed:confirmed.confirmation.kind==='confirmed'?confirmed:null};
          hold=reply.receipt.status==='refused'?'refused':reply.receipt.status==='conflict'?'conflict':confirmed.confirmation.kind==='confirmed'?'unknown':'intent_unproven';
        }
      }
      const next=parseCrossJobRecord({...r,revision:r.revision+1,historical,hold:r.hold??(historical?.confirmed?null:hold)});store.put(next);request(store.get(r.commandId),abort,()=>{guard();done(next);});
    });
  });
}
/** Later unavailable/conflicting lookup can close admission but never erase or
 * replace the historical request/response association and successful receipt. */
export function holdCrossJobOriginal(db:IDBDatabase,commandId:string,context:JournalContextV3,reason:HoldV3):Promise<RecordV3> {
  context=lockContext(context);activityUuid(commandId);if(!holds.includes(reason))fail('invalid_hold');return transaction(db,context,'readwrite',(tx,done,abort)=>{
    const store=tx.objectStore(CROSS_JOB_COMMANDS);request(store.get(commandId),abort,raw=>{const r=parseCrossJobRecord(raw);if(!scoped(r,context.expected))fail('context_changed');const next=parseCrossJobRecord({...r,revision:r.revision+1,hold:r.hold??reason});store.put(next);request(store.get(commandId),abort,()=>done(next));});
  });
}

/** A returned row is evidence, never a reconstructed permission to send. */
export function crossJobDelivery(record:RecordV3):'unattempted'|'held'|'attempted_unknown'|'confirmed' {
  const r=parseCrossJobRecord(record);if(r.hold!==null)return 'held';if(r.historical?.confirmed)return 'confirmed';return r.everAttempted?'attempted_unknown':'unattempted';
}
