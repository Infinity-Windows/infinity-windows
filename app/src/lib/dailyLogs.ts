// Wave L: the client face of daily_logs. Reads go straight through RLS
// (internal crew, including installers); every write goes
// through file_daily_log (SECURITY DEFINER) — there is no direct-write path
// to bypass its validation.

import {signedInUserId} from "./signedIn";
import { supabase } from "./supabase";
import { isNetworkError } from "./offline/outbox-core";
import { enqueueDailyLog } from "./offline/outbox";
import { listProjects } from "./api";
import { listTeamShifts, punchDay, weekRange } from "./timeclock";
import { listProjectRedosAll, listProjectSessions } from "./install/sessions";
import { buildDailyLogDraft, type DailyLogDraft } from "./dailyLogDraft";
import { jobsNeedingLog, localDateISO } from "./dailyLogDay";
import { coverage, type CoverageSummary, type JobDay } from "./dailyLogCoverage";
import { emptyProgressFields, type DailyLogProgressFields } from "./dailyLogStages";

export interface DailyLogReflection {
  went_well?: string;
  went_poorly?: string;
  would_have_helped?: string;
  what_worked?: string;
}

export type DayFlow = "smooth" | "fine" | "stuck";

export interface DailyLog extends DailyLogProgressFields {
  id: string;
  project_id: string;
  log_date: string;
  headline: string | null;
  notes: string;
  day_flow: DayFlow | null;
  reflection: DailyLogReflection | null;
  weather: string | null;
  customer_visible: boolean;
  customer_visible_at: string | null;
  /** Bumped by every change to what the log says (20261030000000). A Forge AI
   * contribution names the revision it was previewed against. */
  revision?: number;
  filed_by: string;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
  filer?: { display_name: string | null } | null;
  /** Null once a job is purged (20260959000000 detach) — job_name below is
   * what survives that, so a log never silently disappears from "my logs". */
  project?: { job_code: string; name: string } | null;
  /** The job's name as it stood at detach time; set only once project_id
   * goes null. Always prefer project?.name when project is present. */
  job_name: string | null;
}

/** The raw row shape PostgREST hands back for the new (20261064000000)
 * columns — snake_case, and every array/object column nullable on a
 * pre-migration database (isMissingColumn peels them back below). */
interface DailyLogProgressRow {
  work_stages?: DailyLogProgressFields["workStages"] | null;
  stage_progress?: DailyLogProgressFields["stageProgress"] | null;
  covers?: DailyLogProgressFields["covers"];
  delays?: DailyLogProgressFields["delays"] | null;
  safety_status?: DailyLogProgressFields["safetyStatus"];
  weather_impact?: DailyLogProgressFields["weatherImpact"];
  missing_tomorrow?: DailyLogProgressFields["missingTomorrow"] | null;
  tomorrow_stages?: DailyLogProgressFields["tomorrowStages"] | null;
  tomorrow_crew_expected?: number | null;
  tomorrow_plan?: string | null;
  units_today?: number | null;
  units_to_date?: number | null;
  units_remaining?: number | null;
  units_remaining_detail?: string | null;
}

/** Normalize one fetched row's progress columns, defaulting every one that a
 * pre-migration database (or a row inserted before this wave) never set. */
function progressFromRow(row: DailyLogProgressRow): DailyLogProgressFields {
  const empty = emptyProgressFields();
  return {
    workStages: row.work_stages ?? empty.workStages,
    stageProgress: row.stage_progress ?? empty.stageProgress,
    covers: row.covers ?? empty.covers,
    delays: row.delays ?? empty.delays,
    safetyStatus: row.safety_status ?? empty.safetyStatus,
    weatherImpact: row.weather_impact ?? empty.weatherImpact,
    missingTomorrow: row.missing_tomorrow ?? empty.missingTomorrow,
    tomorrowStages: row.tomorrow_stages ?? empty.tomorrowStages,
    tomorrowCrewExpected: row.tomorrow_crew_expected ?? empty.tomorrowCrewExpected,
    tomorrowPlan: row.tomorrow_plan ?? empty.tomorrowPlan,
    unitsToday: row.units_today ?? empty.unitsToday,
    unitsToDate: row.units_to_date ?? empty.unitsToDate,
    unitsRemaining: row.units_remaining ?? empty.unitsRemaining,
    unitsRemainingDetail: row.units_remaining_detail ?? empty.unitsRemainingDetail,
  };
}

