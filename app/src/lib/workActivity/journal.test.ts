import { beforeEach, describe, expect, it, vi } from 'vitest';
import { appendActivityCommand, markActivityAttempt, recordActivityReceipt, ActivityJournalUnavailableError } from './journal';
const id=(n:number)=>`00000000-0000-0000-0000-${String(n).padStart(12,'0')}`;
const payload=()=>({deviceId:id(2),clientGeneration:id(3),clientSequence:0,predecessorCommandId:null,expectedRevision:0,basis:{observationId:id(4)},shiftRef:null,tappedAt:'2026-10-04T00:00:00.000001Z',clockCheckedAt:null,clockSkewMs:null,intent:{kind:'establish_stream' as const,previousGeneration:null,previousHeadCommandId:null}});
const input=()=>({ownerId:id(1),commandId:id(5),payload:payload()});
const open=vi.fn();const factory={open} as unknown as IDBFactory;
beforeEach(()=>{open.mockReset();open.mockImplementation(()=>{throw Error('No storage');});});
describe('protocol journal input and storage boundary',()=>{
  it('requires real native persistence and has no pretend fallback',async()=>{
    await expect(appendActivityCommand(input(),{factory})).rejects.toBeInstanceOf(ActivityJournalUnavailableError);expect(open).toHaveBeenCalledOnce();
  });
  it.each(['ownerId','commandId'])('rejects invalid %s before native storage',async key=>{
    await expect(appendActivityCommand({...input(),[key]:'opaque'},{factory})).rejects.toThrow();expect(open).not.toHaveBeenCalled();
  });
  it('rejects unsupported opaque encoding and credential-like unknown fields',async()=>{
    for(const change of [{encodingVersion:1},{access_token:'synthetic-not-a-secret'},{payload:{...payload(),basis:'old opaque evidence'}}])await expect(appendActivityCommand({...input(),...change} as never,{factory})).rejects.toThrow();expect(open).not.toHaveBeenCalled();
  });
  it('does not execute a custom serializer or accessor',async()=>{
    const invoke=vi.fn();for(const value of [{...input(),toJSON:invoke},Object.defineProperty(input(),'payload',{enumerable:true,get:invoke})])await expect(appendActivityCommand(value,{factory})).rejects.toThrow();expect(invoke).not.toHaveBeenCalled();expect(open).not.toHaveBeenCalled();
  });
  it('refuses invalid receipt binding before opening persistence',async()=>{
    await expect(recordActivityReceipt(id(1),id(2),id(5),payload(),{protocolVersion:1,availability:'available',receipt:{protocolVersion:1,commandId:id(9),status:'noop',reasonCode:null,beforeRevision:0,afterRevision:0,transitionId:null,effectiveAt:null}},{factory})).rejects.toThrow();expect(open).not.toHaveBeenCalled();
  });
  it('attempt bookkeeping also requires a valid complete submitted envelope',async()=>{
    await expect(markActivityAttempt(id(1),id(2),id(5),{...payload(),clientSequence:1},{factory})).rejects.toThrow();expect(open).not.toHaveBeenCalled();
  });
});
