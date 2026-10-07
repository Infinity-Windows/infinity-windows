import { activityUuid } from './protocol';
const DATABASE='iw-work-activity-device-v1',STORE='identity',KEY='browser-device';
export class ActivityDeviceUnavailableError extends Error {
  constructor(){super('This device could not save its activity identity.');this.name='ActivityDeviceUnavailableError';}
}
/** Separate metadata database: never changes journal, payroll or photo schema.
 * One native read/write transaction serializes first use across browser tabs.
 * Resolve only on COMMIT. Corruption/storage failure has no transient fallback. */
export async function getActivityDeviceId(factory:IDBFactory=globalThis.indexedDB):Promise<string>{
  const unavailable=()=>new ActivityDeviceUnavailableError();
  const db=await new Promise<IDBDatabase>((resolve,reject)=>{
    if(!factory){reject(unavailable());return;}
    let request:IDBOpenDBRequest;
    try{request=factory.open(DATABASE,1);}catch{reject(unavailable());return;}
    let blocked=false;
    request.onupgradeneeded=()=>request.result.createObjectStore(STORE,{keyPath:'key'});
    request.onerror=()=>reject(unavailable());
    request.onblocked=()=>{blocked=true;reject(unavailable());};
    request.onsuccess=()=>{const opened=request.result;opened.onversionchange=()=>opened.close();if(blocked){opened.close();return;}resolve(opened);};
  });
  try{return await new Promise<string>((resolve,reject)=>{
    let tx:IDBTransaction;
    try{tx=db.transaction(STORE,'readwrite');}catch{reject(unavailable());return;}
    let id:string|undefined;
    tx.oncomplete=()=>id?resolve(id):reject(unavailable());
    tx.onabort=()=>reject(unavailable());tx.onerror=()=>reject(unavailable());
    const store=tx.objectStore(STORE),request=store.get(KEY);
    request.onsuccess=()=>{try{
      const row=request.result;
      if(row===undefined){id=activityUuid(crypto.randomUUID());store.add({key:KEY,id});}
      else{
        if(!row || typeof row!=='object' || Array.isArray(row) || Object.keys(row).length!==2 || row.key!==KEY || !Object.hasOwn(row,'id'))throw unavailable();
        id=activityUuid(row.id);
      }
    }catch{try{tx.abort();}catch{reject(unavailable());}}};
  });}finally{db.close();}
}