function toDailyLog(row: Record<string, unknown>): DailyLog {
  return { ...(row as object), ...progressFromRow(row as DailyLogProgressRow) } as DailyLog;
}

// `profiles` named explicitly via `filed_by`: daily_logs points at profiles
// three ways (filed_by, updated_by, customer_visible_by), and a bare
// `profiles(...)` is ambiguous — PostgREST answers a 300 rather than
// guessing (same reason timeclock.ts's SHIFT_SELECT does this).
const LOG_SELECT = "*, filer:profiles!filed_by(display_name)";
/** Cross-job list (the Daily Logs page): the filer plus which job this row
 * belongs to, since that page is never scoped to one project. A LEFT join
 * (NOT !inner) on purpose — a log whose job was later purged keeps
 * project_id null and relies on job_name (20260959000000's detach) to say
 * what job it was; !inner would silently drop that row from "my logs". */
const LOG_SELECT_WITH_PROJECT =
  "*, filer:profiles!filed_by(display_name), project:projects(job_code, name)";

function isMissingTableError(e: { code?: string; message?: string } | null): boolean {
  return Boolean(
    e && (e.code === "42P01" || /relation .* does not exist/i.test(e.message ?? "")),
  );
}

/** A job's logs, newest first — the Logs tab's list (L3). Internal crew from
 * installer up read them (20261014000000); a partner's call comes back empty (RLS). */
export async function listDailyLogs(projectId: string): Promise<DailyLog[]> {
  const { data, error } = await supabase
    .from("daily_logs")
    .select(LOG_SELECT)
    .eq("project_id", projectId)
    .order("log_date", { ascending: false });
  if (isMissingTableError(error)) return [];
  if (error) throw error;
  return (data ?? []).map((row) => toDailyLog(row as Record<string, unknown>));
}

export const DAILY_LOGS_PAGE_SIZE = 50;

export interface DailyLogsPage {
  logs: DailyLog[];
  /** True when there are more rows in this date range than fit on this
   * page — PostgREST's own default row cap must never silently pass as
   * "that's everything" (the brief's own warning). The Daily Logs page
   * shows "Load more" rather than ever treating this list as complete. */
  hasMore: boolean;
  fromDate: string;
  toDate: string;
}

/**
 * Every job a person reaches, across every day — the Daily Logs page (owner
 * request 2026-10-01, Horizon parity). Defaults to the last 90 days
 * (Horizon's own default window), newest first, paginated explicitly: this
 * fetches one row past the page size so truncation is KNOWN, never assumed
 * from PostgREST's own default cap. Reads the SAME daily_logs_select_crew
 * policy as every other list here: installer and up, never a partner.
 *
 * `pageSize` is clamped well under PostgREST's own row cap (independent
 * review, 2026-10-01: a caller that kept widening its own pageSize instead of
 * paging eventually hit that cap, which silently truncates the response —
 * `rows.length > pageSize` would then read as "no more" even though the
 * database has more). The caller accumulates PAGES instead; this function
 * only ever asks for one bounded page at a time.
 *
 * `projectId`, given, filters server-side — a job filter applied only to
 * whatever page happened to already be loaded would read as "this job has
 * no other logs" the moment its next log falls on an unloaded page.
 */
