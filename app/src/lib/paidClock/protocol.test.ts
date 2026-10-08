import { describe, expect, it } from "vitest";
import { clockSqlCall, parseClockIntent, parseClockReceiptRead, type ClockIntent } from "./protocol";

const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,"0")}`;
const CLIENT=id(1),SHIFT=id(2),PROJECT=id(3),COST=id(4),OTHER=id(5);
const evidence={clientId:CLIENT,tappedAt:"2026-10-04T08:30:00.123456-06:00",clockCheckedAt:"2026-10-04T08:29:59.999999-06:00",clockSkewMs:0};
const clockIn=()=>({action:"clock_in",...evidence,projectId:PROJECT,costCodeId:COST,photo:null,lat:40.7,lng:-111.9,note:"Start",mode:"tracking",setupVersion:1});
const breakStart=()=>({action:"break_start",...evidence,shiftRef:{kind:"clock_command",id:CLIENT},breakType:"lunch"});
const breakEnd=()=>({action:"break_end",...evidence,shiftRef:{kind:"shift",id:SHIFT}});
const clockOut=()=>({action:"clock_out",...evidence,shiftRef:{kind:"shift",id:SHIFT},photo:null,injured:false,timeConfirmed:false,breakSeconds:0,lat:null,lng:null,injuryNote:null});
const receipt=(action:ClockIntent["action"],outcome="clocked_in")=>({protocolVersion:1,availability:"available",receipt:{
  clientId:CLIENT,action,outcome,shiftId:SHIFT,tappedAt:"2026-10-04T14:30:00.123456Z",arrivedAt:"2026-10-04T14:30:01.000001Z",
  clockCheckedAt:"2026-10-04T14:29:59.999999Z",clockSkewMs:0,usedTapTime:true,reviewReason:null,
  receiptProtocol:"setup_v1",retention:"retained",sourcePresent:true,activityTransition:{id:id(6),beforeRevision:4,afterRevision:5},
}});
const parse=(raw:unknown)=>parseClockIntent(raw);

describe("isolated paid clock protocol",()=>{
  it("retains every original SQL argument, explicit null and false, with no fallback",()=>{
    const start=clockSqlCall(parse(clockIn()));
    expect(start.rpc).toBe("clock_in");expect(Object.keys(start.args)).toHaveLength(12);
    expect(start.args).toEqual({p_project_id:PROJECT,p_cost_code_id:COST,p_photo:null,p_lat:40.7,p_lng:-111.9,p_note:"Start",p_mode:"tracking",
      p_client_id:CLIENT,p_tapped_at:evidence.tappedAt,p_clock_checked_at:evidence.clockCheckedAt,p_clock_skew_ms:0,p_setup_version:1});
    expect(clockSqlCall(parse(breakStart()),SHIFT)).toEqual({rpc:"start_break",args:{p_shift_id:SHIFT,p_break_type:"lunch",p_client_id:CLIENT,p_tapped_at:evidence.tappedAt,p_clock_checked_at:evidence.clockCheckedAt,p_clock_skew_ms:0}});
    expect(clockSqlCall(parse(breakEnd()))).toEqual({rpc:"end_break",args:{p_shift_id:SHIFT,p_client_id:CLIENT,p_tapped_at:evidence.tappedAt,p_clock_checked_at:evidence.clockCheckedAt,p_clock_skew_ms:0}});
    const out=clockSqlCall(parse(clockOut()));expect(out.rpc).toBe("clock_out");expect(Object.keys(out.args)).toHaveLength(12);
    expect(out.args).toMatchObject({p_injured:false,p_time_confirmed:false,p_break_seconds:0,p_lat:null,p_lng:null,p_injury_note:null});
  });
  it("requires setup_v1 and retains nullable check/skew and payroll text without made-up length cap",()=>{
    const input={...clockIn(),projectId:null,costCodeId:null,photo:"photo-path",note:"a".repeat(4000),mode:null,lat:null,lng:null,clockCheckedAt:null,clockSkewMs:null};
    const intent=parse(input);expect(intent).toMatchObject({setupVersion:1,clockCheckedAt:null,clockSkewMs:null,note:input.note});
    expect(()=>parse({...input,setupVersion:null})).toThrow();
    expect(()=>parse({...input,setupVersion:0})).toThrow();
    expect(()=>parse({...input,mode:"other"})).toThrow();
  });
  it("rejects unknown keys, getters, cycles, mutable input mutation, and malformed quantities",()=>{
    const source=clockIn();const intent=parse(source);source.note="Changed";expect(intent.action==="clock_in"&&intent.note).toBe("Start");
    expect(Object.isFrozen(intent)).toBe(true);expect(()=>parse({...clockIn(),ownerId:id(7)})).toThrow();
    const getter=Object.defineProperty(clockIn(),"note",{enumerable:true,get(){throw Error("getter ran");}});
    expect(()=>parse(getter)).toThrow();
    const cycle={...clockIn(),self:null as unknown};cycle.self=cycle;expect(()=>parse(cycle)).toThrow();
    for(const bad of [{...clockIn(),lat:Infinity},{...clockIn(),lat:91},{...clockIn(),lng:-181},{...clockIn(),clockSkewMs:2147483648},{...clockOut(),breakSeconds:-1},{...clockOut(),breakSeconds:1.5},{...clockOut(),injured:"false"},{...breakStart(),breakType:"meal"}]) expect(()=>parse(bad)).toThrow();
  });
  it("requires exact shift-command resolution and never guesses an open shift",()=>{
    const intent=parse(breakStart());expect(()=>clockSqlCall(intent)).toThrow();expect(()=>clockSqlCall(intent,OTHER)).not.toThrow();
    expect(()=>clockSqlCall(parse(breakEnd()),OTHER)).toThrow();
    expect(()=>parseClockReceiptRead(receipt("break_start","started"),intent)).toThrow();
    expect(()=>parseClockReceiptRead(receipt("break_start","started"),intent,OTHER)).toThrow();
    expect(parseClockReceiptRead(receipt("break_start","started"),intent,SHIFT).availability).toBe("available");
  });
  it("compares original evidence at PostgreSQL microseconds without rewriting stored strings",()=>{
    const intent=parse(clockIn());const equal=receipt("clock_in");
    expect(parseClockReceiptRead(equal,intent)).toMatchObject({availability:"available",receipt:{tappedAt:"2026-10-04T14:30:00.123456Z"}});
    expect(clockSqlCall(intent).args.p_tapped_at).toBe(evidence.tappedAt);
    for(const changed of [
      {...equal,receipt:{...equal.receipt,tappedAt:"2026-10-04T14:30:00.123457Z"}},
      {...equal,receipt:{...equal.receipt,clockCheckedAt:"2026-10-04T14:29:59.999998Z"}},
      {...equal,receipt:{...equal.receipt,clockSkewMs:1}},
      {...equal,receipt:{...equal.receipt,clientId:OTHER}},
    ]) expect(()=>parseClockReceiptRead(changed,intent)).toThrow();
    expect(()=>parse({...clockIn(),tappedAt:"2026-02-31T08:30:00Z"})).toThrow();
    expect(()=>parse({...clockIn(),tappedAt:"2026-10-04T08:30:00.1234567Z"})).toThrow();
  });
  it("validates action/outcome pairs and setup protocol before acknowledging",()=>{
    expect(()=>parseClockReceiptRead(receipt("clock_out","clocked_out"),parse(clockIn()))).toThrow();
    expect(()=>parseClockReceiptRead(receipt("clock_in","requires_review"),parse(clockIn()))).toThrow();
    expect(()=>parseClockReceiptRead({...receipt("clock_in"),receipt:{...receipt("clock_in").receipt,receiptProtocol:"legacy"}},parse(clockIn()))).toThrow();
    for(const [action,outcome,input] of [["clock_out","requires_review",clockOut()],["break_start","already_on_break",{...breakStart(),shiftRef:{kind:"shift",id:SHIFT}}],["break_end","no_break_running",breakEnd()],["break_end","shift_closed",breakEnd()]] as const){
      expect(parseClockReceiptRead(receipt(action,outcome),parse(input)).availability).toBe("available");
    }
    expect(()=>parseClockReceiptRead(receipt("break_end","started"),parse(breakEnd()))).toThrow();
  });
  it("keeps source-removed, legacy retention and transition metadata as exact evidence",()=>{
    const raw=receipt("clock_in");const value={...raw,receipt:{...raw.receipt,sourcePresent:false,retention:"legacy",activityTransition:null}};
    const parsed=parseClockReceiptRead(value,parse(clockIn()));
    expect(parsed).toMatchObject({receipt:{sourcePresent:false,retention:"legacy",activityTransition:null}});
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(parseClockReceiptRead({protocolVersion:1,availability:"unavailable",receipt:null},parse(clockIn()))).toEqual({protocolVersion:1,availability:"unavailable",receipt:null});
  });
  it("requires each non-null activity transition to advance exactly one safe revision",()=>{
    const raw=receipt("clock_in");
    const boundary={...raw,receipt:{...raw.receipt,activityTransition:{id:id(6),beforeRevision:Number.MAX_SAFE_INTEGER-1,afterRevision:Number.MAX_SAFE_INTEGER}}};
    expect(parseClockReceiptRead(boundary,parse(clockIn()))).toMatchObject({receipt:{activityTransition:boundary.receipt.activityTransition}});
    for(const pair of [[4,4],[4,3],[4,6],[Number.MAX_SAFE_INTEGER,Number.MAX_SAFE_INTEGER+1]]) {
      const changed={...raw,receipt:{...raw.receipt,activityTransition:{id:id(6),beforeRevision:pair[0],afterRevision:pair[1]}}};
      expect(()=>parseClockReceiptRead(changed,parse(clockIn()))).toThrow();
    }
    expect(parseClockReceiptRead({...raw,receipt:{...raw.receipt,activityTransition:null}},parse(clockIn()))).toMatchObject({receipt:{activityTransition:null}});
  });
  it("refuses extra/missing receipt fields, accessors, invalid types and unsupported historical evidence",()=>{
    const raw=receipt("clock_in");
    for(const bad of [{...raw,shiftId:SHIFT},{...raw,receipt:{...raw.receipt,sourcePresent:"false"}},{...raw,receipt:{...raw.receipt,activityTransition:{id:id(6),beforeRevision:-1,afterRevision:5}}},{...raw,receipt:{...raw.receipt,arrivedAt:"2026-02-31T00:00:00Z"}}]) expect(()=>parseClockReceiptRead(bad,parse(clockIn()))).toThrow();
    const missing={...raw,receipt:{...raw.receipt}} as {receipt:Record<string,unknown>};delete missing.receipt.sourcePresent;
    expect(()=>parseClockReceiptRead(missing,parse(clockIn()))).toThrow();
    const accessor=Object.defineProperty({...raw},"receipt",{enumerable:true,get(){throw Error("getter ran");}});
    expect(()=>parseClockReceiptRead(accessor,parse(clockIn()))).toThrow();
    expect(()=>parseClockReceiptRead({protocolVersion:1,availability:"unavailable",receipt:{shiftId:SHIFT}},parse(clockIn()))).toThrow();
  });
});
