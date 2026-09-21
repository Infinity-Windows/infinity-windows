import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1';
import { buildTimeReport, completeReportRows, parseReportScope, reportBounds, validId, type AskArtifact, type JobSummaryArtifact, type ReportScope, type ReportShift } from '../_shared/askReporting.ts';

// Deliberately no service-role client. Authentication/rank/partner checks happen
// before this executor is constructed; the queries also retain caller RLS.
const SHIFT_FIELDS = 'id,profile_id,project_id,cost_code_id,clock_in_at,clock_out_at,break_seconds,break_started_at,status,created_at,note,source_import,injured,time_confirmed,profiles!profile_id(display_name),projects(job_code,name),cost_codes(code,label)';
export async function readReportShifts(client: SupabaseClient, scope: ReportScope): Promise<ReportShift[]> {
  const bounds = reportBounds(scope);
  const rows = await completeReportRows<ReportShift>(offset => {
    let q = client.from('time_shifts').select(SHIFT_FIELDS, { count: 'exact' }).neq('status', 'voided');
    if (bounds.since) q = q.gte('clock_in_at', bounds.since);
    if (bounds.until) q = q.lt('clock_in_at', bounds.until);
    if (scope.profileIds) q = q.in('profile_id', scope.profileIds);
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
  return async (name: string, input: unknown): Promise<{ content: string; is_error?: boolean }> => {
    try {
      if (artifacts.length >= 4) return { content: 'Four reports are ready. Download them or request additional reports in a new message.', is_error: true };
      const args = input && typeof input === 'object' ? input as Record<string, unknown> : {};
      if (name === 'find_report_records') {
        if (!['people','jobs'].includes(String(args.kind)) || typeof args.search !== 'string' || args.search.length > 100) throw new Error('Choose people or jobs and a short search term.');
        const people = args.kind === 'people';
        const rows = await completeReportRows<{id:string; display_name?:string; name?:string; job_code?:string; status?:string}>(offset => {
          let q = client.from(people ? 'profiles' : 'projects').select(people ? 'id,display_name' : 'id,name,job_code,status', {count:'exact'});
          if (people && rank < 1) q = q.eq('id',userId);
          if (!people) q = q.is('deleted_at',null);
          return q.order('id').range(offset, offset+499);
        });
        const search = args.search.trim().toLocaleLowerCase();
        const matches = rows.filter(r=>[r.display_name,r.name,r.job_code].some(v=>v?.toLocaleLowerCase().includes(search)));
        return { content: JSON.stringify({ records: matches.slice(0,60), matches: matches.length, more: matches.length > 60, instruction: matches.length > 60 ? 'Narrow the search; this is not the complete matching list.' : 'Resolve ambiguous names with the user. Do not infer payroll inclusion.' }) };
      }
      if (name === 'get_hours_report') {
        const scope = parseReportScope(input,timeZone,userId,rank);
        const rows = await readReportShifts(client,scope);
        const report = buildTimeReport(rows,scope,Date.now(),crypto.randomUUID(),rank);
        artifacts.push(report);
        return { content: JSON.stringify({ reportId: report.id, generatedAt:report.generatedAt, scope:report.scope, accessScope:report.accessScope, totals:report.totals, groups:report.groups.slice(0,60), groupCount:report.groups.length, people:report.people, jobs:report.jobs, downloads:'The report card has real CSV and printable PDF controls. All rows are on the card, even if groups here are abbreviated.' }) };
      }
      if (name === 'get_job_summary') {
        if (rank < 1) throw new Error('Whole-job labor summaries require foreman access. You can request your own hours.');
        if (!validId(args.projectId)) throw new Error('Find the exact job before requesting its summary.');
        const projectId = args.projectId;
        const {data:project,error} = await client.from('projects').select('id,name,job_code,status').eq('id',projectId).is('deleted_at',null).maybeSingle();
        if (error || !project) throw new Error('The job is unavailable or you do not have access.');
        const unavailable: string[] = [];
        const scope: ReportScope = { from:null,through:null,timeZone,profileIds:null,projectIds:[projectId],groupBy:'job',includeProjects:true };
        const rows = await readReportShifts(client,scope);
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
