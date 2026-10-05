import { describe, expect, it } from 'vitest';
import { confirmAllocation, predictAllocation, predecessorPosition } from './allocationPredecessor';
import { at, id, payload, lookup, head, submission } from './protocolV2.fixtures';
const predicted=(kind:'switch'|'finish_setup'|'stop'|'establish_stream'='switch',status:'applied'|'noop'='applied')=>{
  const p=payload();p.expectedAllocationId=id(30);
  if(kind==='finish_setup')p.intent={kind,projectId:id(10),costCodeId:null};
  if(kind==='stop')p.intent={kind};
  if(kind==='establish_stream'){p.clientSequence=0;p.predecessorCommandId=null;p.intent={kind,previousGeneration:id(31),previousHeadCommandId:id(32)};}
  return predictAllocation({protocol:2,ownerId:id(1),commandId:id(6),payload:p},status);
};
describe('pure confirmed versus predicted allocation lineage',()=>{
  it.each(['switch','finish_setup'] as const)('%s predicts one revision and own command allocation, then requires actual exact lookup',kind=>{
    const p=predicted(kind),bytes=JSON.stringify(p);expect(p.prediction).toEqual({sequence:1,afterRevision:2,allocationId:id(6),status:'applied'});expect(predecessorPosition(p).status).toBe('pending');
    expect(confirmAllocation(p,lookup(p),submission(p)).confirmation.kind).toBe('confirmed');expect(JSON.stringify(p)).toBe(bytes);
  });
  it.each(['applied','noop'] as const)('stop %s inherits allocation, never creates an ID',status=>{
    const p=predicted('stop',status);expect(p.prediction).toMatchObject({allocationId:id(30),afterRevision:status==='applied'?2:1});expect(lookup(p).allocation).toBeNull();expect(confirmAllocation(p,lookup(p),submission(p)).confirmation.kind).toBe('confirmed');
  });
  it('establishment noop preserves revision and allocation; no synthetic transition',()=>{
    const p=predicted('establish_stream','noop');expect(confirmAllocation(p,lookup(p),submission(p)).confirmation.kind).toBe('confirmed');expect(p.prediction).toMatchObject({afterRevision:1,allocationId:id(30)});expect(()=>predicted('establish_stream','applied')).toThrow();expect(()=>predicted('switch','noop')).toThrow();
  });
  it('requires skew-corrected effective time, preserving the original timestamp bytes',()=>{
    const p=predicted();const q=predictAllocation({...p.command,payload:{...p.command.payload,clockSkewMs:1000}},'applied');
    const receipt=lookup(q);expect(receipt.allocation!.originalTappedAt).toBe(at);expect(receipt.allocation!.effectiveAt).toBe('2026-10-05T05:59:59.123456Z');expect(confirmAllocation(q,receipt,submission(q)).confirmation.kind).toBe('confirmed');expect(q.command.payload.tappedAt).toBe(at);
    expect(confirmAllocation(q,{...receipt,allocation:{...receipt.allocation!,originalTappedAt:'2026-10-05T05:59:59.123456Z'}}).confirmation).toEqual({kind:'held',reason:'prediction_mismatch'});
  });
  it.each(['unknown','unavailable','refused','conflict'] as const)('%s is a permanent hold preserving command bytes',outcome=>{
    const p=predicted(),r=lookup(p);let raw:unknown=outcome==='unknown'?null:outcome==='unavailable'?{protocolVersion:2,availability:'unavailable',receipt:null,allocation:null}:r;
    if(outcome==='refused'||outcome==='conflict')raw={...r,receipt:{...r.receipt!,status:outcome,reasonCode:'state_changed',afterRevision:1,effectiveAt:null,transitionId:null},allocation:null};
    const held=confirmAllocation(p,raw);expect(held.confirmation).toEqual({kind:'held',reason:outcome==='unknown'||outcome==='unavailable'?'parent_unknown':`parent_${outcome}`});expect(JSON.stringify(held.command)).toBe(JSON.stringify(p.command));expect(confirmAllocation(held,r)).toEqual(held);
  });
  it.each(['revision','allocation','predecessor','shift','transition','time','command','missingAllocation','unexpectedAllocation'] as const)('holds %s mismatch without modifying original evidence',field=>{
    const p=predicted(field==='unexpectedAllocation'?'stop':'switch'),r=lookup(p),a=r.allocation;
    const bad=structuredClone(r);
    if(field==='revision'){bad.receipt!.beforeRevision=2;bad.receipt!.afterRevision=3;}
    else if(field==='command')bad.receipt!.commandId=id(88);
    else if(field==='missingAllocation')bad.allocation=null;
    else if(field==='unexpectedAllocation')bad.allocation=lookup(predicted()).allocation;
    else if(a&&bad.allocation)Object.assign(bad.allocation,field==='allocation'?{id:id(88)}:field==='predecessor'?{predecessorId:id(88)}:field==='shift'?{shiftId:id(88)}:field==='transition'?{transitionId:id(88)}:{effectiveAt:'2026-10-05T06:00:00.123455Z'});
    expect(confirmAllocation(p,bad).confirmation).toEqual({kind:'held',reason:'prediction_mismatch'});
  });
  it.each(['project','costCode'] as const)('cannot distinguish reused ID/different %s from lookup alone; requires exact submitted original',field=>{
    const p=predicted(field==='project'?'switch':'finish_setup'),intent=p.command.payload.intent;
    const other=predictAllocation({...p.command,payload:{...p.command.payload,intent:field==='project'?{...intent,projectId:id(99)} as typeof intent:{kind:'finish_setup',projectId:id(10),costCodeId:id(99)}}},'applied');
    // This equality is the backend's missing lookup intent binding, not a mock
    // field omission: the exact SQL allocation envelope has no job/cost code.
    expect(lookup(other)).toEqual(lookup(p));
    const bytes=JSON.stringify(p.command);
    expect(confirmAllocation(p,lookup(other)).confirmation).toEqual({kind:'held',reason:'intent_unproven'});
    expect(confirmAllocation(p,lookup(other),submission(other)).confirmation).toEqual({kind:'held',reason:'intent_unproven'});
    expect(confirmAllocation(p,lookup(p),submission(p)).confirmation.kind).toBe('confirmed');expect(JSON.stringify(p.command)).toBe(bytes);
  });
  it('requires an available matching submission receipt, retains its exact original, and never revives missing provenance',()=>{
    const p=predicted(),proof=submission(p),r=lookup(p);
    expect(confirmAllocation(p,r,{...proof,reply:{protocolVersion:2,availability:'unavailable',receipt:null}}).confirmation).toEqual({kind:'held',reason:'intent_unproven'});
    const wrong={...proof,reply:{...proof.reply,availability:'available' as const,receipt:{...r.receipt!,transitionId:id(99)}}};
    expect(confirmAllocation(p,r,wrong).confirmation).toEqual({kind:'held',reason:'intent_unproven'});
    const held=confirmAllocation(p,r);expect(confirmAllocation(held,r,proof)).toEqual(held);
    const confirmed=confirmAllocation(p,r,proof);expect(predecessorPosition(confirmed).status).toBe('confirmed');
    if(confirmed.confirmation.kind!=='confirmed')throw Error();expect(JSON.stringify(confirmed.confirmation.submission.command)).toBe(JSON.stringify(p.command));
  });
  it('settled v1 is a distinct predecessor with a bound payload revision',()=>{
    expect(predecessorPosition(head())).toMatchObject({status:'confirmed',afterRevision:1,allocationId:null});
    const h=head();h.payload.expectedRevision=0;expect(()=>predecessorPosition(h)).toThrow();
    const refused=head();refused.receipt.status='refused';refused.receipt.reasonCode='state_changed';expect(()=>predecessorPosition(refused)).toThrow();
  });
  it('refuses forged prediction arithmetic, duplicate allocation data on noop, and changed confirmations',()=>{
    const p=predicted();expect(()=>predecessorPosition({...p,prediction:{...p.prediction,afterRevision:9}})).toThrow();
    const stop=predicted('stop','noop');expect(confirmAllocation(stop,{...lookup(stop),allocation:lookup(p).allocation}).confirmation.kind).toBe('held');
    const done=confirmAllocation(p,lookup(p),submission(p));expect(confirmAllocation(done,null).confirmation).toEqual({kind:'held',reason:'parent_unknown'});
  });
});
