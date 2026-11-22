import {TablePage} from "./TablePage";
import type {WorkerEvidence} from "./scatterWorkers";
import type {TimeShift} from "../../lib/timeclock";

import type {ActivityRow} from "./activityRows";

import {timecardCoverage} from "./timecardCoverageData";

const hours=(n:number)=>(n/3600).toFixed(2);

const range=(a:number,b:number)=>Math.abs(a-b)<1?`${hours(a)} h`:`${hours(a)} to ${hours(b)} h`;

export function TimecardCoverage({shifts,timers,from,until,jobs,workers,people}:{shifts:TimeShift[];timers:ActivityRow[];from:number;until:number;jobs:Map<string,string>;roles?:Map<string,string>;workers?:Map<string,WorkerEvidence>;people?:Map<string,string>}) {

 const scopedTimers=timers,scopedShifts=shifts;
 const {cards,issues,unfinished}=timecardCoverage(scopedShifts,scopedTimers,from,until);
 const usable=scopedTimers.filter(t=>!t.reviewReason&&Number.isFinite(t.seconds)&&t.seconds>0);
 const matched=new Set(cards.flatMap(c=>c.matches.map(m=>m.timer.id)));
 const held=scopedTimers.filter(t=>t.reviewReason);
 const reasons=new Map<string,number>();
 for(const t of held){const reason=t.reviewKind==="duplicate"?"Confirmed duplicate":t.reviewKind==="overlap"?"Uncertain overlap":t.reviewReason?.includes("After-the-fact")?"After-the-fact documentation":"Timer or attribution problem";reasons.set(reason,(reasons.get(reason)??0)+1);}
 const matchingReasons=new Map<string,number>();
 for(const i of issues.filter(i=>!i.timer.reviewReason&&i.timer.seconds>0))matchingReasons.set(i.reason,(matchingReasons.get(i.reason)??0)+1);
 const totalSeconds=usable.reduce((n,t)=>n+t.seconds,0);


 const sum=(key:"coveredLow"|"coveredHigh"|"uncoveredLow"|"uncoveredHigh")=>cards.reduce((n,c)=>n+c[key],0);

 return <section className="timecard-coverage">
 <div className="record-scatter-controls"><strong>Timecards and activity records</strong><small>Page jobs and dates. Worker filters above affect scatter visibility only.</small></div>
 <details><summary>Activity records / {timers.length}</summary><div className="report-table-scroll"><table><caption>Activity records - separate from clocked labor</caption><thead><tr><th>Activity / unit</th><th>Worker evidence</th><th>Timer account</th><th>Recorded duration</th><th>Timecard link</th></tr></thead><tbody><TablePage columns={5}>{timers.map(t=>{const w=workers?.get(t.id);return <tr key={t.id}><td>{t.originalActivity??t.activity}<br/>{jobs.get(t.jobId??"")??t.job} / {t.unit}<br/><small>{t.started} to {t.ended}</small><br/><code>{t.sourceTable} / {t.id}</code></td><td>{w?.ids.length?w.ids.map(id=>people?.get(id)??id).join(", "):"Unknown worker"}<details><summary>Evidence</summary>{w?.basis??"No confirmed worker evidence"}<br/>{w?.refs.join(" / ")}</details></td><td>{t.person}</td><td>{Number.isFinite(t.seconds)?`${hours(t.seconds)} h`:"Unknown"}{t.sourceTable==="opening_phases"&&<small> / Saved phase minutes; interval placement uncertain</small>}{t.reviewReason&&<details><summary>Uncertain / held</summary>{t.reviewReason}</details>}</td><td>{t.shiftId?<><span>Explicit source link</span><br/><code>{t.shiftId}</code></>:"No explicit link"}</td></tr>})}</TablePage></tbody></table></div></details>
 <ol className="activity-coverage-funnel">
 <li><strong>Recorded activity</strong><span>{scopedTimers.length} records</span><small>Sessions and submitted phases, including held evidence. Counts are records, not units.</small></li>
 <li><strong>Usable duration</strong><span>{usable.length} records / {hours(totalSeconds)} h</span><small>Accepted partial timer duration; does not imply precise placement inside a timecard.</small><details><summary>{scopedTimers.length-usable.length} records outside this step</summary>{[...reasons].map(([reason,count])=><p key={reason}>{count} / {reason}</p>)}<p>{scopedTimers.filter(t=>!t.reviewReason&&(!Number.isFinite(t.seconds)||t.seconds<=0)).length} / No positive duration</p></details></li>
 <li><strong>Explicitly linked interval coverage</strong><span>{matched.size} records / {range(sum("coveredLow"),sum("coveredHigh"))}</span><small>Of {range(cards.reduce((n,c)=>n+c.netLow,0),cards.reduce((n,c)=>n+c.netHigh,0))} closed clocked time. Overlap counted once; break placement may reduce coverage.</small><details><summary>Why usable timers are outside confirmed coverage</summary>{[...matchingReasons].map(([reason,count])=><p key={reason}>{count} / {reason}</p>)}<p>Some records match partially. Record counts do not measure completeness of work capture.</p></details></li>
 </ol>
 <details><summary>Timecards  /  {range(sum("coveredLow"),sum("coveredHigh"))} explicitly linked  /  {range(sum("uncoveredLow"),sum("uncoveredHigh"))} without confirmed timer coverage</summary>

 <p>Explicit shift IDs establish source links to the timer account, not necessarily the actual worker. Only valid linked intervals contribute to coverage. Interval-only candidates do not. Overlapping timers count once. Ranges reflect breaks without timestamps and date-clipped shifts. Held timers and saved phase durations stay outside coverage.</p>

 <div className="report-table-scroll"><table><thead><tr><th>Person / job / start</th><th>Clocked</th><th>Explicit interval coverage</th><th>Without confirmed coverage</th><th>Records</th></tr></thead><tbody><TablePage columns={5}>{cards.map(c=><tr key={c.shift.id}><td>{c.shift.profiles?.display_name??c.shift.profile_id}<br/>{jobs.get(c.shift.project_id??"")??c.shift.project_id}<br/>{new Date(c.start).toLocaleString(undefined,{timeZone:"America/Denver"})}</td><td>{range(c.netLow,c.netHigh)}</td><td>{range(c.coveredLow,c.coveredHigh)}</td><td>{range(c.uncoveredLow,c.uncoveredHigh)}</td><td><details><summary>{c.links.length} explicit links / {c.candidates.length} candidates{c.ambiguous.length?`  /  ${c.ambiguous.length} ambiguous`:""}</summary><code>{c.shift.id}</code>{c.links.map(t=><p key={t.id}>Explicit source link / {t.originalActivity??t.activity} / {t.unit}<br/><code>{t.id}</code>{t.reviewReason&&<span> / Held: {t.reviewReason}</span>}</p>)}{c.candidates.map(m=><p key={m.timer.id}>Interval candidate only / {m.timer.originalActivity??m.timer.activity}  /  {m.timer.unit||"No unit"}  /  {hours((m.span[1]-m.span[0])/1000)} h overlap<br/><code>{m.timer.sourceTable} / {m.timer.id}</code></p>)}</details></td></tr>)}</TablePage></tbody></table></div>

 <details><summary>{issues.length} timers need review or have unmatched time</summary>{issues.map(i=><p key={i.timer.id}>{i.timer.person}  /  {jobs.get(i.timer.jobId??"")??i.timer.job}  /  {i.timer.unit}  /  {i.timer.originalActivity??i.timer.activity}<br/>{i.reason}<br/><code>{i.timer.sourceTable} / {i.timer.id}</code></p>)}</details>

 {!!unfinished.length&&<p>{unfinished.length} running or unfinished timecards excluded from coverage until closed.</p>}</details></section>;

}
