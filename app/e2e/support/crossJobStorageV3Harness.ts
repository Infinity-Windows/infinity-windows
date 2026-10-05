/** Loaded only by an isolated native fixture page, never the app. */
import * as storage from '../../src/lib/workCapture/crossJobStorageV3';
import * as values from '../../src/lib/workCapture/crossJobStorageV3.fixtures';
import { predictAllocation } from '../../src/lib/workActivity/allocationPredecessor';
let current=values.fences();
export const context=()=>({expected:values.fences(),current:()=>current});
export const setContext=(patch:Partial<typeof current>)=>{current={...current,...patch};};
export const open=()=>storage.openCrossJobJournalV3(indexedDB);
export const admission=(o=values.genesis())=>({snapshot:o.anchor,elapsedMs:0,serverNow:o.anchor.asOf});
export const complete=(tx:IDBTransaction)=>new Promise<void>((resolve,reject)=>{tx.oncomplete=()=>resolve();tx.onabort=()=>reject(tx.error);tx.onerror=()=>reject(tx.error);});
export const get=<T>(r:IDBRequest<T>)=>new Promise<T>((resolve,reject)=>{r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
export async function settle(db:IDBDatabase,ticket:storage.ClaimV3,ctx=context()){const p=predictAllocation(ticket.command,ticket.command.payload.intent.kind==='establish_stream'?'noop':'applied');return storage.settleCrossJobClaim(db,ticket,ctx,values.submission(p),values.lookup(p));}
export async function seedLegacy(version:1|2,keep=false){
  const db=await new Promise<IDBDatabase>((resolve,reject)=>{const r=indexedDB.open(storage.CROSS_JOB_DB_NAME,version);r.onupgradeneeded=()=>{
    const c=r.result.createObjectStore('commands',{keyPath:'command.requestId'});c.createIndex('by_stream',['command.ownerId','command.deviceId','command.sequence'],{unique:true});r.result.createObjectStore('heads',{keyPath:'streamKey'});
    if(version===2){const p=r.result.createObjectStore('protocol_commands',{keyPath:'commandId'});p.createIndex('by_stream_generation',['ownerId','payload.deviceId','payload.clientGeneration','payload.clientSequence'],{unique:true});r.result.createObjectStore('protocol_heads',{keyPath:'key'});}
  };r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
  const tx=db.transaction([...db.objectStoreNames],'readwrite');
  tx.objectStore('commands').add({command:{requestId:values.id(90),ownerId:values.id(1),deviceId:values.id(2),sequence:0,opaque:'original Ω\r\n tap +06:00'},receipt:{opaque:true},blob:new Blob([new Uint8Array([0,255,7])])});
  tx.objectStore('heads').add({streamKey:'opaque:head',original:{array:[null,false,0,'1.000000000000000001']}});
  if(version===2){const h=values.handoff().predecessor!;if(h.protocol!==1)throw Error();tx.objectStore('protocol_commands').add({encodingVersion:2,commandId:h.commandId,ownerId:h.ownerId,payload:h.payload,uncertain:false,receipt:h.receipt});tx.objectStore('protocol_heads').add({key:`${h.ownerId}:${h.payload.deviceId}`,ownerId:h.ownerId,deviceId:h.payload.deviceId,clientGeneration:h.payload.clientGeneration,sequence:h.payload.clientSequence,commandId:h.commandId});}
  await complete(tx);if(!keep)db.close();return db;
}
export async function census(db:IDBDatabase){
  const names=[...db.objectStoreNames],tx=db.transaction(names,'readonly');const stores=await Promise.all(names.map(async name=>{const s=tx.objectStore(name);return {name,keyPath:s.keyPath,indexes:[...s.indexNames].map(n=>({name:n,keyPath:s.index(n).keyPath,unique:s.index(n).unique,multiEntry:s.index(n).multiEntry})),rows:await get(s.getAll())};}));
  const material=await Promise.all(stores.map(async s=>({...s,rows:await Promise.all(s.rows.map(async r=>r.blob?{...r,blob:[...new Uint8Array(await r.blob.arrayBuffer())]}:r.photoBlob?{...r,photoBlob:[...new Uint8Array(await r.photoBlob.arrayBuffer())]}:r))})));
  return {version:db.version,stores:material};
}
export {storage,values};
