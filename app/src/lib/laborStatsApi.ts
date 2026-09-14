import { supabase } from "./supabase";
import type { TimeShift } from "./timeclock";

// No injury notes, GPS, approval identities, or payroll information in this report.
const COLUMNS = "id,profile_id,project_id,cost_code_id,clock_in_at,clock_out_at,break_seconds,status,projects(job_code,name),cost_codes(code,label),profiles!profile_id(display_name)";

/** Never present a server-capped page as an all-time total. RLS remains in force. */
export async function listLaborStatsShifts(): Promise<TimeShift[]> {
  const rows: TimeShift[] = [];
  let expected: number | null = null;
  for (let page = 0; page < 1000; page++) {
    const { data, error, count } = await supabase.from("time_shifts")
      .select(COLUMNS, { count: "exact" })
      .neq("status", "voided")
      .order("clock_in_at", { ascending: false }).order("id", { ascending: false })
      .range(rows.length, rows.length + 499);
    if (error) throw error;
    if (typeof count !== "number" || (expected !== null && count !== expected)) {
      throw new Error("Time records changed while loading. Refresh the report.");
    }
    expected = count;
    const batch = (data ?? []) as unknown as TimeShift[];
    if (batch.length === 0 && rows.length < expected) throw new Error("The time report is incomplete. Please retry.");
    rows.push(...batch);
    if (rows.length >= expected) {
      if (new Set(rows.map((row) => row.id)).size !== expected) throw new Error("Time records changed while loading. Refresh the report.");
      return rows;
    }
  }
  throw new Error("The time report is too large to load completely.");
}
