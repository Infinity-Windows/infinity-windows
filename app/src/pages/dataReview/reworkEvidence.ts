import type { ActivityRow } from "./activityRows";
import type { TimeShift } from "../../lib/timeclock";
const explicitRework = (value: string) => /\bre[ -]?work\b/i.test(value);
export const isReworkActivity = (row: ActivityRow) => row.outcome === "rework" || explicitRework(row.activity);
// Service, warranty and QC do not automatically mean rework.
export const isReworkShift = (shift: TimeShift) => explicitRework(`${shift.cost_codes?.code ?? ""} ${shift.cost_codes?.label ?? ""}`);
