import { complete as fixtureComplete, census as fixtureCensus, diagnostics as fixtureDiagnostics } from '../../../e2e/support/crossJobStorageV3Harness';
import { describe, expect, it, vi } from 'vitest';
import { freezeCrossJobOriginal, parseCrossJobRecord, openCrossJobJournalV3, settleCrossJobClaim, claimCrossJobOriginal, consumeCrossJobSend, prepareCrossJobSendCheck, type AdmissionV3 } from './crossJobStorageV3';
import { genesis, handoff, row, id, child, queuedChild, admissionAt, timedGenesis, actionHandoff, virginGenesis, withoutObservation, fences, snapshot } from './crossJobStorageV3.fixtures';
import { planActivityV2, checkV2SendPrerequisites } from '../workActivity/plannerV2';
import { parsePayload } from '../workActivity/protocol';
import { parsePayloadV2, parseSnapshotV2 } from '../workActivity/protocolV2';
const input=()=>{const {commandBytes:_,...o}=genesis();return structuredClone(o);};
describe('dormant v3 synchronous original boundary (no native durability claim)',()=>{
  it('freezes complete original before callers await without restamping IDs or taps',()=>{
    const value=input(),bytes=JSON.stringify(value.command),saved=freezeCrossJobOriginal(value);
    value.command.payload.tappedAt='2026-10-05T07:00:00.000000Z';expect(saved.commandBytes).toBe(bytes);expect(JSON.stringify(saved.command)).toBe(bytes);expect(Object.isFrozen(saved.command.payload)).toBe(true);
  });
  it('retains typed settled-v1 and predicted-v2 lineage without rewriting old payload',()=>{
    const old=handoff(),bytes=JSON.stringify(old.predecessor),next=child(row());expect(JSON.stringify(old.predecessor)).toBe(bytes);expect(old.predecessor?.protocol).toBe(1);expect(next.predecessor?.protocol).toBe(2);expect(next.command.payload.predecessorCommandId).toBe(id(50));
  });
  it.each(['commandBytes','ownerId','generation','sequence','everAttempted','attemptToken','revision','encodingVersion'])('rejects stored %s corruption',field=>{
    const saved=structuredClone(row());if(field==='commandBytes')saved.original.commandBytes+=' ';else Object.assign(saved,{[field]:field==='revision'?NaN:'bad'});expect(()=>parseCrossJobRecord(saved)).toThrow();
  });
  it.each(['owner','device','login','preview','job','extra','allocation','shift','sequence','predecessor'])('rejects original %s conflict',kind=>{
    const v=input();if(kind==='owner')v.command.ownerId=id(99);if(kind==='device')v.fences.deviceId=id(99);if(kind==='login')v.fences.loginGeneration=-1;if(kind==='preview')v.fences.preview=true;if(kind==='job'){v.command.payload.intent={kind:'finish_setup',projectId:id(99),costCodeId:null};}if(kind==='extra')Object.assign(v,{unknown:true});if(kind==='allocation')v.command.payload.expectedAllocationId=id(99);if(kind==='shift')v.command.payload.shiftRef={kind:'shift',id:id(99)};if(kind==='sequence')v.command.payload.clientSequence=1;if(kind==='predecessor')v.command.payload.predecessorCommandId=id(99);expect(()=>freezeCrossJobOriginal(v)).toThrow();
  });
  it('refuses forged successful history and copied claim capabilities',()=>{
    const saved=row();Object.assign(saved,{historical:{submission:{},lookup:null,confirmed:null}});expect(()=>parseCrossJobRecord(saved)).toThrow();
    expect(()=>settleCrossJobClaim({} as IDBDatabase,{command:row().original.command,token:id(80)},{expected:row().original.fences,current:()=>row().original.fences},null,null)).toThrow('claim_capability_missing');
  });
  it('throws before opening for non-JSON/accessor input without invoking it',()=>{
    const v=input(),get=vi.fn();Object.defineProperty(v.command.payload,'tappedAt',{get,enumerable:true});expect(()=>freezeCrossJobOriginal(v)).toThrow();expect(get).not.toHaveBeenCalled();
  });
  it('aborts late upgrade after a rejected blocked event and closes late success',async()=>{
    const abort=vi.fn(),close=vi.fn(),createObjectStore=vi.fn(),request={result:{close,createObjectStore},transaction:{abort}} as unknown as IDBOpenDBRequest;
    const promise=openCrossJobJournalV3({open:()=>request} as unknown as IDBFactory);request.onblocked!.call(request,{} as IDBVersionChangeEvent);await expect(promise).rejects.toThrow('upgrade_blocked');request.onupgradeneeded!.call(request,{} as IDBVersionChangeEvent);request.onsuccess!.call(request,{} as Event);expect(abort).toHaveBeenCalledTimes(2);expect(close).toHaveBeenCalledOnce();expect(createObjectStore).not.toHaveBeenCalled();
  });
  it('aborts a late upgrade after finite open timeout',async()=>{
    vi.useFakeTimers();try{const abort=vi.fn(),request={transaction:{abort}} as unknown as IDBOpenDBRequest;const promise=openCrossJobJournalV3({open:()=>request} as unknown as IDBFactory);const rejection=expect(promise).rejects.toThrow('open_timeout');await vi.advanceTimersByTimeAsync(5000);await rejection;request.onupgradeneeded!.call(request,{} as IDBVersionChangeEvent);expect(abort).toHaveBeenCalledTimes(2);}finally{vi.useRealTimers();}
  });
});