export async function listMyDailyLogs(
  opts: { fromDate?: string; toDate?: string; projectId?: string; offset?: number; pageSize?: number } = {},
): Promise<DailyLogsPage> {
  const toDate = opts.toDate ?? localDateISO();
  const fromDate = opts.fromDate ?? localDateISO(new Date(Date.now() - 90 * 24 * 60 * 60 * 1000));
  const pageSize = Math.min(opts.pageSize ?? DAILY_LOGS_PAGE_SIZE, DAILY_LOGS_PAGE_SIZE);
  const offset = opts.offset ?? 0;
  let query = supabase
    .from("daily_logs")
    .select(LOG_SELECT_WITH_PROJECT)
    .gte("log_date", fromDate)
    .lte("log_date", toDate);
  if (opts.projectId) query = query.eq("project_id", opts.projectId);
  const { data, error } = await query
    .order("log_date", { ascending: false })
    .order("id", { ascending: false })
    .range(offset, offset + pageSize); // one extra row proves whether more exist
  if (isMissingTableError(error)) return { logs: [], hasMore: false, fromDate, toDate };
  if (error) throw error;
  const rows = data ?? [];
  const hasMore = rows.length > pageSize;
  return {
    logs: rows.slice(0, pageSize).map((row) => toDailyLog(row as Record<string, unknown>)),
    hasMore,
    fromDate,
    toDate,
  };
}

/**
 * Every job's logs whose log_date falls in [fromDate, toDate] inclusive —
 * wave C's calendar day panel needs one date across every job, not one
 * job's whole history (listDailyLogs above) or just which project ids
 * logged today (listLoggedProjectIdsToday below). Fetched once per visible
 * month and re-sliced per day by dayMemory.ts's own log_date filter.
 * Internal crew from installer up see rows (RLS, 20261014000000) — same as
 * every other read here.
 */
export async function listDailyLogsForRange(fromDate: string, toDate: string): Promise<DailyLog[]> {
  const { data, error } = await supabase
    .from("daily_logs")
    .select(LOG_SELECT)
    .gte("log_date", fromDate)
    .lte("log_date", toDate);
  if (isMissingTableError(error)) return [];
  if (error) throw error;
  return (data ?? []).map((row) => toDailyLog(row as Record<string, unknown>));
}

/** One job-day's log, or null if nobody has filed it yet. */
export async function getDailyLog(
  projectId: string,
  logDate: string,
  /** The outbox reads through the client its send is bound to (2026-09-25). */
  client: typeof supabase = supabase,
): Promise<DailyLog | null> {
  const { data, error } = await client
    .from("daily_logs")
    .select(LOG_SELECT)
    .eq("project_id", projectId)
    .eq("log_date", logDate)
    .maybeSingle();
  if (isMissingTableError(error)) return null;
  if (error) throw error;
  return data ? toDailyLog(data as Record<string, unknown>) : null;
}

/** One log by id — the "Share link" / detail view's own lookup, for a
 * bookmarked or copied URL that may point at a log outside the list page's
 * current date window. LEFT join on project (see LOG_SELECT_WITH_PROJECT). */
export async function getDailyLogById(id: string): Promise<DailyLog | null> {
  const { data, error } = await supabase
    .from("daily_logs")
    .select(LOG_SELECT_WITH_PROJECT)
    .eq("id", id)
    .maybeSingle();
  if (isMissingTableError(error)) return null;
  if (error) throw error;
  return data ? toDailyLog(data as Record<string, unknown>) : null;
}

/**
 * The manual editor's writer. It replaces the shared row's text, which is
 * right when the person is editing the text they can see. Forge AI drafts never
 * come through here: they append through append_daily_log_contribution
 * (lib/aiDailyLogs/save.ts), which refuses a stale preview and saves once.
 */
export interface FileDailyLogInput extends DailyLogProgressFields {
  projectId: string;
  logDate: string;
  headline: string | null;
  notes: string;
  dayFlow: DayFlow | null;
  reflection: DailyLogReflection | null;
  weather: string | null;
  /** Revision shown when these words were written; null if offline/unknown. */
  baseRevision: number | null;
  reviewedConflict?: string|null;
  ownerId?: string|null;
}

