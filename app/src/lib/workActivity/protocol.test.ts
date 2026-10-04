import { describe, expect, it } from 'vitest';
import { ActivityProtocolError, parsePayload, parseReceiptReply, parseSnapshot, parseUnitBasisReply, unitCommandBasis } from './protocol';
const id=(n:number)=>`00000000-0000-0000-0000-${String(n).padStart(12,'0')}`;
const at='2026-10-04T06:00:00.123456Z';
const receipt=()=>({protocolVersion:1,availability:'available',receipt:{protocolVersion:1,commandId:id(1),status:'applied',reasonCode:null,beforeRevision:0,afterRevision:1,transitionId:id(2),effectiveAt:at}});
const unit=()=>({id:id(3),projectId:id(4),openingId:id(5),operationalRevision:1,incarnationEpoch:0,bindingEpoch:2,projectEpoch:3,openingEpoch:4,fact:{id:id(6),revision:1,eventKind:'observation',originProjectEpoch:5,originOpeningEpoch:6,dimensions:{widthIn:12,heightIn:24,source:'measured',original:{width:1,height:2,unit:'ft',source:'measured',sourceReference:null}},estimated:false},eligibleForCapture:true,ineligibleReason:null});
const unitReply=()=>({protocolVersion:1,asOf:at,availability:'available',unit:unit()});
const payload=()=>({deviceId:id(7),clientGeneration:id(8),clientSequence:0,predecessorCommandId:null,expectedRevision:0,basis:{observationId:id(9)},shiftRef:null,tappedAt:'2026-10-04T00:00:00-06:00',clockCheckedAt:null,clockSkewMs:null,intent:{kind:'establish_stream',previousGeneration:null,previousHeadCommandId:null}});
const snapshot=()=>({protocolVersion:1,asOf:at,deviceId:id(7),capability:{mode:'active',reasonCode:null},observation:{id:id(9),revision:0,lastTransitionId:null,issuedAt:at,expiresAt:'2026-10-04T22:00:00.123456Z',shiftRef:null,currentGeneration:null,currentHeadCommandId:null},stream:null,state:{revision:0,lastTransitionId:null,integrity:'clean',status:'off_clock',choiceRequired:false,actions:{canEstablishStream:true,canSwitch:false,canFinishSetup:false,canStop:false},shift:null,activity:null}});
const reject=(fn:()=>unknown)=>expect(fn).toThrow(ActivityProtocolError);
describe('immutable receipt boundary',()=>{
  it('accepts exact authoritative applied receipt without needing a snapshot',()=>expect(parseReceiptReply(receipt(),id(1)).receipt?.afterRevision).toBe(1));
  it('accepts opaque unavailable without pretending settlement',()=>expect(parseReceiptReply({protocolVersion:1,availability:'unavailable',receipt:null},id(1)).availability).toBe('unavailable'));
  it.each(['commandId','protocolVersion','afterRevision','transitionId','effectiveAt'])('refuses invalid %s',key=>{
    const r=receipt();Object.assign(r.receipt,{[key]:key==='afterRevision'?0:key==='protocolVersion'?2:null});reject(()=>parseReceiptReply(r,id(1)));
  });
  it('refuses another command and an extra private payload',()=>{
    reject(()=>parseReceiptReply(receipt(),id(99)));const r=receipt();Object.assign(r.receipt,{normalizedPayload:{secret:'not allowed'}});reject(()=>parseReceiptReply(r,id(1)));
  });
  it('requires unchanged revisions, null boundaries and a reason for refusals',()=>{
    const r=receipt();Object.assign(r.receipt,{status:'refused',afterRevision:0,transitionId:null,effectiveAt:null});reject(()=>parseReceiptReply(r,id(1)));
    Object.assign(r.receipt,{reasonCode:'unit_changed'});expect(parseReceiptReply(r,id(1)).receipt?.status).toBe('refused');
  });
  it('does not truncate or coerce unsafe values',()=>{
    for(const changes of [{beforeRevision:'0'},{beforeRevision:Number.MAX_SAFE_INTEGER+1},{reasonCode:'x'.repeat(81)},{reasonCode:'bad\0code'},{reasonCode:'bad\ud800'}]){const r=receipt();Object.assign(r.receipt,changes);reject(()=>parseReceiptReply(r,id(1)));}
  });
});
describe('exact current and original unit basis',()=>{
  it('copies all independent ABA tokens from one authorized basis',()=>{
    const reply=parseUnitBasisReply(unitReply(),id(3));if(reply.availability!=='available')throw Error();
    expect(unitCommandBasis(reply.unit)).toEqual({id:id(3),operationalRevision:1,factId:id(6),factRevision:1,incarnationEpoch:0,bindingEpoch:2,projectEpoch:3,openingEpoch:4,originProjectEpoch:5,originOpeningEpoch:6});
  });
  it('allows estimates without creating a verification status',()=>{
    const r=unitReply();Object.assign(r.unit.fact,{estimated:true});r.unit.fact.dimensions.source='estimated';r.unit.fact.dimensions.original.source='estimated';
    expect(parseUnitBasisReply(r,id(3)).availability).toBe('available');Object.assign(r.unit.fact,{verified:true});reject(()=>parseUnitBasisReply(r,id(3)));
  });
  it('preserves recognized legacy inch evidence without inventing original inputs',()=>{
    const r=unitReply();Object.assign(r.unit.fact,{eventKind:'legacy_observation'});Object.assign(r.unit.fact.dimensions,{original:null});Object.assign(r.unit,{eligibleForCapture:false,ineligibleReason:'missing_observation'});expect(parseUnitBasisReply(r,id(3)).availability).toBe('available');
  });
  it.each(['projectEpoch','openingEpoch','bindingEpoch'])('refuses missing or wrongly typed %s',key=>{const r=unitReply();delete (r.unit as Record<string,unknown>)[key];reject(()=>parseUnitBasisReply(r,id(3)));});
  it('refuses mismatched ID, normalized units and estimate provenance',()=>{
    reject(()=>parseUnitBasisReply(unitReply(),id(10)));const r=unitReply();r.unit.fact.dimensions.widthIn=13;reject(()=>parseUnitBasisReply(r,id(3)));r.unit.fact.dimensions.widthIn=12;r.unit.fact.estimated=true;reject(()=>parseUnitBasisReply(r,id(3)));
  });
  it('keeps visible incomplete units available but unable to author a start',()=>{
    const r=unitReply();Object.assign(r.unit,{fact:null,eligibleForCapture:false,ineligibleReason:'missing_observation'});
    const reply=parseUnitBasisReply(r,id(3));expect(reply.availability).toBe('available');if(reply.availability==='available')reject(()=>unitCommandBasis(reply.unit));
  });
  it('rejects partial detail in a hidden-source reply',()=>reject(()=>parseUnitBasisReply({protocolVersion:1,asOf:at,availability:'unavailable',unit:{id:id(3)}},id(3))));
});
describe('server snapshot boundary',()=>{
  it('validates coherent own revision and observation',()=>expect(parseSnapshot(snapshot(),id(7)).state?.revision).toBe(0));
  it('accepts unavailable capability only with no private projection',()=>{
    const s=snapshot();Object.assign(s,{capability:{mode:'unavailable',reasonCode:'not_ready'},observation:null,state:null});expect(parseSnapshot(s,id(7)).capability.mode).toBe('unavailable');
    Object.assign(s,{state:snapshot().state});reject(()=>parseSnapshot(s,id(7)));
  });
  it('checks exact microseconds on lease positivity and sixteen-hour cap',()=>{
    const s=snapshot();s.observation.expiresAt='2026-10-04T06:00:00.123457Z';expect(parseSnapshot(s,id(7)).observation).not.toBeNull();
    s.observation.expiresAt='2026-10-04T22:00:00.123457Z';reject(()=>parseSnapshot(s,id(7)));
  });
  it('refuses stale revisions and inconsistent paired stream tokens',()=>{
    const s=snapshot();s.observation.revision=1;reject(()=>parseSnapshot(s,id(7)));s.observation.revision=0;Object.assign(s.observation,{currentGeneration:id(8)});reject(()=>parseSnapshot(s,id(7)));
  });
  it('rejects dates that Date.parse would silently normalize',()=>{
    const s=snapshot();s.asOf='2026-02-30T00:00:00.000000Z';reject(()=>parseSnapshot(s,id(7)));
  });
  it('rejects a hidden activity carrying its source or label',()=>{
    const s=snapshot();Object.assign(s.state,{status:'review',activity:{visibility:'unavailable',source:{kind:'custom',id:id(10)}}});reject(()=>parseSnapshot(s,id(7)));
  });
  it('rejects accessors without running them and clones returned objects',()=>{
    let read=0;const s=snapshot();Object.defineProperty(s,'state',{enumerable:true,get(){read++;return null;}});reject(()=>parseSnapshot(s,id(7)));expect(read).toBe(0);
    const source=snapshot(),copy=parseSnapshot(source,id(7));source.state.revision=10;expect(copy.state?.revision).toBe(0);
  });
});
describe('admitted command payload',()=>{
  it('accepts only establishment at sequence zero and preserves original tap evidence',()=>expect(parsePayload(payload()).tappedAt).toBe('2026-10-04T00:00:00-06:00'));
  it('rejects switch-at-zero, guessed shift refs, unknown or unsafe envelope keys',()=>{
    for(const changes of [{intent:{kind:'stop'}},{shiftRef:{kind:'outbox_row',id:id(1)}},{actorId:id(1)},{expectedRevision:'0'}])reject(()=>parsePayload({...payload(),...changes}));
  });
  it('requires a causal predecessor and exact unit basis for Specific',()=>{
    const intent={kind:'switch',projectId:id(4),selectionId:id(11),selectionRevision:1,menuVersionId:id(12),definitionVersionId:id(13),scope:'specific',unit:unitCommandBasis(unit()),machineKind:'spider_suction',values:{checked:false,count:0,comment:'😀'.repeat(500),selected:['first','second']}};
    const data={...payload(),clientSequence:1,predecessorCommandId:id(14),shiftRef:{kind:'clock_command',id:id(15)},intent};
    expect(parsePayload(data).intent.kind).toBe('switch');reject(()=>parsePayload({...data,intent:{...intent,unit:null}}));
    reject(()=>parsePayload({...data,predecessorCommandId:null}));reject(()=>parsePayload({...data,intent:{...intent,scope:'general',unit:null}}));
  });
  it('rejects too many, duplicated, null or oversized answers without truncating',()=>{
    const intent={kind:'switch',projectId:id(4),selectionId:id(11),selectionRevision:1,menuVersionId:id(12),definitionVersionId:id(13),scope:'general',unit:null,machineKind:null,values:{}};
    const data={...payload(),clientSequence:1,predecessorCommandId:id(14),shiftRef:{kind:'shift',id:id(15)},intent};
    for(const values of [{bad:null},{comment:'x'.repeat(501)},{select:['one','one']},Object.fromEntries(Array.from({length:41},(_,i)=>['field_'+i,true])),Object.fromEntries(Array.from({length:40},(_,i)=>['field_'+i,'😀'.repeat(500)]))])reject(()=>parsePayload({...data,intent:{...intent,values}}));
  });
});
