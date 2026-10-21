// Public Playwright ConsoleMessage/Worker only. No CDP attachment/debugger call.
export function createWorkerConsoleRecorder({mode,fileHashes,origin='http://localhost:5196'}) {
 const workerIds=new WeakMap(),records=[],gaps=[];let nextWorker=0;const fresh=new Map();
 function receive(message){
  const text=message.text();if(!text.startsWith('PWA_RESPONSE_EXPERIMENT '))return;
  if(records.length>=2048){if(!gaps.includes('capture-cap'))gaps.push('capture-cap');return;}
  try{
   const worker=message.worker();if(!worker){gaps.push('missing-public-worker-identity');return;}
   if(message.page()!==null){gaps.push('not-service-worker-console');return;}
   if(!workerIds.has(worker))workerIds.set(worker,++nextWorker);
   const workerOrdinal=workerIds.get(worker);const data=JSON.parse(text.slice('PWA_RESPONSE_EXPERIMENT '.length));
   const row={workerOrdinal,workerURL:worker.url(),browserTimestamp:message.timestamp(),receivedAt:Date.now(),targetId:null,engineRequestId:null,data};
   // Metadata is finite/static only; no argument.jsonValue/evaluate/body fetching.
   const url=new URL(data.requestURL);if(url.origin!==origin||url.search||url.hash||!/^\/assets\/[^/]+-[A-Za-z0-9_-]{8}\.js$/.test(url.pathname))throw Error('Nonstatic record');
   if(!/^[a-f0-9]{64}$/.test(fileHashes[url.pathname.slice(1)]??''))throw Error('Unenrolled static URL');
   if(data.mode!==mode)throw Error('Arm mode mismatch');
   if(!Number.isSafeInteger(data.responseId)||data.responseId<1)throw Error('Invalid responseId');
   const key=workerOrdinal+':'+data.responseId;
   if(data.disposition==='post-clone-fallback')row.validation='INVALID_POST_CLONE';
   else if(data.disposition==='fresh'){
    if(fresh.has(key))throw Error('Duplicate fresh id');fresh.set(key,row);row.validation='PENDING_DIGEST';
   }else if(data.disposition==='digest-complete'){
    const prior=fresh.get(key);if(!prior||prior.data.requestURL!==data.requestURL)throw Error('Unpaired digest');
    if(data.sha256!==fileHashes[url.pathname.slice(1)]||data.bytes!==prior.data.bytes)throw Error('Digest/body mismatch');
    prior.validation='BYTE_PARITY_ONLY_ENGINE_IDENTITY_UNKNOWN';row.validation='BYTE_PARITY_ONLY_ENGINE_IDENTITY_UNKNOWN';fresh.delete(key);
   }else if(data.disposition==='original'&&mode==='baseline')row.validation='INSTRUMENTED_CONTROL_ENGINE_IDENTITY_UNKNOWN';
   else row.validation='INVALID_OR_UNKNOWN';
   records.push(row);
  }catch(error){gaps.push(String(error));}
 }
 return {receive,finish(){return {mode,records,gaps:[...gaps,...[...fresh.keys()].map(k=>'unpaired-fresh:'+k)],earlyRecordCoverage:'UNKNOWN',workerIdentity:'public Worker object ordinal; NOT a CDP target/version join',engineRequestIdentity:'UNKNOWN until exact trace-flow reconciliation',additionalAutoAttachOrDebuggerCommands:0};}};
}
