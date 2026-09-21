// Caller-scoped query/executor contract. Synthetic data only, no live database.
import assert from 'node:assert/strict';
import { reportingExecutor,readReportShifts } from '../supabase/functions/ask/operations.ts';
const user='10000000-0000-4000-8000-000000000001';
const other='10000000-0000-4000-8000-000000000002';
const job='20000000-0000-4000-8000-000000000001';
const filters={from:'2026-09-01',through:'2026-09-15',profileIds:null,projectIds:null,groupBy:'employee',includeProjects:false};
const row={id:'s1',profile_id:user,project_id:null,cost_code_id:null,clock_in_at:'2026-09-01T13:00:00Z',clock_out_at:'2026-09-01T21:30:00Z',break_seconds:1800,break_started_at:null,status:'submitted',created_at:'2026-09-01T13:00:00Z',injured:null,time_confirmed:null};
function mock(dataByTable={}) {
 const calls=[];
 const client={from(table){const ops=[];const q={then(resolve,reject){return Promise.resolve(typeof dataByTable[table]==='function'?dataByTable[table](ops):dataByTable[table]??{data:[],count:0,error:null}).then(resolve,reject)}};
  for(const op of ['select','eq','is','neq','gte','lt','in','or','order','range','maybeSingle','limit'])q[op]=(...args)=>{ops.push([op,...args]);return q;};calls.push({table,ops});return q;}};
 return {client,calls};
}
{
 const {client,calls}=mock({time_shifts:{data:[row],count:1,error:null}});const artifacts=[];
 const execute=reportingExecutor(client,user,0,'America/Denver',artifacts);
 const result=await execute('get_hours_report',filters);assert(!result.is_error);assert.equal(artifacts[0].totals.recordedHours,8);
 assert(calls[0].ops.some(op=>op[0]==='in'&&op[1]==='profile_id'&&op[2][0]===user));
 assert(calls[0].ops.some(op=>op[0]==='gte'&&op[2]==='2026-09-01T06:00:00.000Z'));
 assert(calls[0].ops.some(op=>op[0]==='lt'&&op[2]==='2026-09-16T06:00:00.000Z'));
 const before=calls.length;assert((await execute('get_hours_report',{...filters,profileIds:[other]})).is_error);assert.equal(calls.length,before);
 assert((await execute('get_job_summary',{projectId:job})).is_error);assert.equal(calls.length,before);
}
{
 const {client,calls}=mock();await readReportShifts(client,{...filters,timeZone:'America/Denver',projectIds:[job,'unassigned']});
 assert(calls[0].ops.some(op=>op[0]==='or'&&op[1]===`project_id.is.null,project_id.in.(${job})`));
 assert(!calls.some(c=>c.table==='custom_unit_sessions')); // unit clocks never add to parent labor
}
{
 const {client}=mock({time_shifts:{data:[row],count:1,error:null},projects:{data:{id:job,job_code:'DONE',name:'Completed',status:'completed'},error:null},project_labor_targets:{data:null,error:{message:'private'}},project_stage_progress:{data:[],error:null},daily_logs:{data:[],error:null}});
 const artifacts=[];const result=await reportingExecutor(client,user,2,'America/Denver',artifacts)('get_job_summary',{projectId:job});
 assert(!result.is_error);assert.equal(artifacts[0].project.status,'completed');assert(artifacts[0].unavailable.includes('Labor targets could not be read.'));assert(!result.content.includes('private'));
}
{
 const {client}=mock({time_shifts:{data:[],count:null,error:{message:'private_database_details'}}});const artifacts=[];
 const result=await reportingExecutor(client,user,2,'America/Denver',artifacts)('get_hours_report',filters);
 assert(result.is_error);assert.equal(artifacts.length,0);assert(!result.content.includes('private_database'));
}
{
 const original={'First Name':'Alex',Project:'Awaiting assignment',Rate:'PRIVATE_RATE',SSN:'PRIVATE_ID'};
 const imported={...row,source_import:{source:'busybusy',file:'fixture.csv',row:1,timeZone:'America/Denver',original}};
 const {client}=mock({time_shifts:{data:[imported],count:1,error:null}});
 const rows=await readReportShifts(client,{...filters,timeZone:'America/Denver'});
 assert.equal(rows[0].source_import.original.Project,'Awaiting assignment');
 assert(!JSON.stringify(rows).includes('PRIVATE_'));
}
console.log('Ask reporting: caller scope, dates, mixed jobs, completed jobs, and failure handling passed.');
