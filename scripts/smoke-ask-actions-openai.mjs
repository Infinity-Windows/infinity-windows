// Opt-in provider checks; all tool results are synthetic and no app writes occur.
import assert from 'node:assert/strict';
import { openaiAsk } from '../supabase/functions/_shared/openaiAsk.ts';
import { ASK_SYSTEM_PROMPT } from '../supabase/functions/_shared/knowledge.ts';
import { JOB_PROPOSAL_TOOL, ACTIONS_SYSTEM_PROMPT, parseNewJob } from '../supabase/functions/_shared/askActions.ts';
import { SCHEDULING_TOOLS, SCHEDULING_SYSTEM_PROMPT, parseDraftEntriesInput } from '../supabase/functions/_shared/schedulingTools.ts';
if (!process.argv.includes('--live')) { console.log('Pass --live to test with synthetic records.'); process.exit(0); }
const apiKey=process.env.OPENAI_API_KEY;
if(!apiKey)throw new Error('Configure OPENAI_API_KEY securely.');
const job='20000000-0000-4000-8000-000000000001',person='10000000-0000-4000-8000-000000000001';
const cases=[
 {name:'job review',question:'Create a new job called Example House, code EXAMPLE-HOUSE, at 123 Example Street. Projected labor 200 hours, foreman goal 180 hours. No other details yet.',expected:'prepare_new_job'},
 {name:'missing job details',question:'Create a new job for me. I have not supplied its name or job code yet.',expected:null},
 {name:'schedule review',question:'Draft Alex Fixture onto the Fixture job on October 5, 2026. I want a one-person crew for this service visit. Let me review before publishing.',expected:'draft_assignments'},
];
for(const fixture of cases){
 const calls=[];
 try{
 const result=await openaiAsk({apiKey,model:'gpt-5.6-terra',system:ASK_SYSTEM_PROMPT+SCHEDULING_SYSTEM_PROMPT+ACTIONS_SYSTEM_PROMPT+'\nCaller is a supervisor. Today is 2026-09-21. All records below are synthetic fixtures.',messages:[{role:'user',content:fixture.question}],tools:[JOB_PROPOSAL_TOOL,...SCHEDULING_TOOLS],executeTool:async(name,input)=>{
  calls.push(name);
  if(name==='prepare_new_job'){
   const details=parseNewJob(input,2);assert.equal(details.name,'Example House');assert.equal(details.jobCode,'EXAMPLE-HOUSE');assert.equal(details.projectedHours,200);assert.equal(details.goalHours,180);assert.equal(details.contactEmail,null);
   return{content:JSON.stringify({kind:'job_proposal',id:'fixture-preview',details,similarJobs:[],instruction:'Preview only. The attached Create job button must be clicked before anything is saved.'})};
  }
  if(name==='get_scheduling_picture')return{content:JSON.stringify({active_jobs:[{id:job,code:'FIXTURE',name:'Fixture job',ready_state:'ready',estimate:{expected_minutes:240,recommended_crew:1}}],crew:[{id:person,display_name:'Alex Fixture',role:'foreman',skill_level:4,active:true,booked:[],capabilities:[]}],time_off:[],drafts:[]})};
  if(name==='draft_assignments'){
   assert.equal(calls[0],'get_scheduling_picture');const parsed=parseDraftEntriesInput(input);assert.equal(parsed.formatError,null);assert.deepEqual(parsed.errors,[]);assert.deepEqual(parsed.entries,[{project_id:job,profile_id:person,date:'2026-10-05'}]);
   return{content:JSON.stringify({assignmentCount:1,published:false,status:'draft',instruction:'Review card attached. Nothing has been published.'})};
  }
  throw new Error('Unexpected action in this scenario.');
 }});
 if(fixture.expected)assert(calls.includes(fixture.expected));else assert.equal(calls.length,0);
 assert(!result.truncated);assert(result.text.length>0);
 console.log(JSON.stringify({case:fixture.name,passed:true,calls,rounds:result.rounds,usage:result.usage}));
 }catch(e){console.log(JSON.stringify({case:fixture.name,passed:false,error:e instanceof Error?e.message:'Failed'}));process.exitCode=1;}
}
