import { openWorkJournal, PROTOCOL_COMMANDS, PROTOCOL_HEADS, PROTOCOL_STREAM_INDEX } from '../workCapture/storage';
import { activityJsonClone, activityUuid, parsePayload, parseReceiptReply, type Payload, type Receipt, type ReceiptReply } from './protocol';
export interface ActivityCommandRecord {
  encodingVersion:2; commandId:string; ownerId:string; payload:Payload;
  uncertain:boolean; receipt:Receipt|null;
}
interface Head { key:string; ownerId:string; deviceId:string; clientGeneration:string; sequence:number; commandId:string }
export type JournalOptions={factory?:IDBFactory};
export class ActivityJournalUnavailableError extends Error {
  constructor(){super('The activity request could not be saved.');this.name='ActivityJournalUnavailableError';}
}
export class ActivityJournalConflictError extends Error {
  constructor(){super('The saved activity stream changed. Reconcile it before continuing.');this.name='ActivityJournalConflictError';}
}
export type DispatchReadiness={ready:true}|{ready:false;reason:'settled'|'predecessor_unknown'|'needs_reaffirmation'|'retired_generation'};
const conflict=():never=>{throw new ActivityJournalConflictError();};
const key=(ownerId:string,deviceId:string)=>`${ownerId}:${deviceId}`;
const exactKeys=(v:object,keys:readonly string[])=>{if(Object.keys(v).length!==keys.length || keys.some(k=>!Object.hasOwn(v,k)))conflict();};
const safeInt=(n:unknown):n is number=>typeof n==='number' && Number.isSafeInteger(n) && n>=0;
function parseRecord(value:unknown):ActivityCommandRecord{
  const raw=activityJsonClone(value);
  if(!raw || typeof raw!=='object' || Array.isArray(raw))return conflict();
  exactKeys(raw,['encodingVersion','commandId','ownerId','payload','uncertain','receipt']);
  const r=raw as ActivityCommandRecord;
  if(r.encodingVersion!==2 || typeof r.uncertain!=='boolean')return conflict();
  const commandId=activityUuid(r.commandId),ownerId=activityUuid(r.ownerId),payload=parsePayload(r.payload);
  const receipt=r.receipt===null?null:parseReceiptReply({protocolVersion:1,availability:'available',receipt:r.receipt},commandId).receipt;
  if(receipt && r.uncertain)return conflict();
  return {encodingVersion:2,commandId,ownerId,payload,uncertain:r.uncertain,receipt};
}
function parseHead(value:unknown,ownerId:string,deviceId:string):Head|null{
  if(value===undefined)return null;
  const raw=activityJsonClone(value);
  if(!raw || typeof raw!=='object' || Array.isArray(raw))return conflict();
  exactKeys(raw,['key','ownerId','deviceId','clientGeneration','sequence','commandId']);
  const h=raw as Head;
  if(h.key!==key(ownerId,deviceId) || h.ownerId!==ownerId || h.deviceId!==deviceId || !safeInt(h.sequence))return conflict();
  activityUuid(h.clientGeneration);activityUuid(h.commandId);return h;
}
function canonical(value:unknown):string{
  return JSON.stringify(value,(_k,v:unknown)=>v && typeof v==='object' && !Array.isArray(v)
    ? Object.fromEntries(Object.keys(v).sort().map(k=>[k,(v as Record<string,unknown>)[k]])):v);
}
function scope(ownerId:string,deviceId:string){activityUuid(ownerId);activityUuid(deviceId);}
async function open(options?:JournalOptions){
  try{return await openWorkJournal(options?.factory??globalThis.indexedDB);}catch{throw new ActivityJournalUnavailableError();}
}
async function transaction<T>(stores:string[],mode:IDBTransactionMode,options:JournalOptions|undefined,work:(tx:IDBTransaction,set:(v:T)=>void,fail:(e:unknown)=>void)=>void):Promise<T>{
  const db=await open(options);
  try{return await new Promise<T>((resolve,reject)=>{
    let tx:IDBTransaction;
    try{tx=db.transaction(stores,mode);}catch{reject(new ActivityJournalUnavailableError());return;}
    let result:T,hasResult=false,failure:unknown;
    const fail=(error:unknown)=>{failure=error;try{tx.abort();}catch{reject(error);}};
    tx.oncomplete=()=>hasResult?resolve(result):reject(new ActivityJournalUnavailableError());
    tx.onabort=()=>reject(failure??new ActivityJournalUnavailableError());
    tx.onerror=()=>{failure??=new ActivityJournalUnavailableError();};
    try{work(tx,value=>{result=value;hasResult=true;},fail);}catch(error){fail(error);}
  });}finally{db.close();}
}
/** Complete original payload is frozen synchronously. The native transaction
 * rereads the head/tail; it never changes a submitted sequence or predecessor. */
