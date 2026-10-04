import { describe, expect, it } from "vitest";
import { dimensionObservation, observationFromDraft, parseUnitFactSnapshot, UnitObservationUnavailableError } from "./model";
const UNIT="00000000-0000-4000-8000-000000000010", ACTOR="00000000-0000-4000-8000-000000000020";
const observation={width:1,height:2,unit:"ft",source:"measured",sourceReference:null,estimated:false};
const current={protocolVersion:1,unitId:UNIT,revision:1,eventKind:"observation",observation,widthIn:12,heightIn:24,observationActorId:ACTOR,recordedAt:"2026-10-04T00:00:00.123456+00:00"};
describe("unit dimension evidence",()=>{
  it("preserves original dimensions, sources and server-normalized inches",()=>{
    const parsed=parseUnitFactSnapshot(current,UNIT);
    expect(parsed.observation).toEqual(observation); expect(parsed.widthIn).toBe(12); expect(parsed.recordedAt).toBe(current.recordedAt);
  });
  it("distinguishes no recorded observation, legacy incomplete, reset and retained relink",()=>{
    expect(parseUnitFactSnapshot({protocolVersion:1,unitId:UNIT,revision:0,observation:null},UNIT).eventKind).toBeNull();
    for(const eventKind of ["incomplete","cleared","relink"]){
      const parsed=parseUnitFactSnapshot({...current,eventKind,observation:null,widthIn:null,heightIn:null,observationActorId:null},UNIT);
      expect(parsed.observation).toBeNull(); expect(parsed.eventKind).toBe(eventKind);
    }
    expect(parseUnitFactSnapshot({...current,eventKind:"legacy_observation",observation:null,observationActorId:null},UNIT).widthIn).toBe(12);
  });
  it("retains estimates without inventing verification",()=>{
    const parsed=parseUnitFactSnapshot({...current,observation:{...observation,source:"estimated",estimated:true}},UNIT);
    expect(parsed.observation?.estimated).toBe(true); expect(parsed).not.toHaveProperty("verified"); expect(parsed).not.toHaveProperty("qcAccepted");
  });
  it("binds exact unit, protocol, complete fields and safe revisions",()=>{
    for(const value of [null,{...current,unitId:ACTOR},{...current,protocolVersion:2},{...current,revision:Number.MAX_SAFE_INTEGER+1},{...current,revision:"1"},{...current,eventKind:"verified"},{...current,recordedAt:undefined},{...current,extra:true}])
      expect(()=>parseUnitFactSnapshot(value,UNIT)).toThrow(UnitObservationUnavailableError);
  });
  it("refuses contradictory observation/actor/converted dimensions",()=>{
    for(const changes of [{widthIn:13},{heightIn:0},{observationActorId:null},{eventKind:"cleared"},{observation:{...observation,estimated:true}},{observation:null},{observation:{...observation,extra:"x"}}])
      expect(()=>parseUnitFactSnapshot({...current,...changes},UNIT)).toThrow(UnitObservationUnavailableError);
  });
  it("never turns missing data or underflow into a zero measurement",()=>{
    expect(()=>parseUnitFactSnapshot({...current,observation:{...observation,width:0}},UNIT)).toThrow();
    expect(()=>parseUnitFactSnapshot({...current,revision:0},UNIT)).toThrow();
    expect(()=>parseUnitFactSnapshot({...current,eventKind:"legacy_observation",observation:null,observationActorId:null,widthIn:null},UNIT)).toThrow();
  });
  it("rejects accessor/prototype payloads without evaluating getters",()=>{
    let reads=0; const malformed={...current};Object.defineProperty(malformed,"revision",{get(){reads++;return 1;},enumerable:true});
    expect(()=>parseUnitFactSnapshot(malformed,UNIT)).toThrow();expect(reads).toBe(0);
    expect(()=>dimensionObservation(Object.create({width:2,height:3,unit:"in",source:"plans"}))).toThrow();
  });
  it("accepts 500 Unicode characters, trims reference and refuses malformed Unicode",()=>{
    const input={width:2,height:3,unit:"in",source:"plans",sourceReference:' '+"😀".repeat(500)+' '};
    expect(dimensionObservation(input).sourceReference).toBe("😀".repeat(500));
    for(const reference of ["😀".repeat(501),"\ud800","\udc00","a\u0000b","   "])
      expect(()=>dimensionObservation({...input,sourceReference:reference})).toThrow();
  });
  it("validates positive original dimensions and computed inch bounds for every unit",()=>{
    for(const unit of ["in","ft","mm","cm"])expect(dimensionObservation({width:2,height:3,unit,source:"measured"}).unit).toBe(unit);
    for(const width of [0,-1,NaN,Infinity,"2",null])expect(()=>dimensionObservation({width,height:2,unit:"in",source:"plans"})).toThrow();
    expect(()=>dimensionObservation({width:100000,height:2,unit:"ft",source:"plans"})).toThrow();
    expect(()=>dimensionObservation({width:2,height:3,unit:"m",source:"plans"})).toThrow();
  });
  it("draft parsing requires a deliberate source and decimal positive values",()=>{
    const draft={width:"1.5",height:".75",unit:"ft" as const,source:"plans" as const,reference:"Sheet A4"};
    expect(observationFromDraft(draft)).toEqual({width:1.5,height:.75,unit:"ft",source:"plans",sourceReference:"Sheet A4"});
    for(const width of ["","0","-2","0x10","1/2","1e2","2 inches"])expect(()=>observationFromDraft({...draft,width})).toThrow();
    expect(()=>observationFromDraft({...draft,source:""})).toThrow();
  });
});
