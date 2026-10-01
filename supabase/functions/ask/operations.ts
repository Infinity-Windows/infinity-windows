import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1';
import { buildTimeReport, completeReportRows, parseReportScope, reportBounds, validDay, validId, type AskArtifact, type JobSummaryArtifact, type ReportScope, type ReportShift } from '../_shared/askReporting.ts';

// Deliberately no service-role client. Authentication/rank/partner checks happen
// before this executor is constructed; the queries also retain caller RLS.
const SHIFT_FIELDS = 'id,profile_id,project_id,cost_code_id,clock_in_at,clock_out_at,break_seconds,break_started_at,status,created_at,note,source_import,injured,time_confirmed,profiles!profile_id(display_name),projects(job_code,name),cost_codes(code,label)';
const teamVisibleToForeman = (role: string) => !['supervisor','admin','owner','big_boss'].includes(role);
export async function readReportShifts(client: SupabaseClient, scope: ReportScope, visibleProfileIds: string[] | null = null): Promise<ReportShift[]> {
  if (visibleProfileIds?.length === 0) return [];
  const bounds = reportBounds(scope);
  const rows = await completeReportRows<ReportShift>(offset => {
    let q = client.from('time_shifts').select(SHIFT_FIELDS, { count: 'exact' }).neq('status', 'voided');
    if (bounds.since) q = q.gte('clock_in_at', bounds.since);
    if (bounds.until) q = q.lt('clock_in_at', bounds.until);
    if (scope.profileIds) q = q.in('profile_id', scope.profileIds);
    if (visibleProfileIds) q = q.in('profile_id', visibleProfileIds);
    if (scope.projectIds) {
      const ids = scope.projectIds.filter(id=>id !== 'unassigned');
      if (scope.projectIds.includes('unassigned')) q = ids.length ? q.or(`project_id.is.null,project_id.in.(${ids.join(',')})`) : q.is('project_id', null);
      else q = q.in('project_id', ids);
    }
    return q.order('clock_in_at').order('id').range(offset, offset + 499);
  });
  // Imported evidence may gain private columns later. Only export metadata
  // already used by the time-entry export belongs in an Ask artifact.
  const allowed = ['First Name', 'Last Name', 'Customer', 'Project Number', 'Project', 'Cost Code', 'Cost Code Desc.', 'Equipment', 'Add-Ons'];
  return rows.map(row => ({ ...row, source_import: row.source_import ? {
    ...row.source_import,
    original: Object.fromEntries(Object.entries(row.source_import.original ?? {}).filter(([key]) => allowed.includes(key))),
  } : null }));
}
export function reportingExecutor(client: SupabaseClient, userId: string, rank: number, timeZone: string, artifacts: AskArtifact[]) {
  const visiblePeople = async (): Promise<Array<{id:string;display_name:string;role:string}>> => {
    const rows = await completeReportRows<{id:string;display_name:string;role:string}>(offset => client.from('profiles').select('id,display_name,role',{count:'exact'}).order('id').range(offset,offset+499));
    return rank >= 2 ? rows : rows.filter(p => rank === 1 ? teamVisibleToForeman(p.role) : p.id === userId);
  };
  return async (name: string, input: unknown): Promise<{ content: string; is_error?: boolean }> => {
    try {
      if (artifacts.length >= 4) return { content: 'Four reports are ready. Download them or request additional reports in a new message.', is_error: true };
      const args = input && typeof input === 'object' ? input as Record<string, unknown> : {};
      if (name === 'find_report_records') {
        const searches = Array.isArray(args.searches) ? args.searches : typeof args.search === 'string' ? [args.search] : [];
        if (!['people','jobs'].includes(String(args.kind)) || !searches.length || searches.length > 12 || searches.some(s => typeof s !== 'string' || !s.trim() || s.length > 100)) throw new Error('Choose people or jobs and up to 12 short search terms.');
        const people = args.kind === 'people';
        const rows = await completeReportRows<{id:string; display_name?:string; name?:string; job_code?:string; status?:string}>(offset => {
          let q = client.from(people ? 'profiles' : 'projects').select(people ? 'id,display_name' : 'id,name,job_code,status', {count:'exact'});
          if (people && rank < 1) q = q.eq('id',userId);
          if (!people) q = q.is('deleted_at',null);
          return q.order('id').range(offset, offset+499);
        });
        const allowed = people && rank < 2 ? new Set((await visiblePeople()).map(p=>p.id)) : null;
        const visibleRows = allowed ? rows.filter(r=>allowed.has(r.id)) : rows;
        const results = searches.map(term => {
          const search = String(term).trim().toLocaleLowerCase();
          const matches = visibleRows.filter(r=>[r.display_name,r.name,r.job_code].some(v=>v?.toLocaleLowerCase().includes(search)));
          return { search: term, records: matches.slice(0,60), matches: matches.length, more: matches.length > 60 };
        });
        return { content: JSON.stringify({ results, instruction: 'Use only confirmed matching IDs. An exclusion applies to each ID you list. If a term is misspelled or unclear, ask instead of guessing.' }) };
      }
      if (name === 'get_hours_report') {
        const scope = parseReportScope(input,timeZone,userId,rank);
        const permitted = rank < 2 ? (await visiblePeople()).map(p=>p.id) : null;
        if (rank === 1 && scope.profileIds?.some(id=>!permitted?.includes(id))) throw new Error('The report includes people above your role. Choose installer or foreman records.');
        if (rank === 1 && scope.excludeProfileIds?.some(id=>!permitted?.includes(id))) throw new Error('An excluded person is outside your report access. Choose installer or foreman records.');
        let excludedPeople: Array<{id:string;display_name:string}> = [];
        if (scope.excludeProfileIds?.length) {
          const { data, error } = await client.from('profiles').select('id,display_name').in('id',scope.excludeProfileIds);
          if (error || !data || data.length !== scope.excludeProfileIds.length) throw new Error('Could not verify every excluded person. Resolve their names again.');
          excludedPeople = data;
        }
        const rows = await readReportShifts(client,scope,permitted);
        const report = buildTimeReport(rows,scope,Date.now(),crypto.randomUUID(),rank);
        report.excludedPeople = excludedPeople.map(p=>({id:p.id,name:p.display_name}));
        artifacts.push(report);
        return { content: JSON.stringify({ reportId: report.id, generatedAt:report.generatedAt, from:scope.from, through:scope.through, groupBy:scope.groupBy, accessScope:report.accessScope, totals:report.totals, groups:report.groups.slice(0,30), groupCount:report.groups.length, excludedPeople, downloads:'The report card has real CSV and printable PDF controls. All rows are on the card, even if groups here are abbreviated.' }) };
      }
      if (name === 'get_crew_clock_status') {
        if (rank < 1) throw new Error('Live crew status requires foreman access.');
        const rows = await completeReportRows<{id:string;profile_id:string;project_id:string|null;clock_in_at:string;break_started_at:string|null;profiles:{display_name:string;role:string}|null;projects:{job_code:string;name:string}|null}>(offset =>
          client.from('time_shifts').select('id,profile_id,project_id,clock_in_at,break_started_at,profiles!profile_id(display_name,role),projects(job_code,name)',{count:'exact'})
            .eq('status','open').is('clock_out_at',null).order('clock_in_at').order('id').range(offset,offset+499), 2000);
        const permitted = rank < 2 ? new Set((await visiblePeople()).map(p=>p.id)) : null;
        const visible = permitted ? rows.filter(r=>permitted.has(r.profile_id)) : rows;
        return { content: JSON.stringify({ asOf:new Date().toISOString(), people:visible.map(r=>({name:r.profiles?.display_name ?? 'Unknown',job:r.projects ? `${r.projects.job_code} · ${r.projects.name}` : 'Unassigned',clockedInAt:r.clock_in_at,onBreak:!!r.break_started_at,breakStartedAt:r.break_started_at})), count:visible.length, note:'Open job clocks only; old open punches may need review. Unit work is not inferred from the job clock.' }) };
      }
      if (name === 'get_daily_report') {
        const day = String(args.day ?? '');
        if (!validDay(day)) throw new Error('Choose a valid report day.');
        const projectId = args.projectId;
        if (projectId !== null && projectId !== undefined && !validId(projectId)) throw new Error('Choose an exact job ID or leave it null.');
        const logs = await completeReportRows<{id:string;project_id:string;log_date:string;headline:string|null;notes:string;day_flow:string|null;reflection:unknown;weather:string|null;filed_by:string;updated_at:string;projects:{job_code:string;name:string}|null}>(offset=>{
          let query = client.from('daily_logs').select('id,project_id,log_date,headline,notes,day_flow,reflection,weather,filed_by,updated_at,projects(job_code,name)',{count:'exact'}).eq('log_date',day);
          if (projectId) query = query.eq('project_id',projectId);
          return query.order('id').range(offset,offset+499);
        });
        if (!logs.length) return { content: JSON.stringify({ day, report:null, message:'No filed daily report was found for that day and job.' }) };
        let candidates = logs.sort((a,b)=>b.updated_at.localeCompare(a.updated_at));
        if (!projectId) {
          const scope: ReportScope = {from:day,through:day,timeZone,profileIds:null,projectIds:null,groupBy:'job',includeProjects:true};
          const permitted = rank < 2 ? (await visiblePeople()).map(p=>p.id) : null;
          const shifts = await readReportShifts(client,scope,permitted);
          const worked = new Set(shifts.map(s=>s.project_id).filter(Boolean));
          candidates = logs.filter(l=>worked.has(l.project_id));
        }
        if (!candidates.length) return { content: JSON.stringify({ day, report:null, message:'No filed daily report belongs to a job with crew clock time on that day.' }) };
        const selected = candidates[0];
        const {data:contributions,error:contributionsError} = await client.from('daily_log_contributions')
          .select('id,actor_id,body,created_at').eq('log_id',selected.id).order('created_at');
        if (contributionsError) throw new Error('The daily report contributions could not be read. Try again.');
        return { content: JSON.stringify({ day, report:selected, contributions:contributions ?? [], otherMatchingJobs:candidates.slice(1).map(l=>({projectId:l.project_id,job:l.projects ? `${l.projects.job_code} · ${l.projects.name}` : l.project_id})), note:'The shared notes include added contributions. This is the filed daily log, not a generated summary of timecards.' }) };
      }
      if (name === 'prepare_unit_removal') {
        if (rank < 1) throw new Error('Only a foreman or above can remove units.');
        if (!validId(args.projectId)) throw new Error('Find the exact job first.');
        const codes = Array.isArray(args.unitCodes) ? args.unitCodes : [];
        if (!codes.length || codes.length > 20 || codes.some(c=>typeof c !== 'string' || !c.trim() || c.length > 100)) throw new Error('Choose 1–20 exact unit numbers.');
        const normalized = codes.map(c=>String(c).trim().toLocaleLowerCase());
        if (new Set(normalized).size !== normalized.length) throw new Error('A unit number was repeated.');
        const {data:project,error:projectError} = await client.from('projects').select('id,job_code,name').eq('id',args.projectId).is('deleted_at',null).maybeSingle();
        if (projectError || !project) throw new Error('The exact job could not be read.');
        const openings = await completeReportRows<{id:string;opening_code:string;status:string;assigned_window_id:string|null;work_started_at:string|null}>(offset=>
          client.from('project_openings').select('id,opening_code,status,assigned_window_id,work_started_at',{count:'exact'}).eq('project_id',project.id).is('removed_at',null).order('id').range(offset,offset+499));
        const matched = normalized.map(code=>openings.filter(o=>o.opening_code.trim().toLocaleLowerCase()===code));
        if (matched.some(rows=>rows.length!==1)) throw new Error('One or more unit numbers are missing or ambiguous on that job. Review the map and use exact codes.');
        const chosen = matched.map(rows=>rows[0]);
        if (chosen.some(o=>o.status==='installed' || o.assigned_window_id)) throw new Error('At least one unit is installed or has a warehouse unit assigned. Nothing was removed.');
        if (chosen.some(o=>o.work_started_at)) throw new Error('At least one unit already has work recorded. Nothing was removed.');
        const chosenIds = chosen.map(o=>o.id);
        const historyTables = [
          ['unit_sessions','opening_id'], ['task_sessions','opening_id'], ['install_events','project_opening_id'],
          ['qc_checks','project_opening_id'], ['custom_work_units','opening_id'],
        ] as const;
        const history = await Promise.all(historyTables.map(async ([table,column]) => {
          const {data,error} = await client.from(table).select(`id,${column}`).in(column,chosenIds).limit(21);
          if (error) throw new Error('Forge could not verify unit history. Nothing was removed.');
          return data ?? [];
        }));
        if (history.some(rows=>rows.length)) throw new Error('At least one selected unit has time, install, QC, or custom work history. Nothing was removed.');
        const {data:custom,error:customError} = await client.from('custom_work_units').select('id,label').eq('project_id',project.id).is('opening_id',null);
        if (customError) throw new Error('Custom units could not be checked. Nothing was removed.');
        if (custom?.some(u=>normalized.includes(u.label.trim().toLocaleLowerCase()))) throw new Error('A custom unit has the same number. Specify the mapped opening in Jobs; nothing was removed.');
        const review = {kind:'unit_removal_review' as const,id:crypto.randomUUID(),generatedAt:new Date().toISOString(),project,openings:chosen.map(o=>({id:o.id,code:o.opening_code,status:o.status}))};
        artifacts.push(review);
        return {content:JSON.stringify({reviewId:review.id,project:review.project,units:review.openings,note:'Review card prepared only. No unit was removed. The database will check for work history again when the person taps Remove.'})};
      }
      if (name === 'get_job_summary') {
        if (rank < 1) throw new Error('Whole-job labor summaries require foreman access. You can request your own hours.');
        if (!validId(args.projectId)) throw new Error('Find the exact job before requesting its summary.');
        const projectId = args.projectId;
        const {data:project,error} = await client.from('projects').select('id,name,job_code,status').eq('id',projectId).is('deleted_at',null).maybeSingle();
        if (error || !project) throw new Error('The job is unavailable or you do not have access.');
        const unavailable: string[] = [];
        const scope: ReportScope = { from:null,through:null,timeZone,profileIds:null,projectIds:[projectId],groupBy:'job',includeProjects:true };
        const permitted = rank < 2 ? (await visiblePeople()).map(p=>p.id) : null;
        const rows = await readReportShifts(client,scope,permitted);
        const [target,stages,logs] = await Promise.all([
          client.from('project_labor_targets').select('projected_hours,goal_hours,square_feet').eq('project_id',projectId).maybeSingle(),
          client.from('project_stage_progress').select('stage_key,completed,note,updated_at').eq('project_id',projectId),
          client.from('daily_logs').select('id,log_date,headline,notes').eq('project_id',projectId).order('log_date',{ascending:false}).order('id').limit(10),
        ]);
        if (target.error) unavailable.push('Labor targets could not be read.');
        if (stages.error) unavailable.push('Stage progress could not be read.');
        if (logs.error) unavailable.push('Daily logs could not be read.');
        unavailable.push('This summary does not yet read unit maps, materials, QC, service records or upcoming crews. Daily logs cover only the latest 10 records.');
        const report: JobSummaryArtifact = { kind:'job_summary',id:crypto.randomUUID(),generatedAt:new Date().toISOString(),project,
          labor:buildTimeReport(rows,scope,Date.now(),'summary',rank).totals,
          targets:target.error ? null : target.data,
          stages:stages.error ? [] : stages.data ?? [],logs:logs.error ? [] : logs.data ?? [],unavailable };
        artifacts.push(report);
        return { content:JSON.stringify(report) };
      }
      return {content:'This reporting tool is not installed.',is_error:true};
    } catch (error) {
      // Messages above are controlled; raw PostgREST errors never leave here.
      return {content:error instanceof Error ? error.message : 'Could not prepare the report. Try again.',is_error:true};
    }
  };
}