describe('recoverable admission evidence does not become a durable outcome',()=>{
  it.each(['extra_context','extra_parents','missing','null_snapshot','nonfinite','negative','invalid_time'])('rejects %s before any native transaction',async kind=>{
    const db={transaction:vi.fn()} as unknown as IDBDatabase,a:Record<string,unknown>={snapshot:snapshot(),elapsedMs:0,serverNow:snapshot().asOf};
    if(kind==='extra_context')a.currentFences=fences();if(kind==='extra_parents')a.parents=[];if(kind==='missing')delete a.elapsedMs;if(kind==='null_snapshot')a.snapshot=null;if(kind==='nonfinite')a.elapsedMs=NaN;if(kind==='negative')a.elapsedMs=-1;if(kind==='invalid_time')a.serverNow='not a timestamp';
    expect(await claimCrossJobOriginal(db,id(50),id(70),{expected:fences(),current:()=>fences()},a as unknown as AdmissionV3)).toBeNull();expect(db.transaction).not.toHaveBeenCalled();
  });
  it.each(['expired_observation','authentication_changed','retired_generation','needs_reaffirmation','action_unavailable'] as const)('retains existing durable %s reason without auto-clearing old holds or changing bytes',reason=>{
    const saved=row(),bytes=saved.original.commandBytes,held=parseCrossJobRecord({...saved,revision:1,hold:reason});expect(held.hold).toBe(reason);expect(held.original.commandBytes).toBe(bytes);expect(held.everAttempted).toBe(false);
  });
});


describe('actual SignInMark is page-local evidence, not a durable authentication epoch',()=>{
  it('resets on a fresh module load even for the same user',async()=>{
    vi.resetModules();const first=await import('../signedIn');first.rememberSignedIn({user:{id:id(1)}});first.rememberSignedIn(null);first.rememberSignedIn({user:{id:id(1)}});const saved=first.signInMark();
    vi.resetModules();const reloaded=await import('../signedIn');expect(reloaded.signInMark()).toEqual({userId:null,generation:0});reloaded.rememberSignedIn({user:{id:id(1)}});expect(reloaded.signInMark()).toEqual({userId:id(1),generation:1});expect(saved.generation).toBe(3);
  });
  it('independent module instances have incomparable counters while same-instance ABA still fences',async()=>{
    vi.resetModules();const a=await import('../signedIn');a.rememberSignedIn({user:{id:id(1)}});const original=a.signInMark();
    vi.resetModules();const b=await import('../signedIn');b.rememberSignedIn({user:{id:id(1)}});b.rememberSignedIn(null);b.rememberSignedIn({user:{id:id(1)}});expect(b.signInGeneration()).toBeGreaterThan(original.generation);expect(a.stillSignedInAs(original,id(1))).toBe(true);a.rememberSignedIn(null);a.rememberSignedIn({user:{id:id(1)}});expect(a.stillSignedInAs(original,id(1))).toBe(false);
  });
});

