import { beforeEach, describe, expect, it, vi } from 'vitest';
const id=(n:number)=>`00000000-0000-0000-0000-${String(n).padStart(12,'0')}`;
const ME=id(1),OTHER=id(2),DEVICE=id(3),COMMAND=id(4),at='2026-10-04T06:00:00.000001Z';
let user:string|null=ME,sessionUser:string|null=ME,generation=0;
let afterSession:(()=>void)|null=null,afterRpc:(()=>void)|null=null,error:unknown=null,response:unknown,throwRpc=false;
const calls:{token:string;name:string;args:unknown}[]=[];
vi.mock('../supabase',()=>({supabase:{auth:{getSession:async()=>{const session=sessionUser?{access_token:`token-${sessionUser}`,user:{id:sessionUser}}:null;afterSession?.();return{data:{session},error:null};}}},clientWithToken:(token:string)=>({rpc:async(name:string,args:unknown)=>{calls.push({token,name,args});afterRpc?.();if(throwRpc)throw Error('network');return{data:response,error};}})}));
vi.mock('../signedIn',()=>({signInMark:()=>({userId:user,generation}),stillSignedInAs:(mark:{userId:string|null;generation:number},who:string)=>mark.userId===who&&mark.generation===generation&&user===who}));
const {fetchActivitySnapshot,fetchActivityUnitBasis,submitActivityCommand,lookupActivityReceipt}=await import('./api');
const login=()=>({userId:user,generation});
const payload=()=>({deviceId:DEVICE,clientGeneration:id(5),clientSequence:0,predecessorCommandId:null,expectedRevision:0,basis:{observationId:id(6)},shiftRef:null,tappedAt:at,clockCheckedAt:null,clockSkewMs:null,intent:{kind:'establish_stream' as const,previousGeneration:null,previousHeadCommandId:null}});
const receipt=()=>({protocolVersion:1,availability:'available',receipt:{protocolVersion:1,commandId:COMMAND,status:'noop',reasonCode:null,beforeRevision:0,afterRevision:0,transitionId:null,effectiveAt:null}});
beforeEach(()=>{user=ME;sessionUser=ME;generation=0;afterSession=null;afterRpc=null;error=null;calls.length=0;throwRpc=false;response=receipt();});
describe('auth-bound immutable activity transport',()=>{
  it('uses the checked exact token, original UUID and eleven-field envelope',async()=>{
    const data=payload();const result=await submitActivityCommand(COMMAND,data,login());expect(result.kind).toBe('receipt');expect(calls).toEqual([{token:`token-${ME}`,name:'work_activity_command',args:{p_command_id:COMMAND,p_protocol_version:1,p_payload:data}}]);
  });
  it('clones the caller payload before its first await',async()=>{
    const data=payload();afterSession=()=>{data.expectedRevision=10;};await submitActivityCommand(COMMAND,data,login());expect((calls[0].args as {p_payload:{expectedRevision:number}}).p_payload.expectedRevision).toBe(0);
  });
  it('refuses malformed payload before dispatch',async()=>{await expect(submitActivityCommand(COMMAND,{...payload(),deviceId:'opaque'},login())).rejects.toThrow();expect(calls).toHaveLength(0);});
  it('holds absent/different session owners without using the global client',async()=>{
    for(const who of [null,OTHER]){sessionUser=who;expect(await submitActivityCommand(COMMAND,payload(),login())).toEqual({kind:'unknown'});}expect(calls).toHaveLength(0);
  });
  it('blocks old auth-generation and ABA before the send',async()=>{
    const mark=login();generation+=2;expect(await submitActivityCommand(COMMAND,payload(),mark)).toEqual({kind:'unknown'});generation=0;afterSession=()=>{generation+=2;};expect(await submitActivityCommand(COMMAND,payload(),login())).toEqual({kind:'unknown'});expect(calls).toHaveLength(0);
  });
  it('discards a late immutable receipt after logout and same-user reentry',async()=>{afterRpc=()=>{generation+=2;};expect(await submitActivityCommand(COMMAND,payload(),login())).toEqual({kind:'unknown'});});
  it('keeps SQL refusal separate from a durable outcome',async()=>{
    for(const code of ['23514','42501']){error={code,message:'not a trusted reason'};expect(await submitActivityCommand(COMMAND,payload(),login())).toEqual({kind:'attempt_refused',sqlState:code});}
    error={code:'40P01'};expect(await submitActivityCommand(COMMAND,payload(),login())).toEqual({kind:'unknown'});
  });
  it('keeps unavailable and invalid response uncertainty, not confirmation',async()=>{
    response={protocolVersion:1,availability:'unavailable',receipt:null};expect(await submitActivityCommand(COMMAND,payload(),login())).toEqual({kind:'receipt',reply:response});
    response={...receipt(),receipt:{...receipt().receipt,commandId:OTHER}};expect(await submitActivityCommand(COMMAND,payload(),login())).toEqual({kind:'unknown'});
    throwRpc=true;expect(await submitActivityCommand(COMMAND,payload(),login())).toEqual({kind:'unknown'});
  });
  it('reconciles receipt independently of source snapshots',async()=>{expect((await lookupActivityReceipt(COMMAND,login())).kind).toBe('receipt');expect(calls[0].name).toBe('work_activity_command_receipt');expect(calls[0].args).toEqual({p_command_id:COMMAND});});
  it('fetches own snapshot and exact selected-unit basis without company/source enumeration',async()=>{
    response={protocolVersion:1,asOf:at,deviceId:DEVICE,capability:{mode:'unavailable',reasonCode:'not_ready'},observation:null,stream:null,state:null};expect((await fetchActivitySnapshot(DEVICE)).capability.mode).toBe('unavailable');
    response={protocolVersion:1,asOf:at,availability:'unavailable',unit:null};expect((await fetchActivityUnitBasis(id(7))).availability).toBe('unavailable');expect(calls.map(x=>[x.name,x.args])).toEqual([['work_activity_snapshot',{p_device_id:DEVICE}],['work_activity_unit_basis',{p_unit_id:id(7)}]]);
  });
  it('does not reuse read projections after account changes or malformed results',async()=>{
    afterRpc=()=>{generation+=2;};await expect(fetchActivitySnapshot(DEVICE)).rejects.toThrow('information is unavailable');generation=0;await expect(fetchActivityUnitBasis(id(7))).rejects.toThrow();
  });
});
