// Daily-log progress regressions using real migrations in disposable SQL.
// Synthetic records only. PGLITE_MODULE selects the existing test runtime.
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
const {PGlite}=await import(process.env.PGLITE_MODULE ?? '@electric-sql/pglite');
const root=fileURLToPath(new URL('../',import.meta.url));
const db=new PGlite(); const evidence={checkedAt:new Date().toISOString(),files:{},checks:[]};
async function source(p){const s=await readFile(`${root}/${p}`,'utf8');evidence.files[p]=createHash('sha256').update(s).digest('hex');return s;}
await db.exec(await source('scripts/tests/ai-daily-logs/setup.sql'));
for(const n of ['20260949000000_daily_logs.sql','20260951000000_share_with_builder.sql','20261014000000_installer_daily_reporting.sql'])await db.exec(await source(`supabase/migrations/${n}`));
const fieldMigration=await source('supabase/migrations/20261024000000_ai_field_operations.sql');
const visible=/create function public\._ai_job_visible[\s\S]*?\n\$\$;/.exec(fieldMigration);
if(!visible)throw new Error('AI job visibility helper missing from its migration');
await db.exec(visible[0]);
await db.exec('set check_function_bodies=off');
for(const n of ['20261030000000_ai_daily_log_contributions.sql','20261052000000_daily_log_revision_guard.sql'])await db.exec(await source(`supabase/migrations/${n}`));
await db.exec('set check_function_bodies=on');
const migration=await source('supabase/migrations/20261060000000_daily_log_progress_fields.sql');await db.exec(migration);
await db.exec('grant select on daily_logs to authenticated');
const actor='00000000-0000-4000-8000-000000000001',job='00000000-0000-4000-8000-000000000090';
await db.query("insert into profiles(id,role,display_name) values($1,'installer','Synthetic installer')",[actor]);await db.query("insert into projects(id,name) values($1,'Synthetic job')",[job]);await db.query("select set_config('request.jwt.claim.sub',$1,false)",[actor]);await db.exec('set role authenticated');
let day=0;
async function call(extra){day++;return(await db.query(`select * from file_daily_log($1,current_date-${day},p_notes=>'Synthetic progress validation',p_expected_revision=>0,${extra})`,[job])).rows[0];}
async function reject(name,extra){try{const r=await call(extra);evidence.checks.push({name,pass:false,accepted:{stage:r.stage_progress,delays:r.delays,needs:r.missing_tomorrow}});}catch(e){evidence.checks.push({name,pass:true,error:e.message});}}
await reject('stage JSON string refused',`p_progress_provided=>true,p_stage_progress=>'{"frames":"50"}'::jsonb`);
await reject('stage JSON null refused',`p_progress_provided=>true,p_stage_progress=>'{"frames":null}'::jsonb`);
await reject('negative units refused',`p_progress_provided=>true,p_units_remaining=>-1`);
await reject('null array stage refused',`p_progress_provided=>true,p_work_stages=>array[null]::text[]`);
await reject('non-text delay description refused',`p_progress_provided=>true,p_delays=>'[{"description":123,"status":"happened","attribution":"forge"}]'::jsonb`);
await reject('non-text material description refused',`p_progress_provided=>true,p_missing_tomorrow=>'[{"description":123}]'::jsonb`);
const ignored=await call(`p_progress_provided=>false,p_work_stages=>array['not_a_window_stage'],p_stage_progress=>'{"frames":-500}'::jsonb,p_tomorrow_plan=>'Should be ignored'`);
evidence.checks.push({name:'false presence flag ignores fields even on insert',pass:ignored.work_stages.length===0&&Object.keys(ignored.stage_progress).length===0&&ignored.tomorrow_plan===null,accepted:{work:ignored.work_stages,stage:ignored.stage_progress,plan:ignored.tomorrow_plan}});
const zero=await call(`p_progress_provided=>true,p_stage_progress=>'{"frames":0}'::jsonb,p_units_remaining=>0`);evidence.checks.push({name:'zero is preserved distinct from unknown',pass:zero.units_remaining===0&&zero.units_to_date===null&&zero.stage_progress.frames===0});
const before=await call(`p_progress_provided=>true,p_units_to_date=>10,p_units_remaining=>10,p_stage_progress=>'{"frames":50}'::jsonb`);
const legacy=(await db.query(`select * from file_daily_log($1,$2,p_notes=>'Legacy update',p_expected_revision=>$3)`,[job,before.log_date,before.revision])).rows[0];evidence.checks.push({name:'legacy text-only update retains structured snapshot',pass:legacy.units_to_date===10&&legacy.units_remaining===10&&legacy.stage_progress.frames===50});
try {
 await db.query(`select * from file_daily_log($1,$2,p_notes=>'Stale overwrite',p_expected_revision=>$3,p_progress_provided=>true,p_units_remaining=>0)`,[job,before.log_date,before.revision]);
 evidence.checks.push({name:'stale revision cannot overwrite structured facts',pass:false});
} catch(e) { evidence.checks.push({name:'stale revision cannot overwrite structured facts',pass:e.code==='40001',error:e.message}); }
const append=(await db.query(`select append_daily_log_contribution($1,$2,$3,$4,$5,'{"work_completed":{"status":"captured","value":"Checked hardware"}}'::jsonb,'Checked hardware') r`,['00000000-0000-4000-8000-000000000110',actor,job,before.log_date,legacy.revision])).rows[0].r;
const afterAI=(await db.query('select * from daily_logs where id=$1',[legacy.id])).rows[0];
evidence.checks.push({name:'AI additive contribution preserves structured progress',pass:append.status==='saved'&&afterAI.units_to_date===10&&afterAI.units_remaining===10&&afterAI.stage_progress.frames===50&&afterAI.notes.includes('Checked hardware')});
const cleared=(await db.query(`select * from file_daily_log($1,$2,p_notes=>'Explicit clear',p_expected_revision=>$3,p_progress_provided=>true)`,[job,before.log_date,afterAI.revision])).rows[0];evidence.checks.push({name:'current full snapshot can explicitly clear',pass:cleared.units_to_date===null&&cleared.units_remaining===null&&Object.keys(cleared.stage_progress).length===0});
await db.exec('reset role');
for (const [name,column] of [['retired actor','retired_at'],['revoked actor','access_revoked_at']]) {
 await db.query(`update profiles set ${column}=now() where id=$1`,[actor]);await db.exec('set role authenticated');
 await reject(`${name} cannot file new progress`, `p_progress_provided=>true,p_units_remaining=>2`);
 await db.exec('reset role');await db.query(`update profiles set ${column}=null where id=$1`,[actor]);
}
await db.query('update profiles set partner=true where id=$1',[actor]);await db.exec('set role authenticated');
await reject('partner cannot file progress', `p_progress_provided=>true,p_units_remaining=>2`);
await db.exec('reset role');await db.query('update profiles set partner=false where id=$1',[actor]);
try{await db.exec(migration);evidence.checks.push({name:'migration replay succeeds',pass:true});}catch(e){evidence.checks.push({name:'migration replay succeeds',pass:false,error:e.message});}
await db.close();console.log(JSON.stringify(evidence.checks,null,2));if(process.argv[2])await writeFile(process.argv[2],JSON.stringify(evidence,null,2));if(evidence.checks.some(x=>!x.pass))process.exitCode=1;