export async function appendActivityCommand(input:{commandId:string;ownerId:string;payload:Payload},options?:JournalOptions):Promise<ActivityCommandRecord>{
  const frozen=activityJsonClone(input);exactKeys(frozen,['commandId','ownerId','payload']);
  const commandId=activityUuid(frozen.commandId),ownerId=activityUuid(frozen.ownerId),payload=parsePayload(frozen.payload);
  return transaction([PROTOCOL_COMMANDS,PROTOCOL_HEADS],'readwrite',options,(tx,set,fail)=>{
    const commands=tx.objectStore(PROTOCOL_COMMANDS),heads=tx.objectStore(PROTOCOL_HEADS);
    const existing=commands.get(commandId),headRequest=heads.get(key(ownerId,payload.deviceId));
    let existingReady=false,headReady=false;
    const proceed=()=>{
      if(!existingReady || !headReady)return;
      try{
        const head=parseHead(headRequest.result,ownerId,payload.deviceId);
        const apply=(tailValue:unknown)=>{
          try{
            if(head){
              const tail=parseRecord(tailValue);
              if(tail.ownerId!==ownerId || tail.payload.deviceId!==payload.deviceId || tail.payload.clientGeneration!==head.clientGeneration || tail.payload.clientSequence!==head.sequence || tail.commandId!==head.commandId)return conflict();
            }else if(tailValue!==undefined)return conflict();
            if(existing.result!==undefined){
              const prior=parseRecord(existing.result);
              if(prior.ownerId!==ownerId || canonical(prior.payload)!==canonical(payload))return conflict();
              set(prior);return;
            }
            if(payload.intent.kind==='establish_stream'){
              if(head?.clientGeneration===payload.clientGeneration)return conflict();
            }else if(!head || head.clientGeneration!==payload.clientGeneration || head.sequence>=Number.MAX_SAFE_INTEGER || payload.clientSequence!==head.sequence+1 || payload.predecessorCommandId!==head.commandId)return conflict();
            const row:ActivityCommandRecord={encodingVersion:2,commandId,ownerId,payload,uncertain:false,receipt:null};
            commands.add(row);
            heads.put({key:key(ownerId,payload.deviceId),ownerId,deviceId:payload.deviceId,clientGeneration:payload.clientGeneration,sequence:payload.clientSequence,commandId} satisfies Head);
            set(parseRecord(row));
          }catch(error){fail(error);}
        };
        if(head){
          const range=IDBKeyRange.bound([ownerId,payload.deviceId,head.clientGeneration,0],[ownerId,payload.deviceId,head.clientGeneration,Number.MAX_SAFE_INTEGER]);
          const tail=commands.index(PROTOCOL_STREAM_INDEX).openCursor(range,'prev');
          tail.onsuccess=()=>apply(tail.result?.value);
        }else apply(undefined);
      }catch(error){fail(error);}
    };
    existing.onsuccess=()=>{existingReady=true;proceed();};headRequest.onsuccess=()=>{headReady=true;proceed();};
  });
}
export async function getActivityCommand(ownerId:string,deviceId:string,commandId:string,options?:JournalOptions):Promise<ActivityCommandRecord|null>{
  scope(ownerId,deviceId);activityUuid(commandId);
  return transaction([PROTOCOL_COMMANDS],'readonly',options,(tx,set,fail)=>{
    const request=tx.objectStore(PROTOCOL_COMMANDS).get(commandId);
    request.onsuccess=()=>{try{const row=request.result===undefined?null:parseRecord(request.result);set(row?.ownerId===ownerId && row.payload.deviceId===deviceId?row:null);}catch(error){fail(error);}};
  });
}
async function update(ownerId:string,deviceId:string,commandId:string,submitted:Payload,options:JournalOptions|undefined,change:(row:ActivityCommandRecord)=>ActivityCommandRecord):Promise<ActivityCommandRecord>{
  scope(ownerId,deviceId);activityUuid(commandId);const original=parsePayload(submitted);
  return transaction([PROTOCOL_COMMANDS],'readwrite',options,(tx,set,fail)=>{
    const store=tx.objectStore(PROTOCOL_COMMANDS),request=store.get(commandId);
    request.onsuccess=()=>{try{
      const row=parseRecord(request.result);
      if(row.ownerId!==ownerId || row.payload.deviceId!==deviceId || canonical(row.payload)!==canonical(original))return conflict();
      const next=parseRecord(change(row));store.put(next);set(next);
    }catch(error){fail(error);}};
  });
}
/** Persist uncertainty BEFORE send. Known SQL refusal cannot erase it. */
export async function markActivityAttempt(ownerId:string,deviceId:string,commandId:string,submitted:Payload,options?:JournalOptions):Promise<ActivityCommandRecord>{
  return update(ownerId,deviceId,commandId,submitted,options,row=>row.receipt?row:{...row,uncertain:true});
}
/** Bind outcome to the exact local row used for that request, independently of
 * any current source projection. Unavailable replies never clear uncertainty. */
