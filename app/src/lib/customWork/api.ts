import { clientWithToken, supabase } from "../supabase";
import { signInMark, stillSignedInAs } from "../signedIn";
import { isMissingColumn, isMissingFunction } from "../schemaErrors";
import type {
  CrewPerson,
  CrewWorkRecord,
  StageContributorSummaryRow,
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
  unitId?: string,
  scope?: { projectIds?: string[]; from?: number; until?: number; includeOpen?: boolean; signal?: AbortSignal; isTest?: boolean; entityId?: string },
): Promise<T[]> {
  if (scope?.projectIds?.length === 0) return [];
  const result: T[] = [];
  let expected: number | null = null;
  for (let from = 0; from < 1000000;) {
    let q = supabase
      .from(table)
      .select(select, { count: "exact" })
      .order("id")
      .range(from, from + 499);
    if (profileId) q = q.eq("profile_id", profileId);
    if (unitId) q = q.eq("unit_id", unitId);
    if (scope?.entityId) q = q.eq("entity_id", scope.entityId);
    if (projectId === null) q = q.is("project_id", null);
    else if (projectId) q = q.eq("project_id", projectId);
    if (scope?.isTest !== undefined) q = q.eq("is_test", scope.isTest);
    if (scope?.projectIds) q = q.in("project_id", scope.projectIds);
    if (scope?.from !== undefined && Number.isFinite(scope.from)) {
      const from = new Date(scope.from).toISOString();
      q = scope.includeOpen ? q.or("ended_at.is.null,ended_at.gt." + from) : q.gt("ended_at", from);
    }
    if (Number.isFinite(scope?.until)) q = q.lt("started_at", new Date(scope!.until!).toISOString());
    if (scope?.signal) q = q.abortSignal(scope.signal);
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
export async function listWorkUnits(job?: string | null, signal?: AbortSignal, projectIds?: string[]): Promise<WorkUnit[]> {
  try { return await allRows<WorkUnit>("custom_work_units", UNIT_COLS, job, undefined, undefined, { signal, projectIds }); }
  catch (error) {
    // Keep the existing unit builder working during a backend/frontend rollout gap.
    if (!isMissingColumn(error)) throw error;
    return allRows<WorkUnit>("custom_work_units", UNIT_COLS.replace(",untimed_work_present", ""), job, undefined, undefined, { signal, projectIds });
  }
}
/** One unit, fresh from the server — a "Unit complete" refused because the
 * unit changed is rebuilt from this, so another person's edits survive. */
export async function getWorkUnit(id: string): Promise<WorkUnit | null> {
  const read = (cols: string) =>
    supabase.from("custom_work_units").select(cols).eq("id", id).maybeSingle();
  let { data, error } = await read(UNIT_COLS);
  if (error && isMissingColumn(error))
    ({ data, error } = await read(UNIT_COLS.replace(",untimed_work_present", "")));
  if (error) throw error;
  return (data as WorkUnit | null) ?? null;
}
// How many column sets back this database is. Remembered until the page
// reloads, so a database one migration behind is asked for the missing column
// once, not on every read (each miss is a failed request in the console).
let sessionColumnsBehind = 0;
export async function listWorkSessions(job?: string | null, profileId?: string, scope?: { projectIds?: string[]; from?: number; until?: number; includeOpen?: boolean; signal?: AbortSignal }, unitId?: string) {
  const read = (columns: string) => allRows<WorkSession>("custom_work_sessions", columns, job, profileId, unitId, scope);
  // Newest columns first; each step back is a database one migration behind.
  const workday = SESSION_COLS + ",workday_done_at,workday_machinery_ms,workday_machinery_started_at";
  const sets = [workday + ",workday_machinery_spans", workday, SESSION_COLS];
  for (let behind = sessionColumnsBehind; behind < sets.length - 1; behind++) {
    try {
      const rows = await read(sets[behind]);
      sessionColumnsBehind = behind;
      return rows;
    } catch (error) {
      if (!isMissingColumn(error)) throw error;
    }
  }
  sessionColumnsBehind = sets.length - 1;
  return read(SESSION_COLS);
}
export async function listOpeningWorkProgress(projectId: string, openingId: string) {
  const { data: units, error } = await supabase.from("custom_work_units").select("id,facts")
    .eq("project_id", projectId).eq("opening_id", openingId);
  if (error) throw error;
  const sessions = (await Promise.all(units.map(unit => listWorkSessions(projectId, undefined, undefined, unit.id)))).flat();
  return { units, sessions };
}
export const listWorkTypes = () =>
  allRows<WorkType>("custom_work_types", "id,label,archived,revision");
export const listWorkHistory = (job?: string | null, entityId?: string) =>
  allRows<WorkHistory>(
    "custom_work_history",
    "id,project_id,actor_id,entity_id,action,reason,before_value,after_value,created_at",
    job, undefined, undefined, { entityId },
  );
const CREW_PERSON_COLS = "id,display_name,active,role,is_partner,retired_at,access_revoked_at";
export const listCrewRecordPeople = () => allRows<CrewPerson>("profiles", CREW_PERSON_COLS);
export const listPlannerPeople = () => allRows<CrewPerson>(
  "profiles", CREW_PERSON_COLS,
  undefined, undefined, undefined, { isTest: false },
);
const CREW_RECORD_COLS = "id,project_id,unit_id,filed_by,work_date,stage,outcome,whole_complete,description,created_at,people:crew_work_record_people(profile_id,voided_at,voided_by,void_reason)";
async function readCrewRecords(job?: string, unit?: string) {
  try {
    return await allRows<CrewWorkRecord>("crew_work_records", CREW_RECORD_COLS, job, undefined, unit);
  } catch (error) {
    // The original ledger remains readable while the additive correction
    // columns are being deployed. Other schema drift must still surface.
    if (!["voided_at", "voided_by", "void_reason"].some((column) => isMissingColumn(error, column))) throw error;
    return allRows<CrewWorkRecord>("crew_work_records", CREW_RECORD_COLS.replace("profile_id,voided_at,voided_by,void_reason", "profile_id"), job, undefined, unit);
  }
}
export const listCrewWorkRecords = (job: string) => readCrewRecords(job);
export const listUnitCrewWorkRecords = (unit: string) => readCrewRecords(undefined, unit);
/** The server-authoritative answer to "who is credited on this tuple right
 * now", with the digest a correction must match. A missing RPC must surface
 * as unavailable; it is not evidence that nobody worked on the unit. */
export async function getStageContributorSummary(unitId: string): Promise<StageContributorSummaryRow[]> {
  const { data, error } = await supabase.rpc("stage_contributor_summary", { p_unit: unitId });
  if (error) throw error;
  return (data ?? []) as StageContributorSummaryRow[];
}
const DIRECT_RPC_ACTIONS: Partial<Record<WorkCommand["action"], string>> = {
  workday_activity: "save_workday_activity",
  machinery_correction: "correct_workday_machinery",
  plan_activity_done: "mark_plan_activity_done",
  plan_unit_lead: "take_plan_unit_lead",
  crew_record: "record_crew_work",
  stage_contributors: "record_stage_contributors",
  correct_stage_contributors: "correct_stage_contributors",
};
export async function sendWorkCommand(c: WorkCommand): Promise<string> {
  const mark = signInMark();
  const wrongAccount = () => new Error(
    "Sign back into the account that recorded this work to sync it.",
  );
  if (!stillSignedInAs(mark, c.userId)) throw wrongAccount();
  const { data: auth, error: authError } = await supabase.auth.getSession();
  if (authError) throw authError;
  if (auth.session?.user.id !== c.userId || !stillSignedInAs(mark, c.userId))
    throw wrongAccount();
  // A unit created on the phone (see installerWorkflow/queuedUnits.ts). It
  // goes to save_unit_details, which has its own arguments, under the same
  // verified account as every other queued change.
  if (c.action === "unit_create") {
    const write = c.data as unknown as import("../install/unitDetails").UnitDetailsWrite;
    const { error } = await clientWithToken(auth.session.access_token).rpc("save_unit_details", {
      p_project: write.projectId, p_opening: write.id, p_create: true, p_code: write.code,
      p_details: write.details, p_previous_code: write.previousCode, p_previous_details: write.previousDetails,
      p_edit_id: write.editId, p_reason: write.reason ?? null,
    });
    if (!stillSignedInAs(mark, c.userId)) throw wrongAccount();
    if (error?.code === "23505") throw { ...error, message: "This job already has a unit with that number." };
    if (error) throw error;
    return write.id;
  }
  const direct = DIRECT_RPC_ACTIONS[c.action];
  // A mutable shared client could switch accounts between getSession and send.
  // Bind this request to the verified account's token for its entire lifetime.
  const { data, error } = await clientWithToken(auth.session.access_token).rpc(direct ?? "custom_work_command", {
    p_id: c.id,
    ...(direct ? {} : { p_action: c.action }),
    p_data: c.data,
  });
  // A committed request whose reply arrives after sign-out stays queued under
  // its original id. That owner can retry it against the server's receipt.
  if (!stillSignedInAs(mark, c.userId)) throw wrongAccount();
  if ((c.action === "workday_activity" || c.action === "plan_activity_done" || c.action === "plan_unit_lead") && isMissingFunction(error))
    throw new Error("This Workday update is saved on this device. Forge needs a server update before it can sync.");
  if (error) throw error;
  return data as string;
}
