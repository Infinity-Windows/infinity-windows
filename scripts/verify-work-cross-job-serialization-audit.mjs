// Read-only source extraction audit of unchanged legacy timestamp/payload codec.
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
const source=readFileSync(new URL('../supabase/migrations/20261108410000_work_activity_engine_cutover.sql',import.meta.url),'utf8');
const hash=s=>createHash('sha256').update(s).digest('hex');
assert.equal(hash(source),'aa767e67de301cd0ce5961758cc5afefe89bdf25fe27b3c4156a219c9cb2f648');
const {PGlite}=await import(process.env.PGLITE_MODULE);const db=new PGlite();const q=async(sql,args)=>(await db.query(sql,args)).rows[0];const bodies={};
for(const name of ['_work_activity_iso','_work_activity_clock_setup_digest']){const start=source.indexOf('create function public.'+name+'(');assert.ok(start>=0);const end=source.indexOf('$$;',start)+3;const body=source.slice(start,end);await db.exec(body);bodies[name]=hash(body)}
const digest=async()=>q("select _work_activity_clock_setup_digest('00000000-0000-4000-8000-000000000001',null,null,37.123456789,-111.987654321,'Original note Ω',null,'00000000-0000-4000-8000-000000000002','2026-01-02T03:04:05.123456Z','2026-01-02T03:04:06.123456Z',0) digest,_work_activity_iso('2026-01-02T03:04:05.123456Z') stamp");
const results=[];
for(const zone of ['UTC','America/Denver'])for(const digits of [1,-15]){await db.query("select set_config('TimeZone',$1,false),set_config('extra_float_digits',$2,false),set_config('DateStyle','SQL, DMY',false),set_config('IntervalStyle','sql_standard',false)",[zone,String(digits)]);results.push({zone,digits,...await digest()})}
assert.equal(results[0].digest,results[2].digest);assert.equal(results[1].digest,results[3].digest);assert.ok(results.every(x=>x.stamp==='2026-01-02T03:04:05.123456Z'));
const report={oldMigrationSha256:hash(source),sourceCreateHashes:bodies,results,timezoneStable:true,legacyFloatDigitsStable:results[0].digest===results[1].digest,scope:'Isolated unchanged source functions in PGlite; whole authorized clock request timezone controls are separate. No old-source change or provider proof.'};
if(process.env.WORK_CROSS_JOB_SERIALIZATION_REPORT_OUT)writeFileSync(process.env.WORK_CROSS_JOB_SERIALIZATION_REPORT_OUT,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));await db.close();