export function isStaleDailyLogError(error: unknown): boolean {
  return !!error && typeof error === "object" && "code" in error && error.code === "40001";
}

/** What happened to a filing: it reached the server, or it is waiting. */
export interface FiledDailyLog {
  /** The saved row, or null when this is sitting in the outbox instead. */
  log: DailyLog | null;
  /** True when it is queued on this phone rather than done on the server. */
  queued: boolean;
}

/**
 * File (or update) one job-day's log — SERVER FIRST, queue only on no signal.
 *
 * This used to be a bare RPC with no fallback, which meant a log written in a
 * canyon was simply lost: the toast said what the server said, which was
 * nothing, and the words were gone. It now follows the same doctrine as the
 * warehouse writes (lib/warehouse/offlineWrites.ts).
 *
 * The direction of that doctrine matters here more than most places, because
 * file_daily_log genuinely rejects things: notes are required, a future date
 * is refused, and partners or removed logins are turned away. Those are REAL answers
 * and they surface immediately — queueing a refusal means it fails forever in
 * the dead-letter and the person never learns they were wrong. Only a network
 * failure queues.
 */
export async function fileDailyLog(input: FileDailyLogInput): Promise<FiledDailyLog> {
  // Capture before any await. A network failure after sign-out must never
  // queue the original author's private report under the next person's login.
  const ownedInput={...input,ownerId:input.ownerId??signedInUserId()};
  // An unknown base cannot safely replace the shared row. Keep it on the phone
  // for the outbox to read and merge under the server revision when online.
  if (input.baseRevision == null) {
    // The manual editor always carries a full, deliberate structured answer
    // — this is never the "legacy client never knew about these fields" case.
    await enqueueDailyLog({ ...ownedInput, baseRevision: null, progressProvided: true });
    return { log: null, queued: true };
  }
  try {
    const { data, error } = await supabase.rpc("file_daily_log", {
      p_project_id: input.projectId,
      p_log_date: input.logDate,
      p_headline: input.headline,
      p_notes: input.notes,
      p_day_flow: input.dayFlow,
      p_reflection: input.reflection,
      p_weather: input.weather,
      p_expected_revision: input.baseRevision,
      // The manual editor always sends a full, explicit snapshot (even
      // explicit clears) — never the "old client omitted these" case
      // p_progress_provided=false exists for.
      p_progress_provided: true,
      p_work_stages: input.workStages,
      p_stage_progress: input.stageProgress,
      p_covers: input.covers,
      p_delays: input.delays,
      p_safety_status: input.safetyStatus,
      p_weather_impact: input.weatherImpact,
      p_missing_tomorrow: input.missingTomorrow,
      p_tomorrow_stages: input.tomorrowStages,
      p_tomorrow_crew_expected: input.tomorrowCrewExpected,
      p_tomorrow_plan: input.tomorrowPlan,
      p_units_today: input.unitsToday,
      p_units_to_date: input.unitsToDate,
      p_units_remaining: input.unitsRemaining,
      p_units_remaining_detail: input.unitsRemainingDetail,
    });
    if (error) throw error;
    return { log: toDailyLog(data as Record<string, unknown>), queued: false };
  } catch (e) {
    if (isStaleDailyLogError(e)) throw e;
    if (!isNetworkError(e)) throw e;
    await enqueueDailyLog({ ...ownedInput, progressProvided: true });
    return { log: null, queued: true };
  }
}

/** Wave S, S2: supervisor+ shares (or un-shares) one day's log with the
 * builder login granted that job (Q14). Server-enforced (RLS has no direct
 * write path to daily_logs at all — set_log_customer_visible is SECURITY
 * DEFINER and the only writer); this call fails outright for anyone below
 * supervisor rather than silently no-op. */
