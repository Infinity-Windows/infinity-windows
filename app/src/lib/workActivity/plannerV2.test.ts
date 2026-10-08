import { describe, expect, it } from 'vitest';
import { planActivityV2, checkV2SendPrerequisites, type PlanV2 } from './plannerV2';
import { confirmAllocation } from './allocationPredecessor';
import { id, at, original, snapshot, head, fences, lookup, snapshotAfter, submission } from './protocolV2.fixtures';
const input=()=>({original:original(),snapshot:snapshot(),sourceFences:fences(),currentFences:fences(),elapsedMs:0,serverNow:at,chain:[head()]});
const planned=(p:PlanV2)=>{if(p.kind==='held')throw Error(p.reason);return p;};
const check=(p:PlanV2,patch:Partial<Parameters<typeof checkV2SendPrerequisites>[1]>={})=>checkV2SendPrerequisites(p,{parents:p.kind==='held'?[]:p.parents,currentFences:fences(),snapshot:snapshot(),elapsedMs:0,serverNow:at,...patch});
function chain(){
  const a=planned(planActivityV2(input()));
  const b=planned(planActivityV2({...input(),original:original(16,20),sourceFences:fences(20),currentFences:fences(20),chain:[head(),a.command]}));
  const c=planned(planActivityV2({...input(),original:original(26,30),sourceFences:fences(30),currentFences:fences(30),chain:[head(),a.command,b.command]}));return {a,b,c};
}
describe('dormant v2 source and lineage prerequisites',()=>{
  it('authors only an exact registered physical shift and retains original bytes',()=>{
    const i=input(),before=JSON.stringify(i),p=planned(planActivityV2(i));expect(JSON.stringify(i)).toBe(before);expect(JSON.stringify(p.original)).toBe(JSON.stringify(i.original));
    expect(p.command.command.payload).toMatchObject({clientSequence:1,predecessorCommandId:id(5),expectedRevision:1,expectedAllocationId:null,boundaryMode:'trusted_original_tap',shiftRef:{kind:'shift',id:id(7)},tappedAt:i.original.stamp.tappedAt});expect(check(p).kind).toBe('ready');
  });
  it('preserves original A→B→C across three jobs and waits for exact actual parent receipts',()=>{
    const {a,b,c}=chain(),bytes=JSON.stringify(c.command.command);expect(a.kind).toBe('ready');expect(b.kind).toBe('descendant');expect(c.kind).toBe('descendant');
    expect(b.command.command.payload).toMatchObject({predecessorCommandId:id(6),expectedRevision:2,expectedAllocationId:id(6),clientSequence:2});
    expect(c.command.command.payload).toMatchObject({predecessorCommandId:id(16),expectedRevision:3,expectedAllocationId:id(16),clientSequence:3});
    expect(check(c,{currentFences:fences(30)}).kind).toBe('descendant');
    const ac=confirmAllocation(a.command,lookup(a.command),submission(a.command)),bc=confirmAllocation(b.command,lookup(b.command),submission(b.command));
    const ready=check(c,{parents:[head(),ac,bc],currentFences:fences(30),snapshot:snapshotAfter(bc)});expect(ready.kind).toBe('ready');if(ready.kind==='held')throw Error();expect(JSON.stringify(ready.command.command)).toBe(bytes);expect(ready.original).toEqual(original(26,30));
  });
  it.each(['unknown','refused','conflict'] as const)('holds descendants after %s parent forever without new IDs or stream',outcome=>{
    const {a,b,c}=chain();let raw:unknown=null;if(outcome!=='unknown'){const r=lookup(a.command);raw={...r,receipt:{...r.receipt!,status:outcome,reasonCode:'state_changed',afterRevision:1,transitionId:null,effectiveAt:null},allocation:null};}
    const ancestor=confirmAllocation(a.command,raw),held=check(c,{parents:[head(),ancestor,b.command],currentFences:fences(30)});expect(held).toMatchObject({kind:'held',permanent:true,reason:'ancestor_held',original:c.original});
    if(held.kind!=='held')throw Error();expect(JSON.stringify(held.retained!.command.command)).toBe(JSON.stringify(c.command.command));
    expect(check(held,{parents:[head(),confirmAllocation(a.command,lookup(a.command),submission(a.command)),confirmAllocation(b.command,lookup(b.command),submission(b.command))],currentFences:fences(30),snapshot:snapshotAfter(b.command)})).toBe(held);
  });
  it('never readies the original again after confirmed or unknown outcome and rejects changed original bindings',()=>{
    const p=planned(planActivityV2(input()));
    for(const command of [confirmAllocation(p.command,lookup(p.command),submission(p.command)),confirmAllocation(p.command,null)])expect(check({...p,command})).toMatchObject({kind:'held',reason:'original_already_observed'});
    const changed={...p,command:{...p.command,command:{...p.command.command,payload:{...p.command.command.payload,tappedAt:'2026-10-05T06:00:00.000000Z'}}}};
    expect(check(changed)).toMatchObject({kind:'held',reason:'needs_reaffirmation'});
  });
  it('expires original observations permanently and requires a future deliberate tap',()=>{
    const p=planned(planActivityV2(input())),held=check(p,{elapsedMs:10000,serverNow:'2026-10-05T06:00:10.123456Z'});expect(held).toMatchObject({kind:'held',reason:'expired_observation',original:p.original});expect(check(held)).toBe(held);
    const s=snapshot();s.asOf='2026-10-05T06:00:11.123456Z';s.observation!.issuedAt=s.asOf;s.observation!.expiresAt='2026-10-05T06:00:21.123456Z';s.observation!.id=id(40);
    const i=input();i.snapshot=s;i.serverNow=s.asOf;i.original.commandId=id(41);i.original.stamp={tappedAt:s.asOf,clockCheckedAt:s.asOf,clockSkewMs:0};expect(planActivityV2(i).kind).toBe('ready');
  });
  it.each([{clockCheckedAt:null,clockSkewMs:null},{clockSkewMs:120001},{clockCheckedAt:'2026-10-03T06:00:00.123456Z'},{tappedAt:'2026-10-05T06:00:01.123456Z'}])('retains untrusted original intent instead of stamping it %j',patch=>{
    const i=input();Object.assign(i.original.stamp,patch);const bytes=JSON.stringify(i.original),p=planActivityV2(i);expect(p.kind).toBe('held');expect(JSON.stringify(p.original)).toBe(bytes);if(p.kind==='held')expect(p.retained).toBeNull();
  });
  it.each([{userId:null},{userId:id(99)},{loginGeneration:3},{deviceId:id(99)},{preview:true},{foreground:false},{selectedJobId:id(99)},{authorityToken:'changed'}])('fences context %j at creation and immediately before send',patch=>{
    const i=input(),p=planned(planActivityV2(i));Object.assign(i.currentFences,patch);expect(planActivityV2(i).kind).toBe('held');expect(check(p,{currentFences:i.currentFences}).kind).toBe('held');
  });
  it.each(['head','generation','revision','allocation','physicalShift','blocked'] as const)('never rebases after fresh %s mismatch',change=>{
    const p=planned(planActivityV2(input())),s=snapshot();
    if(change==='head'){s.stream!.headCommandId=id(99);s.observation!.currentHeadCommandId=id(99);}
    if(change==='generation'){s.stream!.clientGeneration=id(99);s.observation!.currentGeneration=id(99);}
    if(change==='revision'){s.state!.revision=2;s.observation!.revision=2;}
    if(change==='allocation')s.state!.shift!.allocationId=id(99);
    if(change==='physicalShift'){s.state!.shift!.id=id(99);s.observation!.shiftRef!.id=id(99);}
    if(change==='blocked')s.stream!.status='blocked';
    const held=check(p,{snapshot:s});expect(held.kind).toBe('held');if(held.kind!=='held')throw Error();expect(held.retained!.command.command).toEqual(p.command.command);
  });
  it('holds starts when capability, source action or break context changes',()=>{
    const p=planned(planActivityV2(input()));for(const change of ['capability','action','break']){const s=snapshot();if(change==='capability'){s.capability={mode:'closing_only',reasonCode:'starts_disabled'};s.state!.actions.canSwitch=false;}if(change==='action')s.state!.actions.canSwitch=false;if(change==='break'){s.state!.status='on_break';s.state!.shift!.breakStartedAt=at;s.state!.shift!.breakType='rest';}expect(check(p,{snapshot:s}).kind).toBe('held');}
  });
  it('finish_setup creates allocation while stop inherits it and tolerates expired observation',()=>{
    const i=input();i.snapshot.state!.status='setup';i.snapshot.state!.activity={visibility:'available',source:{kind:'setup',id:id(70)},startedAt:at,project:{visibility:'unassigned',id:null,name:null,jobCode:null},capture:null,unit:null};i.snapshot.state!.actions.canSwitch=false;i.snapshot.state!.actions.canFinishSetup=true;i.original.action={kind:'finish_setup',projectId:id(10),costCodeId:null};
    const finish=planned(planActivityV2(i));expect(finish.command.prediction.allocationId).toBe(id(6));
    const {a}=chain(),ac=confirmAllocation(a.command,lookup(a.command),submission(a.command)),s=snapshotAfter(ac);
    const stop=planned(planActivityV2({...input(),snapshot:s,chain:[ac],original:{...original(16),action:{kind:'stop'}},elapsedMs:20000,serverNow:'2026-10-05T06:00:20.123456Z'}));expect(stop.command.prediction.allocationId).toBe(id(6));expect(stop.command.command.payload.expectedAllocationId).toBe(id(6));
  });
  it('establishment is new deliberate stream evidence, never a reassigned old descendant',()=>{
    const i=input();i.original.action={kind:'establish_stream',newGeneration:id(80)};const p=planned(planActivityV2(i));expect(p.command.prediction.status).toBe('noop');expect(p.command.command.payload.intent).toEqual({kind:'establish_stream',previousGeneration:id(3),previousHeadCommandId:id(5)});expect(p.parents).toEqual([]);expect(check(p,{parents:[]}).kind).toBe('ready');
    const s=snapshot();s.stream!.headCommandId=id(81);s.observation!.currentHeadCommandId=id(81);expect(check(p,{parents:[],snapshot:s}).kind).toBe('held');
    i.original.commandId=id(5);expect(planActivityV2(i)).toMatchObject({kind:'held',reason:'needs_reaffirmation'});
  });
  it('holds malformed stamp injection and original times preceding known shift/activity boundaries',()=>{
    const i=input();Object.assign(i.original.stamp,{shiftRef:{kind:'clock_command',id:id(99)}});expect(planActivityV2(i)).toMatchObject({kind:'held',reason:'malformed',original:i.original});
    const old=input();old.original.stamp.tappedAt='2026-10-05T04:59:59.999999Z';expect(planActivityV2(old)).toMatchObject({kind:'held',reason:'untrusted_stamp'});
    const {a}=chain(),later={...a.command,command:{...a.command.command,payload:{...a.command.command.payload,tappedAt:'2026-10-05T06:00:00.123457Z'}}};
    expect(planActivityV2({...input(),original:original(16),chain:[head(),later]})).toMatchObject({kind:'held',reason:'untrusted_stamp'});
  });
  it('refuses missing scope, wrong v1 owner or physical shift, missing parents and unsafe elapsed time',()=>{
    const unavailable={protocolVersion:2,availability:'unavailable',state:null};expect(planActivityV2({...input(),snapshot:unavailable}).kind).toBe('held');
    for(const patch of [{ownerId:id(99)},{payload:{...head().payload,shiftRef:{kind:'shift' as const,id:id(99)}}}])expect(planActivityV2({...input(),chain:[{...head(),...patch}]}).kind).toBe('held');
    expect(planActivityV2({...input(),chain:[]}).kind).toBe('held');for(const elapsedMs of [-1,NaN,Infinity])expect(planActivityV2({...input(),elapsedMs}).kind).toBe('held');
  });
});