describe('real pre-parent observation fixtures',()=>{
  it('keeps a queued child anchor at the actual revision before its applied parent',()=>{
    const b=row(handoff()),c=queuedChild(b);expect(c.anchor.state!.revision).toBe(1);expect(c.command.payload.expectedRevision).toBe(2);
    expect(c.anchor.stream!.headCommandId).toBe(id(5));expect(c.command.payload.predecessorCommandId).toBe(b.commandId);
    expect(parseCrossJobRecord(row(c)).original.commandBytes).toBe(c.commandBytes);
  });
  it('keeps original lease unchanged while constructing a separate fresh fixture read',()=>{
    const o=genesis(),before=JSON.stringify(o),a=admissionAt(o,undefined,10001);
    expect(JSON.stringify(o)).toBe(before);expect(a.snapshot.asOf).toBe(a.serverNow);expect(a.snapshot.observation!.issuedAt).toBe(a.serverNow);
    expect(a.snapshot.observation!.id).not.toBe(o.anchor.observation!.id);expect(o.anchor.observation!.expiresAt<a.serverNow).toBe(true);
  });
});

describe('correction five immutable fixture truth table',()=>{
  it('puts the cached read strictly between original anchor and tap without replacing the lease',()=>{const o=timedGenesis(),a=admissionAt(o,undefined,300000);expect(o.anchor.asOf<a.serverNow&&a.serverNow<o.command.payload.tappedAt).toBe(true);expect(o.anchor.observation!.expiresAt).toBe('2026-10-05T10:00:00.123456Z');expect(parseCrossJobRecord(row(o)).original.commandBytes).toBe(o.commandBytes);});
  it('retains a future checked-at instant while a later read can enter its allowed window',()=>{const o=timedGenesis(true),early=admissionAt(o,undefined,1),later=admissionAt(o,undefined,240050);expect(Date.parse(o.command.payload.clockCheckedAt!)-Date.parse(early.serverNow)).toBeGreaterThan(120000);expect(Date.parse(o.command.payload.clockCheckedAt!)-Date.parse(later.serverNow)).toBeLessThanOrEqual(120000);expect(o.command.payload.tappedAt).toBe(o.anchor.asOf);});
  it.each(['stop','finish_setup'] as const)('preserves full predecessor and prediction for %s',kind=>{const o=actionHandoff(kind),saved=parseCrossJobRecord(row(o));expect(saved.original.commandBytes).toBe(o.commandBytes);expect(o.predecessor).toEqual(handoff().predecessor);expect(o.prediction.afterRevision).toBe(2);expect(o.anchor.state!.status).toBe(kind==='stop'?'running':'setup');});
});

describe('optional current evidence and exact protected V2 skew parser',()=>{
  it('accepts observation-null full snapshots only with all actions false',()=>{const s=withoutObservation(snapshot());expect(parseSnapshotV2(s,id(2))).toMatchObject({observation:null,state:{revision:1}});s.state!.actions.canEstablishStream=true;expect(()=>parseSnapshotV2(s,id(2))).toThrow();});
  it('accepts coherent first-stream null pointers without manufacturing a source conflict',()=>{const o=virginGenesis();expect(parseSnapshotV2(o.anchor,id(2))).toMatchObject({stream:null,observation:{currentGeneration:null,currentHeadCommandId:null}});expect(parseCrossJobRecord(row(o)).original.commandBytes).toBe(o.commandBytes);});
  it.each([0.5,-0.5,120000.5,-120000.5])('rejects fractional original skew %s through V2 despite V1 acceptance',skew=>{const o=input();o.command.payload.clockSkewMs=skew;const {expectedAllocationId:_,boundaryMode:__,...v1}=o.command.payload;expect(parsePayload(v1).clockSkewMs).toBe(skew);expect(()=>parsePayloadV2(o.command.payload)).toThrow();expect(()=>freezeCrossJobOriginal(o)).toThrow();const saved=structuredClone(row());saved.original.command.payload.clockSkewMs=skew;saved.original.commandBytes=JSON.stringify(saved.original.command);expect(()=>parseCrossJobRecord(saved)).toThrow();});
  it.each([-2147483649,2147483648])('rejects original skew outside PostgreSQL integer range %s',skew=>{const o=input();o.command.payload.clockSkewMs=skew;expect(()=>freezeCrossJobOriginal(o)).toThrow();});
  it.each([-2147483648,2147483647])('keeps admitted integer skew %s for trust refusal, not a parser repair',skew=>{const o=input();o.command.payload.clockSkewMs=skew;const saved=freezeCrossJobOriginal(o);expect(saved.command.payload.clockSkewMs).toBe(skew);expect(parseCrossJobRecord(row(saved)).original.commandBytes).toBe(saved.commandBytes);});
});