export async function setLogCustomerVisible(logId: string, visible: boolean): Promise<DailyLog> {
  const { data, error } = await supabase.rpc("set_log_customer_visible", {
    p_log: logId,
    p_visible: visible,
  });
  if (error) throw error;
  return data as DailyLog;
}

// -------------------------------------------------- L2: the draft's inputs

/** The local calendar day's [start, end) as absolute instants, computed in
 * the caller's OWN timezone (no `Z` suffix — parsed as local time), so the
 * window lines up exactly with logDate's local meaning. */
function localDayBounds(logDate: string): { startIso: string; endIso: string } {
  const start = new Date(`${logDate}T00:00:00`);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return { startIso: start.toISOString(), endIso: end.toISOString() };
}

interface DraftShiftRow {
  profile_id: string;
  clock_in_at: string;
  clock_out_at: string | null;
  break_seconds: number;
  status: string;
}

async function listProjectShiftsOnDay(projectId: string, logDate: string): Promise<DraftShiftRow[]> {
  const { startIso, endIso } = localDayBounds(logDate);
  const { data, error } = await supabase
    .from("time_shifts")
    .select("profile_id, clock_in_at, clock_out_at, break_seconds, status")
    .eq("project_id", projectId)
    .gte("clock_in_at", startIso)
    .lt("clock_in_at", endIso)
    .order("clock_in_at");
  if (isMissingTableError(error)) return [];
  if (error) throw error;
  return (data ?? []) as DraftShiftRow[];
}

/**
 * Everything buildDailyLogDraft needs for one job-day, fetched and bucketed
 * to that LOCAL day. Sessions/redos are fetched project-wide (they have no
 * date-range query of their own — see sessions.ts) and filtered here by
 * punchDay, the same local-day convention timecard.ts already uses to
 * bucket a punch; started_at/pressed_at get the identical treatment so a
 * unit worked or a redo pressed near local midnight lands in the same
 * bucket a shift would.
 */
export async function buildDraftForJobDay(projectId: string, logDate: string): Promise<DailyLogDraft> {
  const [shifts, sessions, redos] = await Promise.all([
    listProjectShiftsOnDay(projectId, logDate),
    listProjectSessions(projectId),
    listProjectRedosAll(projectId),
  ]);

  return buildDailyLogDraft({
    shifts: shifts.map((s) => ({
      profile_id: s.profile_id,
      clock_in_at: s.clock_in_at,
      clock_out_at: s.clock_out_at,
      break_seconds: s.break_seconds,
      status: s.status,
    })),
    sessions: sessions
      .filter((s) => punchDay(s.started_at) === logDate)
      .map((s) => ({
        opening_id: s.opening_id,
        opening_code: s.opening?.opening_code ?? "?",
        started_at: s.started_at,
        ended_at: s.ended_at,
        end_reason: s.end_reason,
      })),
    redos: redos
      .filter((r) => punchDay(r.pressed_at) === logDate)
      .map((r) => ({
        opening_id: r.opening_id,
        opening_code: r.opening?.opening_code ?? "?",
        reason: r.reason,
      })),
  });
}

// ------------------------------------------------------ L4: the today chip

export interface JobNeedingLog {
  projectId: string;
  jobCode: string;
  name: string;
}

/** Every unit_sessions row in range, project-wide (the chip and the
 * coverage line both need every job, not one), reduced to just enough to
 * bucket by project and by local day — shared by jobsNeedingLogToday
 * (which only cares about the project) and weeklyLogCoverage (which needs
 * the day too, since its range spans more than one). */
