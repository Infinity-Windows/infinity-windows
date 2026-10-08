import { describe, expect, it } from 'vitest';
import { planActivityCommand } from './planner';
import type { ActivityCommandRecord } from './journal';
import type { Snapshot } from './protocol';
const id=(n:number)=>`00000000-0000-0000-0000-${String(n).padStart(12,'0')}`;
const at='2026-10-04T06:00:00.123456Z';
function snapshot():Snapshot{return {protocolVersion:1,asOf:at,deviceId:id(2),capability:{mode:'active',reasonCode:null},
  observation:{id:id(4),revision:1,lastTransitionId:id(9),issuedAt:at,expiresAt:'2026-10-04T06:00:10.123456Z',shiftRef:{kind:'shift',id:id(7)},currentGeneration:id(3),currentHeadCommandId:id(5)},
  stream:{clientGeneration:id(3),headSequence:0,headCommandId:id(5),headAfterRevision:1,status:'active'},
  state:{revision:1,lastTransitionId:id(9),integrity:'clean',status:'unclassified',choiceRequired:true,
    actions:{canEstablishStream:true,canSwitch:true,canFinishSetup:false,canStop:true},
    shift:{id:id(7),clockInCommandId:id(8),clockInAt:at,breakStartedAt:null,breakType:null,status:'open',project:{visibility:'available',id:id(10),name:'Job',jobCode:null}},activity:null}};}
function head():ActivityCommandRecord{return {encodingVersion:2,commandId:id(5),ownerId:id(1),uncertain:false,
  payload:{deviceId:id(2),clientGeneration:id(3),clientSequence:0,predecessorCommandId:null,expectedRevision:0,basis:{observationId:id(20)},shiftRef:{kind:'shift',id:id(7)},tappedAt:at,clockCheckedAt:null,clockSkewMs:null,intent:{kind:'establish_stream',previousGeneration:null,previousHeadCommandId:null}},
  receipt:{protocolVersion:1,commandId:id(5),status:'applied',reasonCode:null,beforeRevision:0,afterRevision:1,transitionId:id(9),effectiveAt:at}};}
const input=()=>({ownerId:id(1),deviceId:id(2),commandId:id(6),snapshot:snapshot(),elapsedMs:100,head:head(),action:{kind:'stop' as const},stamp:{tappedAt:'2026-10-04T00:00:00-06:00',clockCheckedAt:null,clockSkewMs:null}});
describe('fresh tap planning',()=>{
  it('copies exact causal tokens and original clock evidence without mutating inputs',()=>{
    const source=input(),original=JSON.stringify(source),plan=planActivityCommand(source);expect(JSON.stringify(source)).toBe(original);
    expect(plan.kind).toBe('ready');if(plan.kind!=='ready')throw Error();
    expect(plan.payload).toMatchObject({clientGeneration:id(3),clientSequence:1,predecessorCommandId:id(5),expectedRevision:1,basis:{observationId:id(4)},shiftRef:{kind:'shift',id:id(7)},tappedAt:'2026-10-04T00:00:00-06:00'});
  });
  it('uses monotonic RPC elapsed time at exact microsecond expiry, not the device tap clock',()=>{
    const source=input();source.snapshot.observation!.expiresAt='2026-10-04T06:00:00.123457Z';source.elapsedMs=0;
    expect(planActivityCommand(source).kind).toBe('ready');source.elapsedMs=.001;expect(planActivityCommand(source)).toEqual({kind:'held',reason:'expired_observation'});
    for(const elapsedMs of [-1,NaN,Infinity])expect(planActivityCommand({...input(),elapsedMs})).toEqual({kind:'held',reason:'expired_observation'});
  });
  it('holds unknown local outcomes even when a server state looks compatible',()=>{
    const source=input();source.head.receipt=null;source.head.uncertain=true;
    expect(planActivityCommand(source)).toEqual({kind:'held',reason:'predecessor_unknown'});
    expect(planActivityCommand({...input(),head:null})).toEqual({kind:'held',reason:'needs_reaffirmation'});
  });
  it('holds a stream after an independent payroll or correction revision without rebasing it',()=>{
    const source=input();source.snapshot.state!.revision=2;source.snapshot.observation!.revision=2;
    expect(planActivityCommand(source)).toEqual({kind:'held',reason:'needs_reaffirmation'});expect(source.head.payload.expectedRevision).toBe(0);
  });
  it('binds explicit reaffirmation to the exact server old head while retaining uncertain local evidence',()=>{
    const source=input();source.head.receipt=null;source.head.uncertain=true;const before=JSON.stringify(source.head);
    const result=planActivityCommand({...source,action:{kind:'establish_stream',newGeneration:id(30)}});
    expect(result.kind).toBe('ready');if(result.kind!=='ready')throw Error();
    expect(result.payload).toMatchObject({clientGeneration:id(30),clientSequence:0,predecessorCommandId:null,intent:{kind:'establish_stream',previousGeneration:id(3),previousHeadCommandId:id(5)}});
    expect(JSON.stringify(source.head)).toBe(before);
    expect(planActivityCommand({...source,action:{kind:'establish_stream',newGeneration:id(3)}})).toEqual({kind:'held',reason:'needs_reaffirmation'});
  });
  it('refuses mismatched owner, remote head, blocked stream and exhausted sequence',()=>{
    const foreign=input();foreign.head.ownerId=id(99);expect(planActivityCommand(foreign)).toEqual({kind:'held',reason:'needs_reaffirmation'});
    for(const patch of [{headCommandId:id(99)},{status:'blocked' as const},{headSequence:Number.MAX_SAFE_INTEGER}]){
      const source=input();Object.assign(source.snapshot.stream!,patch);
      source.snapshot.observation!.currentHeadCommandId=source.snapshot.stream!.headCommandId;
      expect(planActivityCommand(source)).toEqual({kind:'held',reason:'needs_reaffirmation'});
    }
  });
  it('preserves close-only stop access and holds starts when capability or integrity disallows them',()=>{
    const source=input();source.snapshot.capability={mode:'closing_only',reasonCode:'starts_disabled'};source.snapshot.state!.actions.canSwitch=false;
    expect(planActivityCommand(source).kind).toBe('ready');source.snapshot.state!.actions.canStop=false;
    expect(planActivityCommand(source)).toEqual({kind:'held',reason:'action_unavailable'});
    const establish=input();establish.snapshot.state!.actions.canEstablishStream=false;
    expect(planActivityCommand({...establish,action:{kind:'establish_stream',newGeneration:id(30)}})).toEqual({kind:'held',reason:'action_unavailable'});
  });
  it('has no capture authority in an unavailable projection and never invents a pending clock reference',()=>{
    const source=input();source.snapshot={protocolVersion:1,asOf:at,deviceId:id(2),capability:{mode:'unavailable',reasonCode:'not_ready'},state:null,observation:null,stream:null};
    expect(planActivityCommand(source)).toEqual({kind:'held',reason:'unavailable'});
    const off=input();off.snapshot.state!.status='off_clock';off.snapshot.state!.shift=null;off.snapshot.observation!.shiftRef=null;
    expect(planActivityCommand(off)).toEqual({kind:'held',reason:'needs_reaffirmation'});
  });
});
