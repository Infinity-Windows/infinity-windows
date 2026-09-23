import { supabase } from "../supabase";
import { isMissingColumn } from "../schemaErrors";
import type {
  CrewPerson,
  CrewWorkRecord,
  WorkCommand,
  WorkHistory,
  WorkSession,
  WorkType,
  WorkUnit,
} from "./model";

const UNIT_COLS =
  "id,project_id,opening_id,created_by,label,type_label,facts,legacy_time_present,untimed_work_present,revision,created_at,updated_at";
const SESSION_COLS =
  "id,profile_id,shift_id,project_id,unit_id,kind,participation,stage,description,outcome,delay_reason,started_at,ended_at,end_reason,revision,shift_status,review_required";
async function allRows<T>(
  table: string,
  select: string,
  projectId?: string | null,
  profileId?: string,
): Promise<T[]> {
  const result: T[] = [];
  let expected: number | null = null;
  for (let from = 0; from < 1000000;) {
    let q = supabase
      .from(table)
      .select(select, { count: "exact" })
      .order("id")
      .range(from, from + 499);
    if (profileId) q = q.eq("profile_id", profileId);
    if (projectId === null) q = q.is("project_id", null);
    else if (projectId) q = q.eq("project_id", projectId);
    const { data, error, count } = await q;
    if (error) throw error;
    if (count === null || (expected !== null && count !== expected))
      throw new Error(
        "Work records changed while loading. Refresh for a complete view.",
      );
    expected = count;
    result.push(...((data ?? []) as T[]));
    from += data?.length ?? 0;
    if (from === count) {
      if (new Set(result.map((r) => (r as { id: unknown }).id)).size !== count)
        throw new Error(
          "Work records changed while loading. Refresh for a complete view.",
        );
      return result;
    }
    if (!data?.length)
      throw new Error(
        "Some work records did not load. Refresh before using these totals.",
      );
  }
  throw new Error("This report needs a smaller scope.");
}
export async function listWorkUnits(job?: string | null): Promise<WorkUnit[]> {
  try { return await allRows<WorkUnit>("custom_work_units", UNIT_COLS, job); }
  catch (error) {
    // Keep the existing unit builder working during a backend/frontend rollout gap.
    if (!isMissingColumn(error)) throw error;
    return allRows<WorkUnit>("custom_work_units", UNIT_COLS.replace(",untimed_work_present", ""), job);
  }
}
export const listWorkSessions = (job?: string | null, profileId?: string) =>
  allRows<WorkSession>("custom_work_sessions", SESSION_COLS, job, profileId);
export const listWorkTypes = () =>
  allRows<WorkType>("custom_work_types", "id,label,archived,revision");
export const listWorkHistory = (job?: string | null) =>
  allRows<WorkHistory>(
    "custom_work_history",
    "id,project_id,actor_id,entity_id,action,reason,before_value,after_value,created_at",
    job,
  );
export const listCrewRecordPeople = () => allRows<CrewPerson>("profiles", "id,display_name,active,role,is_partner,retired_at,access_revoked_at");
export const listCrewWorkRecords = (job: string) =>
  allRows<CrewWorkRecord>("crew_work_records",
    "id,project_id,unit_id,filed_by,work_date,stage,outcome,whole_complete,description,created_at,people:crew_work_record_people(profile_id)", job);
export async function sendWorkCommand(c: WorkCommand): Promise<string> {
  const { data: auth, error: authError } = await supabase.auth.getSession();
  if (authError) throw authError;
  if (auth.session?.user.id !== c.userId)
    throw new Error(
      "Sign back into the account that recorded this work to sync it.",
    );
  const { data, error } = await supabase.rpc(c.action === "crew_record" ? "record_crew_work" : "custom_work_command", {
    p_id: c.id,
    ...(c.action === "crew_record" ? {} : { p_action: c.action }),
    p_data: c.data,
  });
  if (error) throw error;
  return data as string;
}