async function listSessionProjectDaysInRange(
  startIso: string,
  endIso: string,
): Promise<{ projectId: string; logDate: string }[]> {
  const { data, error } = await supabase
    .from("unit_sessions")
    .select("started_at, opening:project_openings!inner(project_id)")
    .gte("started_at", startIso)
    .lt("started_at", endIso);
  if (isMissingTableError(error)) return [];
  if (error) throw error;
  return ((data ?? []) as unknown as { started_at: string; opening: { project_id: string } | null }[])
    .filter((r) => r.opening?.project_id)
    .map((r) => ({ projectId: r.opening!.project_id, logDate: punchDay(r.started_at) }));
}

async function listLoggedProjectIdsToday(logDate: string): Promise<string[]> {
  const { data, error } = await supabase
    .from("daily_logs")
    .select("project_id")
    .eq("log_date", logDate);
  if (isMissingTableError(error)) return [];
  if (error) throw error;
  return ((data ?? []) as { project_id: string }[]).map((r) => r.project_id);
}

/**
 * The "Log today · N" chip's data (L4): active jobs worked today (any
 * shift or session, by anyone — Q6's ONE shared log per job means the chip
 * is not scoped to "installers who report to me", a hierarchy this app has
 * no table for) with no daily_logs row yet for today. Available to installers
 * and above. The daily_logs policy and filing RPC both exclude partners.
 */
export async function jobsNeedingLogToday(): Promise<JobNeedingLog[]> {
  const logDate = localDateISO();
  const { startIso, endIso } = localDayBounds(logDate);

  const [active, teamShifts, sessionDays, loggedProjectIds] = await Promise.all([
    listProjects(),
    listTeamShifts(startIso, endIso),
    listSessionProjectDaysInRange(startIso, endIso),
    listLoggedProjectIdsToday(logDate),
  ]);

  const workedProjectIds = [
    ...teamShifts.map((s) => s.project_id).filter((id): id is string => Boolean(id)),
    ...sessionDays.map((d) => d.projectId),
  ];
  const needIds = new Set(jobsNeedingLog(workedProjectIds, loggedProjectIds));

  return active
    .filter((p) => needIds.has(p.id))
    .map((p) => ({ projectId: p.id, jobCode: p.job_code, name: p.name }));
}

// --------------------------------------------------- L5: coverage for owners

/**
 * This week's log coverage across every active job (Heartbeat's owner-only
 * line — spec's own example: "Logs: 4 of 6 worked days logged this week").
 * weekRange() is the SAME Monday-based week the payroll grid already uses
 * (timeclock.ts) — one more place this wave reuses an existing day/week
 * convention instead of minting a second one.
 */
export async function weeklyLogCoverage(): Promise<CoverageSummary> {
  const week = weekRange();
  const weekStartDate = localDateISO(week.start);
  const weekEndDate = localDateISO(week.end);

  const [active, teamShifts, sessionDays, logRows] = await Promise.all([
    listProjects(),
    listTeamShifts(week.startIso, week.endIso),
    listSessionProjectDaysInRange(week.startIso, week.endIso),
    supabase
      .from("daily_logs")
      .select("project_id, log_date")
      .gte("log_date", weekStartDate)
      .lt("log_date", weekEndDate)
      .then(({ data, error }) => {
        if (isMissingTableError(error)) return [] as { project_id: string; log_date: string }[];
        if (error) throw error;
        return (data ?? []) as { project_id: string; log_date: string }[];
      }),
  ]);

  const activeIds = new Set(active.map((p) => p.id));
  const workedDays: JobDay[] = [
    ...teamShifts
      .filter((s): s is typeof s & { project_id: string } => Boolean(s.project_id))
      .map((s) => ({ projectId: s.project_id, logDate: punchDay(s.clock_in_at) })),
    ...sessionDays.map((d) => ({ projectId: d.projectId, logDate: d.logDate })),
  ].filter((d) => activeIds.has(d.projectId));
  const loggedDays: JobDay[] = logRows
    .map((r) => ({ projectId: r.project_id, logDate: r.log_date }))
    .filter((d) => activeIds.has(d.projectId));

  return coverage(workedDays, loggedDays);
}
