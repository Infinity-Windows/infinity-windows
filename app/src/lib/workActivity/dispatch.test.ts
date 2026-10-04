import { beforeEach,describe,expect,it,vi } from 'vitest';
import type { ActivityCommandRecord } from './journal';
import type { CommandAttempt } from './api';
const id=(n:number)=>`00000000-0000-0000-0000-${String(n).padStart(12,'0')}`;
const ME=id(1),DEVICE=id(2),COMMAND=id(3);
let generation=0;
let row:ActivityCommandRecord;
let events:string[];
let lookup:CommandAttempt,submit:CommandAttempt;
let block:string|null=null,saveFails=false,afterMark:(()=>void)|null=null,afterLookup:(()=>void)|null=null;
const terminal=()=>({protocolVersion:1 as const,commandId:COMMAND,status:'noop' as const,reasonCode:null,beforeRevision:0,afterRevision:0,transitionId:null,effectiveAt:null});
const unavailable:CommandAttempt={kind:'receipt',reply:{protocolVersion:1,availability:'unavailable',receipt:null}};
vi.mock('../signedIn',()=>({stillSignedInAs:(mark:{userId:string;generation:number},who:string)=>mark.userId===ME&&who===ME&&mark.generation===generation}));
vi.mock('./api',()=>({
  lookupActivityReceipt:async()=>{events.push('lookup');afterLookup?.();return lookup;},
  submitActivityCommand:async(command:string,payload:unknown)=>{events.push('send');expect(command).toBe(COMMAND);expect(payload).toEqual(row.payload);expect(row.uncertain).toBe(true);return submit;},
}));
vi.mock('./journal',()=>({
  getActivityCommand:async(owner:string,device:string,command:string)=>{events.push('read');expect([owner,device,command]).toEqual([ME,DEVICE,COMMAND]);return structuredClone(row);},
  getActivityDispatchReadiness:async()=>{events.push('ready');return block?{ready:false,reason:block}:{ready:true};},
  markActivityAttempt:async()=>{events.push('durable-attempt');if(saveFails)throw Error('native abort');row={...row,uncertain:!row.receipt};afterMark?.();return structuredClone(row);},
  recordActivityReceipt:async(_owner:string,_device:string,_command:string,payload:unknown,reply:{receipt:ActivityCommandRecord['receipt']})=>{events.push('durable-receipt');expect(payload).toEqual(row.payload);row={...row,uncertain:false,receipt:reply.receipt};return structuredClone(row);},
}));
const {dispatchSavedActivityCommand}=await import('./dispatch');
const mark=()=>({userId:ME,generation});
beforeEach(()=>{
  generation=0;events=[];block=null;saveFails=false;afterMark=null;afterLookup=null;
  lookup={kind:'unknown'};submit={kind:'receipt',reply:{protocolVersion:1,availability:'available',receipt:terminal()}};
  row={encodingVersion:2,commandId:COMMAND,ownerId:ME,uncertain:false,receipt:null,payload:{deviceId:DEVICE,clientGeneration:id(4),clientSequence:0,predecessorCommandId:null,expectedRevision:0,basis:{observationId:id(5)},shiftRef:null,tappedAt:'2026-10-04T00:00:00.123456Z',clockCheckedAt:null,clockSkewMs:null,intent:{kind:'establish_stream',previousGeneration:null,previousHeadCommandId:null}}};
});
describe('durable activity dispatcher',()=>{
  it('completes uncertainty save before any mutation and saves the returned receipt before settling',async()=>{
    expect(await dispatchSavedActivityCommand(DEVICE,COMMAND,mark())).toEqual({kind:'settled',receipt:terminal()});
    expect(events).toEqual(['read','ready','durable-attempt','send','durable-receipt']);expect(row.uncertain).toBe(false);
  });
  it('never sends when the native attempt transaction aborts',async()=>{
    saveFails=true;await expect(dispatchSavedActivityCommand(DEVICE,COMMAND,mark())).rejects.toThrow('native abort');expect(events).not.toContain('send');
  });
  it('recovers an immutable receipt first without replay, readiness, or source projection',async()=>{
    row.uncertain=true;lookup={kind:'receipt',reply:{protocolVersion:1,availability:'available',receipt:terminal()}};
    expect((await dispatchSavedActivityCommand(DEVICE,COMMAND,mark())).kind).toBe('settled');expect(events).toEqual(['read','lookup','durable-receipt']);
  });
  it('holds an unknown or unavailable earlier attempt without automatic replay',async()=>{
    row.uncertain=true;
    for(const result of [{kind:'unknown'} as CommandAttempt,unavailable,{kind:'attempt_refused',sqlState:'42501'} as CommandAttempt]){
      lookup=result;events=[];expect(await dispatchSavedActivityCommand(DEVICE,COMMAND,mark())).toEqual({kind:'held',reason:'receipt_unknown'});expect(events).toEqual(['read','lookup']);expect(row.uncertain).toBe(true);
    }
  });
  it('explicit original retry checks receipt then reuses the exact durable envelope',async()=>{
    row.uncertain=true;const original=structuredClone(row.payload);
    expect((await dispatchSavedActivityCommand(DEVICE,COMMAND,mark(),'retry_original')).kind).toBe('settled');
    expect(events).toEqual(['read','lookup','ready','durable-attempt','send','durable-receipt']);expect(row.payload).toEqual(original);
  });
  it('does not erase uncertainty after SQL attempt refusal or unavailable reply',async()=>{
    for(const result of [{kind:'attempt_refused',sqlState:'23514'} as CommandAttempt,unavailable]){
      row.uncertain=false;submit=result;events=[];expect((await dispatchSavedActivityCommand(DEVICE,COMMAND,mark())).kind).toBe('unknown');expect(row.uncertain).toBe(true);expect(events).not.toContain('durable-receipt');
    }
  });
  it('holds descendants and retired generations without marking or sending',async()=>{
    for(const reason of ['predecessor_unknown','needs_reaffirmation','retired_generation']){
      block=reason;events=[];expect(await dispatchSavedActivityCommand(DEVICE,COMMAND,mark())).toEqual({kind:'held',reason});expect(events).toEqual(['read','ready']);
    }
  });
  it('rejects old auth marks and same-person auth ABA before sending or applying a receipt',async()=>{
    const old=mark();generation+=2;expect(await dispatchSavedActivityCommand(DEVICE,COMMAND,old)).toEqual({kind:'held',reason:'authentication_changed'});expect(events).toEqual([]);
    afterMark=()=>{generation+=2;};expect((await dispatchSavedActivityCommand(DEVICE,COMMAND,mark())).kind).toBe('held');expect(events).not.toContain('send');
    events=[];row.uncertain=true;afterLookup=()=>{generation+=2;};lookup={kind:'receipt',reply:{protocolVersion:1,availability:'available',receipt:terminal()}};
    expect((await dispatchSavedActivityCommand(DEVICE,COMMAND,mark())).kind).toBe('held');expect(events).not.toContain('durable-receipt');
  });
  it('returns a concurrently settled local row without another send',async()=>{
    afterMark=()=>{row={...row,uncertain:false,receipt:terminal()};};expect((await dispatchSavedActivityCommand(DEVICE,COMMAND,mark())).kind).toBe('settled');expect(events).not.toContain('send');
  });
});
