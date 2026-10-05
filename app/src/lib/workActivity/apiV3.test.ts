import {beforeEach,describe,expect,it,vi} from 'vitest';
import type {ClaimV3,OriginalV3} from '../workCapture/crossJobStorageV3';
import type {RpcPortsV2} from './apiV3';
const state=vi.hoisted(()=>({user:'00000000-0000-0000-0000-000000000001' as string|null,generation:2,caps:new WeakMap<object,{db:object;original:unknown;used:boolean}>(),sessionHook:()=>{},loadHook:()=>{},storageHook:()=>{},rpcHook:(_name:string)=>{},boundHook:()=>{},sessionError:false,sessionOwner:null as string|null,sessionReject:false,storageFail:false,ready:true,settleFail:false,settleHook:()=>{},calls:[] as {token:string;name:string;args:Record<string,unknown>}[],settlements:[] as unknown[],response:null as unknown,snapshot:null as unknown,lookup:null as unknown,rpcError:null as {code:string}|null,lost:false,loads:0,authCalls:0,sdkImports:0,forfeits:0}));
vi.mock('../signedIn',()=>({signInMark:()=>({userId:state.user,generation:state.generation}),stillSignedInAs:(m:{userId:string|null;generation:number},who:string)=>state.user===who&&m.userId===who&&m.generation===state.generation}));
vi.mock('../workCapture/crossJobStorageV4',async original=>({...await original<typeof import('../workCapture/crossJobStorageV4')>(),
  consumeCrossJobSendV4:(db:object,ticket:object)=>{const c=state.caps.get(ticket);if(!c||c.db!==db||c.used)throw Error('missing');c.used=true;let open=true,invoked=false;const o=c.original as OriginalV3;return {original:o,forfeit:()=>{open=false;state.forfeits++;},invocationStarted:()=>invoked,invoke:(ready:()=>boolean,rpc:ReturnType<RpcPortsV2['clientWithToken']>['rpc'])=>{if(!open||invoked||!ready())throw Error('closed');invoked=true;return Promise.resolve(rpc('work_activity_command',{p_command_id:o.command.commandId,p_protocol_version:2,p_payload:o.command.payload})).then(({data,error})=>({data,error:!!error,observedSqlState:error?.code==='23514'||error?.code==='42501'?error.code:null}));}};},
  prepareCrossJobSendCheckV4:async()=>{state.storageHook();if(state.storageFail)throw Error('storage failed');return ()=>state.ready;},
  settleCrossJobClaimV4:async(_db:unknown,_ticket:unknown,context:{current:()=>unknown},submission:unknown,lookup:unknown)=>{context.current();state.settleHook();context.current();if(state.settleFail)throw Error('quota');state.settlements.push({submission,lookup});return {historical:submission?{submission,lookup}:null,everAttempted:true};},
}));
const ports:RpcPortsV2={getSession:async()=>{state.authCalls++;state.sessionHook();if(state.sessionReject)throw Error('auth');return {data:{session:{access_token:'captured-token',user:{id:state.sessionOwner??state.user!}}},error:state.sessionError?Error('auth'):null};},clientWithToken:token=>{state.boundHook();return {rpc:async(name,args)=>{state.calls.push({token,name,args});state.rpcHook(name);if(name==='work_activity_command'&&state.lost)throw Error('lost');return {data:name==='work_cross_job_snapshot'?state.snapshot:name==='work_cross_job_receipt'?state.lookup:state.response,error:name==='work_activity_command'?state.rpcError:null};}};}};
vi.mock('../supabase',()=>{state.sdkImports++;return {supabase:{auth:{getSession:()=>ports.getSession()}},clientWithToken:(token:string)=>ports.clientWithToken(token)};});
import {createActivityTransportV3,submitCrossJobClaimV3,fetchActivitySnapshotV3} from './apiV3';
import {genesis,handoff,id,submission,lookup} from '../workCapture/crossJobStorageV3.fixtures';
import {predictAllocation} from './allocationPredecessor';
const api=createActivityTransportV3(async()=>{state.loads++;state.loadHook();return ports;});
let original:OriginalV3,db:IDBDatabase,ticket:ClaimV3,current:OriginalV3['fences'];
const environment=()=>({context:{expected:original.fences,current:()=>current},clock:()=>({elapsedMs:0,serverNow:original.anchor.asOf})});
const mutationCalls=()=>state.calls.filter(x=>x.name==='work_activity_command');
function issue(o=genesis()) {original=o;db={} as IDBDatabase;ticket=Object.freeze({command:o.command,token:id(71)});current=structuredClone(o.fences);state.caps.set(ticket,{db,original:o,used:false});const prediction=predictAllocation(o.command,o.prediction.status);state.response=submission(prediction).reply;state.lookup=lookup(prediction);state.snapshot=o.anchor;}
beforeEach(()=>{Object.assign(state,{user:id(1),generation:2,caps:new WeakMap(),sessionHook:()=>{},loadHook:()=>{},storageHook:()=>{},rpcHook:()=>{},boundHook:()=>{},sessionError:false,sessionOwner:null,sessionReject:false,storageFail:false,ready:true,settleFail:false,settleHook:()=>{},calls:[],settlements:[],rpcError:null,lost:false,loads:0,authCalls:0,forfeits:0});Object.defineProperty(navigator,'onLine',{configurable:true,value:true});issue();});
describe('dormant V4 evidence adapter control flow; journal/auth/provider are explicit mocks',()=>{
  it('module import does not initialize production SDK/auth/RPC',()=>{expect(state.sdkImports).toBe(0);expect(state.authCalls).toBe(0);expect(state.calls).toEqual([]);});
  it('uses exact protocol2 request and captured bound token, never the v1 API',async()=>{
    const result=await api.submitClaim(db,ticket,environment());expect(result.kind).toBe('receipt');expect(mutationCalls()).toEqual([{token:'captured-token',name:'work_activity_command',args:{p_command_id:original.command.commandId,p_protocol_version:2,p_payload:original.command.payload}}]);
    expect(state.calls.map(x=>x.name)).toEqual(['work_cross_job_snapshot','work_activity_command','work_cross_job_receipt']);expect(state.settlements[0]).toEqual({submission:{command:original.command,reply:state.response},lookup:state.lookup});
  });
  it('burns synchronously before lazy import and only one concurrent invocation sends',async()=>{
    const a=api.submitClaim(db,ticket,environment());expect(state.caps.get(ticket)!.used).toBe(true);const b=api.submitClaim(db,ticket,environment());await Promise.all([a,b]);expect(mutationCalls()).toHaveLength(1);expect(state.loads).toBe(1);expect(state.authCalls).toBe(1);
  });
  it.each(['copy','deserialize','forged','wrong-db'] as const)('%s has no auth or RPC authority',async kind=>{
    const other=kind==='copy'?{...ticket}:kind==='deserialize'?JSON.parse(JSON.stringify(ticket)):kind==='forged'?{command:original.command,token:id(72)}:ticket;
    expect(await api.submitClaim(kind==='wrong-db'?{} as IDBDatabase:db,other,environment())).toMatchObject({kind:'not_sent',reason:'send_capability_missing'});expect(state.loads).toBe(0);expect(state.calls).toEqual([]);
  });
  it.each(['rejected','wrong-owner','error'] as const)('auth %s consumes permission permanently',async kind=>{
    state.sessionReject=kind==='rejected';state.sessionOwner=kind==='wrong-owner'?id(99):null;state.sessionError=kind==='error';await api.submitClaim(db,ticket,environment());state.sessionReject=false;state.sessionOwner=null;state.sessionError=false;await api.submitClaim(db,ticket,environment());expect(state.authCalls).toBe(1);expect(state.calls).toEqual([]);
  });
  it.each(['load','session','snapshot','storage','bound-client'] as const)('checks owner/login ABA after %s boundary',async stage=>{
    const change=()=>{state.generation+=2;};if(stage==='load')state.loadHook=change;if(stage==='session')state.sessionHook=change;if(stage==='snapshot')state.rpcHook=name=>{if(name==='work_cross_job_snapshot')change();};if(stage==='storage')state.storageHook=change;if(stage==='bound-client')state.boundHook=change;
    await api.submitClaim(db,ticket,environment());expect(mutationCalls()).toEqual([]);expect(state.settlements).toEqual([]);expect(state.forfeits).toBeGreaterThan(0);
  });
  it.each(['selectedJobId','deviceId','preview','foreground','authorityToken'] as const)('rejects changed %s after auth without rewriting original',async field=>{
    const bytes=original.commandBytes;state.sessionHook=()=>{Object.assign(current,{[field]:field==='preview'?true:field==='foreground'?false:id(99)});};await api.submitClaim(db,ticket,environment());expect(mutationCalls()).toEqual([]);expect(original.commandBytes).toBe(bytes);
  });
  it('honors post-storage final admission refusal and clock exact keys',async()=>{
    state.ready=false;await api.submitClaim(db,ticket,environment());expect(mutationCalls()).toEqual([]);issue();state.ready=true;const env=environment();env.clock=()=>({...env.context.expected,elapsedMs:0,serverNow:original.anchor.asOf,snapshot:original.anchor});await api.submitClaim(db,ticket,env);expect(mutationCalls()).toEqual([]);
  });
  it('storage reread failure cannot dispatch and cannot restore the send right',async()=>{state.storageFail=true;await api.submitClaim(db,ticket,environment());state.storageFail=false;await api.submitClaim(db,ticket,environment());expect(mutationCalls()).toEqual([]);});
  it.each(['lost','malformed','23514','42501'] as const)('%s preserves uncertainty with no automatic retry',async kind=>{
    state.lost=kind==='lost';if(kind==='malformed')state.response={receipt:{}};if(kind==='23514'||kind==='42501')state.rpcError={code:kind};const first=await api.submitClaim(db,ticket,environment());expect(first.kind).toBe('unknown');await api.submitClaim(db,ticket,environment());expect(mutationCalls()).toHaveLength(1);expect(state.settlements).toEqual([{submission:null,lookup:null}]);
  });
  it('an actual refused command envelope is persisted separately from a transport SQL refusal',async()=>{state.response={protocolVersion:2,availability:'available',receipt:{...(state.response as {receipt:object}).receipt,status:'refused',reasonCode:'state_changed'}};expect((await api.submitClaim(db,ticket,environment())).kind).toBe('receipt');expect(state.settlements).toHaveLength(1);expect(mutationCalls()).toHaveLength(1);});
  it('late ABA discards the response without attaching another login to history',async()=>{state.rpcHook=name=>{if(name==='work_activity_command')state.generation+=2;};expect((await api.submitClaim(db,ticket,environment())).kind).toBe('unknown');expect(state.settlements).toEqual([]);});
  it.each(['offline','job','device','foreground','authority'] as const)('keeps received full-request provenance despite later %s',async kind=>{
    state.rpcHook=name=>{if(name!=='work_activity_command')return;if(kind==='offline')Object.defineProperty(navigator,'onLine',{value:false,configurable:true});else Object.assign(current,kind==='job'?{selectedJobId:id(99)}:kind==='device'?{deviceId:id(99)}:kind==='foreground'?{foreground:false}:{authorityToken:'changed'});};
    const result=await api.submitClaim(db,ticket,environment());expect(result.kind).toBe('receipt');expect(state.settlements[0]).toMatchObject({submission:{command:original.command,reply:state.response}});
  });
  it('unavailable lookup retains the actual submitted full request and receipt',async()=>{state.lookup={protocolVersion:2,availability:'unavailable',receipt:null,allocation:null};await api.submitClaim(db,ticket,environment());expect(state.settlements[0]).toEqual({submission:{command:original.command,reply:state.response},lookup:state.lookup});});
  it.each(['malformed','lost'] as const)('a %s lookup cannot erase the received full-request reply',async mode=>{if(mode==='malformed')state.lookup={bad:true};else state.rpcHook=name=>{if(name==='work_cross_job_receipt')throw Error('lookup lost');};const result=await api.submitClaim(db,ticket,environment());expect(result.kind).toBe('receipt');expect(state.settlements[0]).toEqual({submission:{command:original.command,reply:state.response},lookup:null});});
  it('auth ABA during persistence cannot publish history to the later login',async()=>{state.settleHook=()=>{state.generation+=2;};expect((await api.submitClaim(db,ticket,environment())).kind).toBe('unknown');expect(state.settlements).toEqual([]);await api.submitClaim(db,ticket,environment());expect(mutationCalls()).toHaveLength(1);});
  it('settlement quota failure after response never permits resend',async()=>{state.settleFail=true;expect(await api.submitClaim(db,ticket,environment())).toMatchObject({kind:'receipt',record:null});state.settleFail=false;await api.submitClaim(db,ticket,environment());expect(mutationCalls()).toHaveLength(1);});
  it('same UUID different job/cost cannot replace the private original or manufacture lookup provenance',async()=>{
    issue(handoff());const copy=structuredClone(ticket);copy.command.payload.intent={kind:'finish_setup',projectId:id(99),costCodeId:id(98)};await api.submitClaim(db,copy,environment());expect(mutationCalls()).toEqual([]);
    const view=await api.lookupReceipt(ticket.command.commandId);expect(view).toEqual(state.lookup);expect(state.settlements).toEqual([]);expect(state.caps.get(ticket)!.used).toBe(false);
    await api.submitClaim(db,ticket,environment());expect(mutationCalls()[0].args.p_payload).toEqual(original.command.payload);
  });
  it('fresh snapshots refuse offline, account change, wrong device and malformed shape',async()=>{
    const context=environment().context;Object.defineProperty(navigator,'onLine',{value:false,configurable:true});await expect(api.fetchSnapshot(id(2),context)).rejects.toThrow();expect(state.calls).toEqual([]);
    Object.defineProperty(navigator,'onLine',{value:true,configurable:true});state.rpcHook=()=>{state.generation+=2;};await expect(api.fetchSnapshot(id(2),context)).rejects.toThrow();state.generation=2;state.rpcHook=()=>{};await expect(api.fetchSnapshot(id(99),context)).rejects.toThrow();state.snapshot={bad:true};await expect(api.fetchSnapshot(id(2),context)).rejects.toThrow();
  });
  it.each([{preview:true},{foreground:false},{authorityToken:''}])('does not turn an invalid initial snapshot fence into a current read: %j',async patch=>{Object.assign(current,patch);await expect(api.fetchSnapshot(id(2),{expected:current,current:()=>current})).rejects.toThrow();expect(state.calls).toEqual([]);});
  it.each(['device','fences'] as const)('malformed %s produces the uniform unavailable read error without SDK/auth/RPC',async kind=>{
    const context=environment().context;if(kind==='fences')context.expected={...context.expected,unexpected:true} as typeof context.expected;
    await expect(api.fetchSnapshot(kind==='device'?'not-a-uuid':id(2),context)).rejects.toThrow('Cross-job information is unavailable. Refresh before changing work.');
    expect(state.loads).toBe(0);expect(state.authCalls).toBe(0);expect(state.calls).toEqual([]);
  });
  it('malformed receipt UUID returns null without SDK/auth/RPC',async()=>{expect(await api.lookupReceipt('not-a-uuid')).toBeNull();expect(state.loads).toBe(0);expect(state.authCalls).toBe(0);expect(state.calls).toEqual([]);});
  it('forfeits even when a property read throws immediately after consume before auth or settlement setup',async()=>{
    const env=environment();Object.defineProperty(env,'clock',{get(){throw Error('fixture clock property');}});
    expect(await api.submitClaim(db,ticket,env)).toMatchObject({kind:'not_sent',record:null});expect(state.forfeits).toBeGreaterThan(0);expect(state.authCalls).toBe(0);expect(state.calls).toEqual([]);
    expect(await api.submitClaim(db,ticket,environment())).toMatchObject({reason:'send_capability_missing'});
  });
  it('production entrypoints lazily load existing SDK exports and use the exact bound-token path',async()=>{
    expect(state.sdkImports).toBe(0);expect(await submitCrossJobClaimV3(db,{...ticket},environment())).toMatchObject({kind:'not_sent',reason:'send_capability_missing'});
    expect(state.sdkImports).toBe(0);expect(state.authCalls).toBe(0);expect(state.calls).toEqual([]);
    expect((await submitCrossJobClaimV3(db,ticket,environment())).kind).toBe('receipt');expect(state.sdkImports).toBe(1);expect(mutationCalls()[0].token).toBe('captured-token');
    expect(await fetchActivitySnapshotV3(id(2),environment().context)).toEqual(original.anchor);expect(state.sdkImports).toBe(1);expect(state.authCalls).toBe(2);
    expect(state.calls.map(x=>x.name)).toEqual(['work_cross_job_snapshot','work_activity_command','work_cross_job_receipt','work_cross_job_snapshot']);
  });
});