it('protected checker rejects the null-observation diagnostic at its parser instead of proving a concrete conflict',()=>{
  const o=genesis(),p=o.command.payload;
  const plan=planActivityV2({original:{ownerId:o.command.ownerId,deviceId:p.deviceId,commandId:o.command.commandId,action:{kind:'establish_stream',newGeneration:p.clientGeneration},stamp:{tappedAt:p.tappedAt,clockCheckedAt:p.clockCheckedAt,clockSkewMs:p.clockSkewMs}},snapshot:o.anchor,sourceFences:o.fences,currentFences:o.fences,elapsedMs:0,serverNow:o.anchor.asOf,chain:[]});expect(plan.kind).toBe('ready');
  const snapshot=withoutObservation(o.anchor),args={snapshot,parents:[],currentFences:o.fences,elapsedMs:0,serverNow:o.anchor.asOf};expect(checkV2SendPrerequisites(plan,args)).toMatchObject({kind:'held',reason:'needs_reaffirmation'});
  snapshot.state!.actions.canEstablishStream=true;expect(()=>checkV2SendPrerequisites(plan,args)).toThrow();
});

describe('fixture transaction evidence and terminal boundaries',()=>{
  it('retains the request DOMException when bubbling tx.error is null and waits for abort',async()=>{
    const tx={db:{name:'synthetic',version:2},mode:'readwrite',durability:'default',error:null,onerror:null,onabort:null,oncomplete:null} as unknown as IDBTransaction;
    let settled=false;const promise=fixtureComplete(tx,'controlled.write');const outcome=promise.catch(e=>{settled=true;return e as Error;});
    tx.onerror!.call(tx,{target:{source:{name:'commands'},error:new DOMException('duplicate fixture key','ConstraintError')}} as unknown as Event);await Promise.resolve();expect(settled).toBe(false);expect(tx.error).toBeNull();
    tx.onabort!.call(tx,{} as Event);const error=await outcome;expect(error).toBeInstanceOf(Error);expect((error as Error).message).toContain('ConstraintError');expect((error as Error).message).toContain('controlled.write');expect((error as Error).message).toContain('commands');expect(fixtureDiagnostics()).toContainEqual(expect.objectContaining({stage:'controlled.write',event:'error',transactionError:null}));
  });
  it('does not return a census at getAll success before transaction complete',async()=>{
    const request={result:[],onsuccess:null,onerror:null} as unknown as IDBRequest<unknown[]>;
    const store={keyPath:'id',indexNames:[],getAll:()=>request};const tx={db:{name:'synthetic',version:2},mode:'readonly',durability:'default',error:null,objectStore:()=>store,onerror:null,onabort:null,oncomplete:null} as unknown as IDBTransaction;
    const db={name:'synthetic',version:2,objectStoreNames:['commands'],transaction:()=>tx} as unknown as IDBDatabase;
    let returned=false;const promise=fixtureCensus(db).then(value=>{returned=true;return value;});request.onsuccess!.call(request,{} as Event);await Promise.resolve();await Promise.resolve();expect(returned).toBe(false);tx.oncomplete!.call(tx,{} as Event);expect(await promise).toMatchObject({version:2,stores:[{name:'commands',rows:[]}]});expect(returned).toBe(true);
  });
});


describe('V2 private send capability refusal without native authority',()=>{
  it('rejects structural and deserialized claims synchronously before any database transaction',()=>{
    const db={transaction:vi.fn()} as unknown as IDBDatabase,ticket={command:genesis().command,token:id(70)};
    for(const value of [ticket,{...ticket},JSON.parse(JSON.stringify(ticket))])expect(()=>consumeCrossJobSend(db,value)).toThrow('send_capability_missing');
    expect(db.transaction).not.toHaveBeenCalled();
  });
  it('cannot prepare a send checker from a forged claim',async()=>{
    const db={transaction:vi.fn()} as unknown as IDBDatabase;
    await expect(prepareCrossJobSendCheck(db,{command:genesis().command,token:id(70)},{expected:fences(),current:()=>fences()})).rejects.toThrow('send_capability_missing');expect(db.transaction).not.toHaveBeenCalled();
  });
});
