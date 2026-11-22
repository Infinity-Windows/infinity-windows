import type {TimeShift} from "../../lib/timeclock";

import type {ActivityRow} from "./activityRows";

type Span = [number, number];

function union(spans:Span[]) { let total=0,end=-Infinity; for(const [a,b] of spans.sort((x,y)=>x[0]-y[0])) {total+=Math.max(0,b-Math.max(a,end));end=Math.max(end,b);} return total/1000; }

export function timecardCoverage(shifts:TimeShift[], timers:ActivityRow[], from:number, until:number) {

 const cards=shifts.filter(s=>s.status!=="voided" && s.status!=="needs_finish" && !!s.clock_out_at).map(shift=>{

  const start=Math.max(from,Date.parse(shift.clock_in_at)),end=Math.min(until,Date.parse(shift.clock_out_at!));

  const gross=Math.max(0,(end-start)/1000), breaks=Math.max(0,shift.break_seconds||0);

  return {shift,start,end,gross,breaks,matches:[] as {timer:ActivityRow;span:Span}[],links:[] as ActivityRow[],candidates:[] as {timer:ActivityRow;span:Span}[],ambiguous:[] as string[]};

 }).filter(c=>Number.isFinite(c.gross)&&c.gross>0);

 const issues:{timer:ActivityRow;reason:string}[]=[];

 for(const timer of [...new Map(timers.map(t=>[`${t.sourceTable}:${t.id}`,t])).values()]) {

  const start=Math.max(from,Date.parse(timer.started)),end=Math.min(until,Date.parse(timer.ended));

  const direct=timer.shiftId?cards.find(c=>c.shift.id===timer.shiftId):undefined;
  if(direct)direct.links.push(timer);
  if(timer.shiftId&&(!direct||direct.shift.profile_id!==timer.personId||direct.shift.project_id!==timer.jobId)){
   issues.push({timer,reason:direct?"Explicit timecard link conflicts with timer account or job":"Explicit timecard is outside the loaded closed records; not reassigned"});continue;
  }
  let reason=timer.reviewReason;

  if(!reason && (!timer.personId || !timer.jobId)) reason="Missing person or job link";

  if(!reason && (timer.sourceTable==="opening_phases" || !Number.isFinite(start+end) || end<=start || Math.abs((end-start)/1000-timer.seconds)>2)) reason="Duration cannot be located precisely within its timestamp window";

  if(reason) {issues.push({timer,reason});continue;}

  const matching=cards.filter(c=>(!timer.shiftId||c.shift.id===timer.shiftId)&&c.shift.profile_id===timer.personId && c.shift.project_id===timer.jobId && start<c.end && end>c.start);
  if(!timer.shiftId){
   for(const c of matching)c.candidates.push({timer,span:[Math.max(start,c.start),Math.min(end,c.end)]});
   issues.push({timer,reason:matching.length?"Interval candidate only; no explicit timecard link":"No explicit link or overlapping timecard for timer account and job"});continue;
  }

  const ambiguous=matching.some((c,i)=>matching.slice(i+1).some(d=>Math.max(start,c.start,d.start)<Math.min(end,c.end,d.end)));

  if(ambiguous) {issues.push({timer,reason:"Overlapping timecards: cannot choose a unique match"});for(const c of matching)c.ambiguous.push(timer.id);continue;}

  for(const c of matching)c.matches.push({timer,span:[Math.max(start,c.start),Math.min(end,c.end)]});

  const covered=union(matching.map(c=>[Math.max(start,c.start),Math.min(end,c.end)]));

  if(covered<(end-start)/1000-1)issues.push({timer,reason:matching.length?"Part of timer falls outside matching timecards":"No overlapping closed timecard for the same person and job"});

 }

 return {cards:cards.map(c=>{

  const overlap=union(c.matches.map(m=>m.span));

  // Aggregate breaks have no timestamps. Bounds avoid inventing their location,

  // including when the page clips a shift at a date boundary.

  const netLow=Math.max(0,c.gross-c.breaks),netHigh=(c.start===Date.parse(c.shift.clock_in_at)&&c.end===Date.parse(c.shift.clock_out_at!))?netLow:c.gross;

  return {...c,overlap,netLow,netHigh,coveredLow:Math.max(0,overlap-c.breaks),coveredHigh:Math.min(overlap,netHigh),uncoveredLow:Math.max(0,netLow-overlap),uncoveredHigh:Math.min(c.gross-overlap,netHigh)};

 }),issues,unfinished:shifts.filter(s=>s.status!=="voided" && (!s.clock_out_at||s.status==="needs_finish"))};

}
