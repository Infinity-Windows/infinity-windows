/** Only the capture journal. Never open or migrate the payroll/photo database. */
export const JOURNAL_DB_NAME='iw-work-capture-journal-v1';
export const JOURNAL_DB_VERSION=2;
export const PROTOCOL_COMMANDS='protocol_commands';
export const PROTOCOL_HEADS='protocol_heads';
export const PROTOCOL_STREAM_INDEX='by_stream_generation';
export function openWorkJournal(factory:IDBFactory):Promise<IDBDatabase>{
  if(!factory)return Promise.reject(Error('IndexedDB unavailable'));
  return new Promise((resolve,reject)=>{
    let request:IDBOpenDBRequest;
    try{request=factory.open(JOURNAL_DB_NAME,JOURNAL_DB_VERSION);}catch(error){reject(error);return;}
    let blocked=false;
    request.onupgradeneeded=()=>{
      const db=request.result;
      // Preserve every version-one command, receipt and head byte-for-byte.
      // Its opaque encoding is archived; protocol dispatch reads separate stores.
      if(!db.objectStoreNames.contains('commands')){
        const commands=db.createObjectStore('commands',{keyPath:'command.requestId'});
        commands.createIndex('by_stream',['command.ownerId','command.deviceId','command.sequence'],{unique:true});
      }
      if(!db.objectStoreNames.contains('heads'))db.createObjectStore('heads',{keyPath:'streamKey'});
      if(!db.objectStoreNames.contains(PROTOCOL_COMMANDS)){
        const commands=db.createObjectStore(PROTOCOL_COMMANDS,{keyPath:'commandId'});
        commands.createIndex(PROTOCOL_STREAM_INDEX,['ownerId','payload.deviceId','payload.clientGeneration','payload.clientSequence'],{unique:true});
      }
      if(!db.objectStoreNames.contains(PROTOCOL_HEADS))db.createObjectStore(PROTOCOL_HEADS,{keyPath:'key'});
    };
    request.onsuccess=()=>{const db=request.result;db.onversionchange=()=>db.close();if(blocked){db.close();return;}resolve(db);};
    request.onerror=()=>reject(request.error??Error('Journal open failed'));
    request.onblocked=()=>{blocked=true;reject(Error('Journal upgrade blocked by another tab'));};
  });
}
