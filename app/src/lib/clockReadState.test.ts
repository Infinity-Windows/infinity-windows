import {describe,expect,it} from "vitest";
import {clockReadState,clockReadFingerprint,savedShiftIsPlausible} from "./clockReadState";
import {mergeClockQueue} from "./clockQueueView";
import type {TimeShift} from "./timeclock";
import type {OutboxEntry} from "./offline/outbox-core";
const now=new Date(2026,9,20,16,30).getTime();
const shift={id:"today",profile_id:"a",clock_in_at:new Date(now-3600000).toISOString(),clock_out_at:null,status:"open",break_seconds:0,break_started_at:null} as TimeShift;
const base={shift,profileId:"a",actorMatches:true,checking:false,verified:false,recentVerifiedNull:false,queueHasState:false,now};
describe("saved clock evidence",()=>{
 it("does not turn hydrated old success into today's running clock or finish form",()=>{const old={...shift,clock_in_at:"2026-09-11T12:36:39Z"};expect(clockReadState({...base,shift:old})).toMatchObject({recoveryRequired:true,status:"unavailable"});expect(clockReadState({...base,shift:old,checking:true})).toMatchObject({recoveryRequired:true,status:"checking"});});
 it("preserves explicit same-day saved clock controls offline",()=>expect(clockReadState(base)).toMatchObject({status:"saved",recoveryRequired:false}));
 it("a verified real old unresolved shift can ask for the actual finish",()=>expect(clockReadState({...base,shift:{...shift,status:"needs_finish"},verified:true})).toMatchObject({status:"verified",recoveryRequired:false}));
 it("unknown or persisted null is not an off-clock answer",()=>{for(const s of [null,undefined])expect(clockReadState({...base,shift:s}).recoveryRequired).toBe(true);expect(clockReadState({...base,shift:null,recentVerifiedNull:true}).recoveryRequired).toBe(false);});
 it("does not carry another person's cached state or a previous-day/over-cap start",()=>{expect(clockReadState({...base,actorMatches:false}).recoveryRequired).toBe(true);expect(clockReadState({...base,shift:{...shift,profile_id:"b"}}).recoveryRequired).toBe(true);for(const at of [now-17*3600000,now+1000,NaN])expect(savedShiftIsPlausible({...shift,clock_in_at:Number.isNaN(at)?"bad":new Date(at).toISOString()},now)).toBe(false);});
 it("only an applied clock-in or matching clock-out establishes queue state",()=>{const e=(op:OutboxEntry["op"],payload:Record<string,unknown>):OutboxEntry=>({id:op,op,payload,createdAt:1,status:"queued",attemptCount:0,lastError:null,nextAttemptAt:0,dependsOn:null,hasBlob:false,ownerId:"a"});let applied=0;const opts={profileId:"a",onStateApplied:()=>applied++};mergeClockQueue(shift,[e("clock_out",{shiftRef:"unrelated"}),e("break_start",{shiftRef:shift.id})],opts);expect(applied).toBe(0);mergeClockQueue(shift,[e("clock_out",{shiftRef:shift.id})],opts);expect(applied).toBe(1);expect(clockReadState({...base,shift:null,queueHasState:true}).recoveryRequired).toBe(false);});
 it("does not treat a cache edit to a different shift as the verified row",()=>expect(clockReadFingerprint(shift)).not.toBe(clockReadFingerprint({...shift,id:"other"})));
});
