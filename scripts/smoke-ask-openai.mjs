// Explicit, bounded live-provider test with synthetic records only.
// OPENAI_API_KEY must be in the process environment; never print it.
import assert from 'node:assert/strict';
import { openaiAsk } from '../supabase/functions/_shared/openaiAsk.ts';
import { ASK_SYSTEM_PROMPT } from '../supabase/functions/_shared/knowledge.ts';
import { REPORTING_TOOLS, REPORTING_SYSTEM_PROMPT, buildTimeReport, parseReportScope } from '../supabase/functions/_shared/askReporting.ts';
if (!process.argv.includes('--live')) { console.log('Opt-in test: node --experimental-strip-types scripts/smoke-ask-openai.mjs --live'); process.exit(0); }
const apiKey=process.env.OPENAI_API_KEY;if(!apiKey)throw new Error('Configure OPENAI_API_KEY without printing it.');
const person='10000000-0000-4000-8000-000000000001',job='20000000-0000-4000-8000-000000000001';
const row={id:'s1',profile_id:person,project_id:job,cost_code_id:null,clock_in_at:'2026-09-01T13:00:00Z',clock_out_at:'2026-09-01T21:30:00Z',break_seconds:1800,break_started_at:null,status:'submitted',created_at:'2026-09-01T13:00:00Z',injured:null,time_confirmed:null,profiles:{display_name:'Alex Fixture'},projects:{job_code:'FIXTURE',name:'Fixture job'}};
const cases=[
 {name:'daily employee export',question:'Export all crew hours September 1 through September 15, 2026, day by day per employee. No projects on the report.',expected:'get_hours_report'},
 {name:'Spanish hours report',question:'Muéstrame las horas de todo el equipo del 1 al 15 de septiembre de 2026, por empleado, sin proyectos.',expected:'get_hours_report'},
 {name:'completed job summary',question:'Give me a summary of the completed Fixture job.',expected:'get_job_summary'},
];
for(const fixture of cases){
 let report=null;const calls=[];
 try{
 const result=await openaiAsk({apiKey,model:'gpt-5.6-terra',system:ASK_SYSTEM_PROMPT+REPORTING_SYSTEM_PROMPT+'\nReport time zone America/Denver. Current date 2026-09-21. Caller is a supervisor.',messages:[{role:'user',content:fixture.question}],tools:REPORTING_TOOLS,executeTool:async(name,input)=>{
  calls.push(name);
  if(name==='find_report_records')return{content:JSON.stringify({records:[{id:job,name:'Fixture job',job_code:'FIXTURE',status:'completed'}],more:false})};
  if(name==='get_hours_report'){
   const scope=parseReportScope(input,'America/Denver',person,2);assert.equal(scope.from,'2026-09-01');assert.equal(scope.through,'2026-09-15');assert.equal(scope.profileIds,null);assert.equal(scope.projectIds,null);assert.equal(scope.includeProjects,false);
   report=buildTimeReport([row],scope,Date.parse('2026-09-21T20:00:00Z'),'test-report',2);return{content:JSON.stringify({reportId:report.id,scope:report.scope,totals:report.totals,groups:report.groups,downloads:'CSV and PDF controls are attached to the report card.'})};
  }
  if(name==='get_job_summary'){assert.equal(input.projectId,job);return{content:JSON.stringify({kind:'job_summary',project:{id:job,name:'Fixture job',status:'completed'},labor:{recordedHours:8},targets:{projected_hours:10,goal_hours:9},stages:[],logs:[],unavailable:['No unit counts supplied.']})};}
  return{content:'Unsupported tool',is_error:true};
 }});
 assert(calls.includes(fixture.expected));assert(!result.truncated);assert(result.text.length>0);if(report)assert.equal(report.totals.recordedHours,8);
 console.log(JSON.stringify({case:fixture.name,passed:true,calls,rounds:result.rounds,usage:result.usage}));
 }catch(e){console.log(JSON.stringify({case:fixture.name,passed:false,error:e instanceof Error?e.message:'Test failed'}));process.exitCode=1;}
}
