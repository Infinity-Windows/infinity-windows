import { describe, expect, it } from 'vitest';
import { ActivityProtocolError, parsePayload, parseReceiptReply, parseSnapshot } from './protocol';
import { freezeV2, parsePayloadV2, parseCommandReplyV2, parseReceiptReplyV2, parseSnapshotV2 } from './protocolV2';
import { predictAllocation } from './allocationPredecessor';
import { id, snapshot, payload, lookup } from './protocolV2.fixtures';
const reply=()=>lookup(predictAllocation({protocol:2,ownerId:id(1),commandId:id(6),payload:payload()},'applied'));
const commandReply=()=>{const {allocation:_,...command}=reply();return command;};
const reject=(f:()=>unknown)=>expect(f).toThrow(ActivityProtocolError);
describe('K6 exact v2 wire shapes, independently held from v1',()=>{
  it('accepts all three actual envelopes without inventing a command allocation',()=>{
    expect(parsePayloadV2(payload())).toEqual(payload());expect(parseCommandReplyV2(commandReply(),id(6))).toEqual(commandReply());expect(parseReceiptReplyV2(reply(),id(6))).toEqual(reply());expect(parseSnapshotV2(snapshot(),id(2))).toEqual(snapshot());
    reject(()=>parseCommandReplyV2(reply(),id(6)));reject(()=>parseReceiptReplyV2(commandReply(),id(6)));
  });
  it('mutually refuses protocol versions and payload extra allocation fields',()=>{
    reject(()=>parsePayload(payload()));const {expectedAllocationId:_,boundaryMode:__,...old}=payload();reject(()=>parsePayloadV2(old));
    reject(()=>parseReceiptReply(commandReply(),id(6)));reject(()=>parseCommandReplyV2({...commandReply(),protocolVersion:1},id(6)));
    reject(()=>parseSnapshot(snapshot(),id(2)));reject(()=>parseSnapshotV2({...snapshot(),protocolVersion:1},id(2)));
    reject(()=>parseCommandReplyV2({...commandReply(),receipt:{...commandReply().receipt!,protocolVersion:1}},id(6)));
  });
  it('preserves both unavailable snapshot envelopes and null lookup',()=>{
    const minimal={protocolVersion:2,availability:'unavailable',state:null};expect(parseSnapshotV2(minimal,id(2))).toEqual(minimal);
    const full={...snapshot(),capability:{mode:'unavailable',reasonCode:'not_ready'},observation:null,stream:null,state:null};expect(parseSnapshotV2(full,id(2))).toEqual(full);
    expect(parseReceiptReplyV2({protocolVersion:2,availability:'unavailable',receipt:null,allocation:null},id(6)).receipt).toBeNull();
    reject(()=>parseSnapshotV2({...minimal,asOf:snapshot().asOf},id(2)));reject(()=>parseSnapshotV2({...full,state:snapshot().state},id(2)));
    reject(()=>parseReceiptReplyV2({protocolVersion:2,availability:'unavailable',receipt:null,allocation:reply().allocation},id(6)));
  });
  it('keeps a hidden source opaque and allocation job distinct from paid job',()=>{
    const s=snapshot();s.state!.status='review';s.state!.activity={visibility:'unavailable'};s.state!.shift!.allocationId=id(66);s.state!.shift!.project={visibility:'unavailable',id:null,name:null,jobCode:null};expect(parseSnapshotV2(s,id(2))).toEqual(s);
    reject(()=>parseSnapshotV2({...s,state:{...s.state,activity:{visibility:'unavailable',source:{kind:'custom',id:id(8)}}}},id(2)));
  });
  it.each(Object.keys(payload()))('refuses missing or additional payload key near %s',key=>{const p={...payload()} as Record<string,unknown>;delete p[key];reject(()=>parsePayloadV2(p));reject(()=>parsePayloadV2({...payload(),[key+'Extra']:null}));});
  it.each([{boundaryMode:'arrival'},{boundaryMode:null},{expectedAllocationId:0},{expectedRevision:'1'},{expectedRevision:Number.MAX_SAFE_INTEGER+1},{clientSequence:Infinity},{clockSkewMs:NaN},{clockSkewMs:0.5},{clockSkewMs:2147483648},{tappedAt:'2026-02-30T00:00:00Z'},{shiftRef:{kind:'guessed',id:id(7)}},{intent:{kind:'unknown'}}])('rejects malformed payload %j',patch=>reject(()=>parsePayloadV2({...payload(),...patch})));
  it('rejects missing state allocation, misplaced allocation and unknown state modes',()=>{
    const s=snapshot(),shift={...s.state!.shift!} as Record<string,unknown>;delete shift.allocationId;
    reject(()=>parseSnapshotV2({...s,state:{...s.state,shift}},id(2)));reject(()=>parseSnapshotV2({...s,allocationId:null},id(2)));
    reject(()=>parseSnapshotV2({...s,capability:{mode:'offline',reasonCode:null}},id(2)));reject(()=>parseSnapshotV2(s,id(99)));
  });
  it.each(['id','predecessorId','boundaryMode','originalTappedAt','effectiveAt','shiftId','transitionId'])('requires exact allocation %s',key=>{const r=reply(),a={...r.allocation!} as Record<string,unknown>;delete a[key];reject(()=>parseReceiptReplyV2({...r,allocation:a},id(6)));});
  it('refuses mismatched allocation/transition, unsafe revision, invalid status and malformed times',()=>{
    for(const patch of [{id:id(99)},{transitionId:id(99)},{boundaryMode:'fallback'},{effectiveAt:'2026-10-05T06:00:00.123455Z'},{originalTappedAt:'2026-02-30T00:00:00.000000Z'}])reject(()=>parseReceiptReplyV2({...reply(),allocation:{...reply().allocation,...patch}},id(6)));
    for(const patch of [{status:'pending'},{reasonCode:'unexpected'},{beforeRevision:Number.MAX_SAFE_INTEGER+1},{afterRevision:1},{effectiveAt:null}])reject(()=>parseCommandReplyV2({...commandReply(),receipt:{...commandReply().receipt!,...patch}},id(6)));
  });
  it('rejects accessors without calling them, sparse arrays, extras, nonfinite and cycles',()=>{
    let calls=0;const p=payload();Object.defineProperty(p,'intent',{enumerable:true,get(){calls++;return null;}});reject(()=>parsePayloadV2(p));expect(calls).toBe(0);
    const sparse=Array(1);Object.assign(sparse,{extra:'x'});reject(()=>freezeV2(sparse));reject(()=>freezeV2(Array(1)));reject(()=>freezeV2(Infinity));const loop:unknown[]=[];loop.push(loop);reject(()=>freezeV2(loop));
    const original=payload(),copy=parsePayloadV2(original);original.expectedRevision=99;expect(copy.expectedRevision).toBe(1);expect(Object.isFrozen(copy.intent)).toBe(true);
  });
});
