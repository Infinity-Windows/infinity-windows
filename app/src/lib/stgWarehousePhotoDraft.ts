/** Photo bytes stay on this device until the scoped upload and attachment both succeed. */
export interface PartnerPhotoDraft { actor: string; packageId: string; path: string; file: File }
function open(): Promise<IDBDatabase> {
  return new Promise((resolve,reject)=>{
    const request=indexedDB.open('stg-warehouse-photo-drafts',1);
    request.onupgradeneeded=()=>request.result.createObjectStore('photos',{keyPath:'path'});
    request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);
  });
}
export async function savePartnerPhoto(draft:PartnerPhotoDraft):Promise<void> {
  const db=await open();
  try { await new Promise<void>((resolve,reject)=>{const tx=db.transaction('photos','readwrite');tx.objectStore('photos').put(draft);tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);}); }
  finally {db.close();}
}
export async function loadPartnerPhoto(actor:string,packageId:string):Promise<PartnerPhotoDraft|null> {
  const db=await open();
  try {return await new Promise((resolve,reject)=>{const req=db.transaction('photos').objectStore('photos').getAll();req.onsuccess=()=>resolve((req.result as PartnerPhotoDraft[]).find(x=>x.actor===actor&&x.packageId===packageId)??null);req.onerror=()=>reject(req.error);});}
  finally {db.close();}
}
export async function removePartnerPhoto(path:string):Promise<void> {
  const db=await open();
  try {await new Promise<void>((resolve,reject)=>{const tx=db.transaction('photos','readwrite');tx.objectStore('photos').delete(path);tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);});}
  finally{db.close();}
}
