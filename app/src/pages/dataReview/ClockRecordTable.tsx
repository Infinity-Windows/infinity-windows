import {TablePage} from "./TablePage";
import {formatHours} from "./formatHours";
import { shiftHours, type TimeShift } from "../../lib/timeclock";
import { jobTimeReport } from "../../lib/jobTimeReport";
import { workDate } from "./generalLabor";
function personName(name: string) {
  return name.replace(/(^|[\s-])(\p{Ll})/gu, (_, prefix: string, letter: string) => prefix + letter.toLocaleUpperCase());
}
export type ClockGroup = "job" | "person" | "code";
export function clockCodeLabel(shift: TimeShift) {
  return shift.cost_codes?.label || shift.cost_codes?.code || (shift.cost_code_id ? "Unresolved cost code" : "No cost code");
}
export function ClockRecordTable({ records, groups, hidden = [], compact = false }: { records: TimeShift[]; groups: ClockGroup[]; hidden?: ClockGroup[]; compact?: boolean }) {
  if(groups.length) {
    const [dimension,...rest] = groups;
    const buckets = new Map<string,{label:string;rows:TimeShift[]}>();
    for(const shift of records) {
      const key = dimension === "job" ? shift.project_id ?? "no-job" : dimension === "person" ? shift.profile_id ?? "no-person" : shift.cost_code_id ?? "no-code";
      const label = dimension === "job" ? shift.projects?.job_code ?? "No job" : dimension === "person" ? personName(shift.profiles?.display_name ?? "Unknown person") : clockCodeLabel(shift);
      const bucket = buckets.get(key) ?? {label,rows:[]}; bucket.rows.push(shift); buckets.set(key,bucket);
    }
    return <div className="clock-record-groups">{[...buckets].sort(([,a],[,b])=>a.label.localeCompare(b.label)).map(([key,group])=>{
      const totals = jobTimeReport(group.rows,Date.now());
      return <details key={key}><summary>{group.label} <small>· {group.rows.length} shifts · {formatHours(totals.recordedHours)} finished h{totals.runningCount ? ` · ${totals.runningCount} running` : ""}{totals.unresolvedCount ? ` · ${totals.unresolvedCount} unresolved` : ""}</small></summary><ClockRecordTable records={group.rows} groups={rest} hidden={[...hidden,dimension]} compact={compact} /></details>;
    })}</div>;
  }
  return <div className="activity-table"><table><caption className="activity-sr-only">Saved clock records</caption><thead className={compact?"activity-sr-only":undefined}><tr><th>Date</th>{!hidden.includes("job") && <th>Job</th>}{!hidden.includes("person") && <th>Person</th>}{!hidden.includes("code") && <th>Cost code</th>}<th>Hours</th><th>Status</th></tr></thead><tbody><TablePage columns={3+["job","person","code"].filter(key=>!hidden.includes(key as ClockGroup)).length}>{records.map(shift=><tr key={shift.id}><td>{workDate(Date.parse(shift.clock_in_at)).slice(5)}</td>{!hidden.includes("job") && <td>{shift.projects?.job_code ?? "No job"}</td>}{!hidden.includes("person") && <td>{personName(shift.profiles?.display_name ?? "Unknown")}</td>}{!hidden.includes("code") && <td title={shift.cost_codes?.code ?? undefined}>{clockCodeLabel(shift)}</td>}<td>{shift.clock_out_at ? `${formatHours(shiftHours(shift))} h` : "Running / unresolved"}</td><td>{shift.status}</td></tr>)}</TablePage></tbody></table></div>;
}
