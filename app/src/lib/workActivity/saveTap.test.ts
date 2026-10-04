import { beforeEach, describe, expect, it, vi } from 'vitest';
import { rememberSignedIn, signInMark } from '../signedIn';
import { ActivityJournalUnavailableError } from './journal';
import { saveActivityTap } from './saveTap';
import type { Snapshot } from './protocol';
const read=vi.fn(),append=vi.fn(),stamp=vi.fn();
vi.mock('./journal',async original=>({...await original<typeof import('./journal')>(),getCurrentActivityCommand:(...args:unknown[])=>read(...args),appendActivityCommand:(...args:unknown[])=>append(...args)}));
vi.mock('../clockSkew',()=>({clockTrustStamp:()=>stamp()}));
const id=(n:number)=>`00000000-0000-0000-0000-${String(n).padStart(12,'0')}`,at='2026-10-04T06:00:00.000000Z';
function source(){const value:Snapshot={protocolVersion:1,asOf:at,deviceId:id(2),capability:{mode:'active',reasonCode:null},observation:{id:id(4),revision:0,lastTransitionId:null,issuedAt:at,expiresAt:'2026-10-04T22:00:00.000000Z',shiftRef:null,currentGeneration:null,currentHeadCommandId:null},stream:null,state:{revision:0,lastTransitionId:null,integrity:'clean',status:'off_clock',choiceRequired:false,actions:{canEstablishStream:true,canSwitch:false,canFinishSetup:false,canStop:false},shift:null,activity:null}};return {value,requestStartedAt:performance.now(),login:signInMark()};}
beforeEach(()=>{rememberSignedIn({user:{id:id(1)}});read.mockReset().mockResolvedValue(null);append.mockReset().mockImplementation(async row=>({...row,encodingVersion:2,uncertain:false,receipt:null}));stamp.mockReset().mockReturnValue({tappedAt:'2026-10-04T00:00:00-06:00',clockCheckedAt:null,clockSkewMs:null});});
describe('original tap save boundary',()=>{
  it('freezes the original tap before awaiting storage and awaits the durable append',async()=>{
    let release!:(v:null)=>void;read.mockImplementationOnce(()=>new Promise<null>(resolve=>{release=resolve;}));
    const pending=saveActivityTap(id(2),source(),{kind:'establish_stream'});expect(stamp).toHaveBeenCalledOnce();expect(append).not.toHaveBeenCalled();
    stamp.mockReturnValue({tappedAt:'2026-10-04T09:00:00Z',clockCheckedAt:null,clockSkewMs:null});release(null);
    const result=await pending;expect(result.kind).toBe('saved');if(result.kind!=='saved')throw Error();
    expect(result.record.payload.tappedAt).toBe('2026-10-04T00:00:00-06:00');expect(Object.keys(append.mock.calls[0][0]).sort()).toEqual(['commandId','ownerId','payload']);
  });
  it('refuses a prior read generation after same-owner authentication ABA before storage',async()=>{
    const old=source();rememberSignedIn(null);rememberSignedIn({user:{id:id(1)}});
    expect(await saveActivityTap(id(2),old,{kind:'establish_stream'})).toEqual({kind:'held',reason:'authentication_changed'});expect(read).not.toHaveBeenCalled();expect(append).not.toHaveBeenCalled();
  });
  it('does not append after authentication changes while reading the durable head',async()=>{
    read.mockImplementationOnce(async()=>{rememberSignedIn(null);rememberSignedIn({user:{id:id(1)}});return null;});
    expect(await saveActivityTap(id(2),source(),{kind:'establish_stream'})).toEqual({kind:'held',reason:'authentication_changed'});expect(append).not.toHaveBeenCalled();
  });
  it('retains an already saved owner request but reports no current success after auth changes on commit',async()=>{
    append.mockImplementationOnce(async row=>{rememberSignedIn(null);return {...row,encodingVersion:2,uncertain:false,receipt:null};});
    expect(await saveActivityTap(id(2),source(),{kind:'establish_stream'})).toEqual({kind:'held',reason:'authentication_changed'});expect(append).toHaveBeenCalledOnce();
  });
  it('reports unavailable storage and an expired lease without attempting any dispatch',async()=>{
    read.mockRejectedValueOnce(new ActivityJournalUnavailableError());expect(await saveActivityTap(id(2),source(),{kind:'establish_stream'})).toEqual({kind:'unavailable',reason:'storage'});
    const expired=source();expired.requestStartedAt-=17*60*60*1000;expect(await saveActivityTap(id(2),expired,{kind:'establish_stream'})).toEqual({kind:'held',reason:'expired_observation'});expect(append).not.toHaveBeenCalled();
  });
});