export async function recordActivityReceipt(ownerId:string,deviceId:string,commandId:string,submitted:Payload,reply:ReceiptReply,options?:JournalOptions):Promise<ActivityCommandRecord>{
  const response=parseReceiptReply(reply,commandId);
  return update(ownerId,deviceId,commandId,submitted,options,row=>{
    if(response.availability==='unavailable')return row;
    if(row.receipt && canonical(row.receipt)!==canonical(response.receipt))return conflict();
    return {...row,receipt:response.receipt,uncertain:false};
  });
}
export async function getActivityDispatchReadiness(ownerId:string,deviceId:string,commandId:string,options?:JournalOptions):Promise<DispatchReadiness>{
  scope(ownerId,deviceId);activityUuid(commandId);
  return transaction([PROTOCOL_COMMANDS,PROTOCOL_HEADS],'readonly',options,(tx,set,fail)=>{
    const store=tx.objectStore(PROTOCOL_COMMANDS),request=store.get(commandId),headRequest=tx.objectStore(PROTOCOL_HEADS).get(key(ownerId,deviceId));
    let rowReady=false,headReady=false;
    const proceed=()=>{if(!rowReady || !headReady)return;try{
      const row=parseRecord(request.result),head=parseHead(headRequest.result,ownerId,deviceId);
      if(row.ownerId!==ownerId || row.payload.deviceId!==deviceId)return conflict();
      if(row.receipt){set({ready:false,reason:'settled'});return;}
      if(!head || head.clientGeneration!==row.payload.clientGeneration){set({ready:false,reason:'retired_generation'});return;}
      const range=IDBKeyRange.bound([ownerId,deviceId,head.clientGeneration,0],[ownerId,deviceId,head.clientGeneration,Number.MAX_SAFE_INTEGER]);
      const tailRequest=store.index(PROTOCOL_STREAM_INDEX).openCursor(range,'prev');
      tailRequest.onsuccess=()=>{try{
        const tail=parseRecord(tailRequest.result?.value);
        if(tail.ownerId!==ownerId || tail.payload.deviceId!==deviceId || tail.payload.clientGeneration!==head.clientGeneration || tail.payload.clientSequence!==head.sequence || tail.commandId!==head.commandId)return conflict();
      if(row.payload.intent.kind==='establish_stream'){set({ready:true});return;}
      const predecessor=store.get(row.payload.predecessorCommandId!);
      predecessor.onsuccess=()=>{try{
        if(predecessor.result===undefined){set({ready:false,reason:'predecessor_unknown'});return;}
        const prior=parseRecord(predecessor.result);
        if(prior.ownerId!==ownerId || prior.payload.deviceId!==deviceId || prior.payload.clientGeneration!==row.payload.clientGeneration || prior.payload.clientSequence+1!==row.payload.clientSequence)return conflict();
        if(!prior.receipt){set({ready:false,reason:'predecessor_unknown'});return;}
        if(!['applied','noop'].includes(prior.receipt.status) || prior.receipt.afterRevision!==row.payload.expectedRevision){set({ready:false,reason:'needs_reaffirmation'});return;}
        set({ready:true});
        }catch(error){fail(error);}};
    }catch(error){fail(error);}};
    }catch(error){fail(error);}};
    request.onsuccess=()=>{rowReady=true;proceed();};headRequest.onsuccess=()=>{headReady=true;proceed();};
  });
}
/** Restore only the exact durable head of this owner's device. Legacy encoding
 * stores and retired generations are never converted into a dispatchable head. */
export async function getCurrentActivityCommand(ownerId:string,deviceId:string,options?:JournalOptions):Promise<ActivityCommandRecord|null>{
  scope(ownerId,deviceId);
  return transaction([PROTOCOL_COMMANDS,PROTOCOL_HEADS],'readonly',options,(tx,set,fail)=>{
    const store=tx.objectStore(PROTOCOL_COMMANDS),request=tx.objectStore(PROTOCOL_HEADS).get(key(ownerId,deviceId));
    request.onsuccess=()=>{try{
      const head=parseHead(request.result,ownerId,deviceId);
      if(!head){set(null);return;}
      const range=IDBKeyRange.bound([ownerId,deviceId,head.clientGeneration,0],[ownerId,deviceId,head.clientGeneration,Number.MAX_SAFE_INTEGER]);
      const tail=store.index(PROTOCOL_STREAM_INDEX).openCursor(range,'prev');
      tail.onsuccess=()=>{try{
        const row=parseRecord(tail.result?.value);
        if(row.ownerId!==ownerId || row.payload.deviceId!==deviceId || row.payload.clientGeneration!==head.clientGeneration || row.payload.clientSequence!==head.sequence || row.commandId!==head.commandId)return conflict();
        set(row);
      }catch(error){fail(error);}};
    }catch(error){fail(error);}};
  });
}
