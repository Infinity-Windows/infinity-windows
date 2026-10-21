#!/usr/bin/env python3
"""Genuine PG17 contributor roles, source races and active-read payroll wait.
Requires frozen0844/0845 already installed by their existing genuine fixtures.
No provider access. --check-plan is static validation, not execution proof.
"""
import hashlib,json,os,re,subprocess,sys,time,statistics
from pathlib import Path
from urllib.parse import urlparse,urlunparse
ROOT=Path(__file__).resolve().parent.parent
source=(ROOT/'supabase/migrations/20261108460000_work_unit_contributors.sql').read_text()
sha=hashlib.sha256(source.encode()).hexdigest()
assert re.search(r'rollback;\s*$',source)
assert hashlib.sha256((ROOT/'supabase/migrations/20261108450000_work_activity_totals.sql').read_bytes()).hexdigest()=='e0e74c2d1985d332af81f95d20d2a6625c40cb5fcf995b4aa6e267d75e092140'
assert hashlib.sha256((ROOT/'scripts/verify-work-activity-totals-postgres.py').read_bytes()).hexdigest()=='56aad36c448a5cecc81faece81b77b8f339e1bc29ff736bec1edf1677627b3c0'
assert sys.argv[1:] in ([],['--check-plan'])
if sys.argv[1:]==['--check-plan']:
 print(json.dumps({'result':'PLAN VALIDATED','databaseTests':False,'sourceSha256':sha,'predecessor':'verify-work-activity-totals-postgres.py','tiers':[[0,0],[1000,100],[10000,1000]],'baselineCensus':'pre-existing history/live/transition totals recorded separately','seedBatchSize':100,'waits':['actual project hide holdsG then read rechecks','actual actor role revoke holdsG then admission rechecks','actual profile rename holdsG then name refreshes','real active contributor RPC holdingG/7710 versus actual start_break; max2 attempts, no idle holder'],'timeoutsSeconds':{'statement':20,'lock':12},'requiredEvidence':['actual authenticator/postgres session_user','column/namespace/function ACL drift','EXPLAIN ANALYZE BUFFERS','median/p95/max','pg_blocking_pids active holder','payroll break/resume/out success']}));sys.exit()
p=urlparse(os.environ.get('WORK_ACTIVITY_ROLE_TEST_DB_URL',''))
if p.scheme not in ('postgres','postgresql') or p.hostname not in ('localhost','127.0.0.1') or p.port not in (None,5432) or p.path!='/forge_work_activity_role_test' or p.username!='supabase_admin' or p.query or p.fragment:raise SystemExit('Refused: exact disposable localhost role fixture required')
env={k:v for k,v in os.environ.items() if not k.startswith('PG')};env['PGCONNECT_TIMEOUT']='3'
def uri(user):return urlunparse((p.scheme,f'{user}:fixture-only@{p.hostname}:{p.port or 5432}',p.path,'','',''))
def lit(v):return 'null' if v is None else "'"+str(v).replace("'","''")+"'"
def ident(n):return '00000000-0000-4000-8000-'+str(450000+n).zfill(12)
checks=0
SEED_BATCH_SIZE=100
report={'sourceSha256':sha,'harnessSha256':hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),'scope':'Actual PG17 disposable localhost roles; no provider operations','timeoutsSeconds':{'statement':20,'lock':12},'status':'running','stage':'source_and_setup','seedBatchSize':SEED_BATCH_SIZE,'seedBatches':[],'committedInsertedRows':{'project_openings':0,'opening_phases':0,'personal_activity_transition_sources':0},'verifiedSeedCounts':None,'tiers':[],'activeReadPayrollWaits':{},'activeReadWaitGate':{}}
def persist(stage=None):
 if stage is not None:report['stage']=stage
 report['checks']=checks
 if os.environ.get('WORK_UNIT_CONTRIBUTORS_VOLUME_OUT'):
  target=Path(os.environ['WORK_UNIT_CONTRIBUTORS_VOLUME_OUT']);temporary=target.with_name(target.name+'.tmp')
  temporary.write_text(json.dumps(report,indent=2)+'\n');temporary.replace(target)
def preserve_failure(kind,error,traceback):
 report['status']='failed';report['failure']={'type':kind.__name__,'message':str(error)[-2200:]};persist()
 sys.__excepthook__(kind,error,traceback)
sys.excepthook=preserve_failure
persist()
def run(sql,user='postgres',error=None):
 global checks
 r=subprocess.run(['psql',uri(user),'-X','-q','-t','-A','-v','ON_ERROR_STOP=1'],input="\\set VERBOSITY verbose\nset statement_timeout='20s';set lock_timeout='12s';"+sql,text=True,capture_output=True,timeout=30,env=env)
 if error:assert r.returncode and re.search(r'\b'+error+r'\b',r.stderr),(error,r.stderr[-2000:]);checks+=1;return
 assert r.returncode==0,r.stderr[-2200:];return r.stdout.strip()
def obj(sql,user='postgres'):return json.loads(run(sql,user).splitlines()[-1])
def check(value,label):
 global checks
 assert value,label;checks+=1;persist();print('PASS',checks,label,flush=True)
def auth(actor):return 'set role authenticated;set request.jwt.claim.sub='+lit(actor)+';'
worker,reviewer,job,other,opening,unit,device,generation=[ident(x) for x in (1,2,10,11,20,30,40,41)]
def rpc(sql,actor=worker):return obj(auth(actor)+sql,'authenticator')
def contributors(actor=worker):return rpc('select work_unit_contributors_read('+lit(job)+','+lit(unit)+',1);',actor)
check(run("select session_user='postgres' and not (select rolsuper from pg_roles where rolname=session_user)")=='t','Actual nonsuperuser owner session')
check(run("select session_user='authenticator' and not (select rolsuper or rolinherit from pg_roles where rolname=session_user)",'authenticator')=='t','Actual noninheriting authenticator session')
check(run("select current_setting('server_version_num')::int/10000")=='17','Actual PostgreSQL17')
check(run('select _work_unit_review_coverage() and _work_totals_coverage()')=='t','Frozen review and totals source guards')
namespace_preflight=source[source.index('do $namespace$'):source.index('end $namespace$;')+len('end $namespace$;')]
for ddl in ("create function work_unit_contributors_read(text) returns int language sql as 'select 1'","create function _work_unit_contributors_unknown() returns int language sql as 'select 1'",'create table _work_unit_contributors_unknown(id int)'):
 run('begin;'+ddl+';'+namespace_preflight,error='55000')
check(run("select to_regprocedure('work_unit_contributors_read(uuid,uuid,integer)') is null")=='t','Clean namespace after all refused preflights')
run(re.sub(r'rollback;\s*$','commit;',source))
check(run('select _work_unit_review_coverage() and _work_totals_coverage() and _work_unit_contributors_coverage()')=='t','All three exact source guards admit genuine installed candidate')
for ddl in ('grant execute on function _work_unit_contributors_shift(uuid,uuid,timestamptz,jsonb) to authenticated','grant execute on function work_unit_contributors_read(uuid,uuid,integer) to service_role','grant select(profile_id) on work_activity_safety_events to public',"create function work_unit_contributors_read(text) returns int language sql as 'select 1'",'create table _work_unit_contributors_unknown(id int)','alter function _work_unit_contributors_person(uuid,jsonb,text[],numeric,text[]) strict'):
 check(run('begin;'+ddl+';select not _work_unit_contributors_coverage();rollback;')=='t','Actual contributor catalog drift refuses: '+ddl)
check(run('select _work_unit_contributors_coverage()')=='t','Metadata rollback restores new exact guard')
report['baselineCensus']=obj("select jsonb_build_object('retainedHistory',(select count(*) from work_activity_source_history),'liveSources',(select count(*) from _work_unit_review_live_sources),'transitionSources',(select count(*) from personal_activity_transition_sources))");persist()
run('insert into auth.users(id) values('+lit(worker)+'),('+lit(reviewer)+');insert into profiles(id,display_name,role,is_test) values('+lit(worker)+",'Contributors PG worker','owner',false),("+lit(reviewer)+",'Contributors PG reviewer','owner',false);insert into projects(id,job_code,name) values("+lit(job)+",'CONTRIBUTORS-PG','Synthetic'),("+lit(other)+",'CONTRIBUTORS-PG-OTHER','Synthetic');insert into project_openings(id,project_id,opening_code) values("+lit(opening)+','+lit(job)+",'CONTRIBUTORS-PG-UNIT'),("+lit(ident(21))+','+lit(other)+",'CONTRIBUTORS-PG-UNRELATED');")
unit_payload={'id':unit,'revision':0,'project_id':job,'opening_id':opening,'label':'Synthetic PG totals','type_label':'Window','facts':{},'dimension_observation':{'width':36,'height':48,'unit':'in','source':'estimated'},'expected_fact_revision':0}
check(rpc('select to_jsonb(custom_work_command('+lit(ident(100))+",'unit',"+lit(json.dumps(unit_payload))+'::jsonb));')==unit,'UUID-returning custom unit command is explicitly serialized as JSON')
rpc('select work_publish_activity_version('+lit(ident(101))+",'contributors_pg_specific',0,'specific','Contributors PG','Contributors PG',false,'[]');")
definition=obj("select to_jsonb(v) from work_activity_definition_versions v join work_activity_definitions d on d.id=v.definition_id where d.code='contributors_pg_specific'")
rpc('select work_publish_menu_version('+lit(ident(102))+",'contributors_pg_menu',0,'Contributors PG','Contributors PG',"+lit(json.dumps([{'definitionId':definition['definition_id'],'versionId':definition['id'],'position':0,'enabled':True}]))+'::jsonb);')
menu=run("select v.id from work_capture_menu_versions v join work_capture_menus m on m.id=v.menu_id where m.code='contributors_pg_menu'")
rpc('select work_select_job_menu('+lit(ident(103))+','+lit(job)+','+lit(menu)+',0);')
selection=obj('select to_jsonb(s) from work_job_menu_selections s where project_id='+lit(job))
run('begin;select _work_activity_gate();update work_activity_authority_generation set capture_enabled=true,revision=revision+1;commit;')
def sign_toolbox(actor,command_id):
 result=rpc('select to_jsonb(sign_toolbox_talk('+lit(command_id)+','+lit(actor)+",null::uuid,'Synthetic signature',null::text,null::text,'Synthetic local fixture',clock_timestamp()));",actor)
 check(result['profile_id']==actor,'Actual authenticated toolbox signing entry accepts its own synthetic signer')
sign_toolbox(worker,ident(107))
shift=rpc('select to_jsonb(clock_in('+lit(job)+'::uuid,null::uuid,null::text,null::double precision,null::double precision,null::text,null::text,'+lit(ident(104))+"::uuid,clock_timestamp()-interval '1 minute',clock_timestamp(),0,1));")['id']
seq=0;head=None

def command(intent):
 global seq,head
 snap=rpc('select work_activity_snapshot('+lit(device)+');');cid=ident(200+seq)
 stamp=run("select to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"')")
 payload={'deviceId':device,'clientGeneration':generation,'clientSequence':seq,'predecessorCommandId':head,'expectedRevision':snap['state']['revision'],'basis':{'observationId':snap['observation']['id']},'shiftRef':snap['observation']['shiftRef'],'tappedAt':stamp,'clockCheckedAt':stamp,'clockSkewMs':0,'intent':intent}
 answer=rpc('select work_activity_command('+lit(cid)+',1,'+lit(json.dumps(payload))+'::jsonb);');assert answer['receipt']['status'] in ('noop','applied'),answer;head=cid;seq+=1;return answer
command({'kind':'establish_stream','previousGeneration':None,'previousHeadCommandId':None})
command({'kind':'finish_setup','projectId':job,'costCodeId':None})
unit_view=rpc('select work_activity_unit_basis('+lit(unit)+');')['unit']
check(unit_view['id']==unit and unit_view['eligibleForCapture'],'Actual authenticated unit-basis read authorizes the switch')
basis={key:unit_view[key] for key in ('id','operationalRevision','incarnationEpoch','bindingEpoch','projectEpoch','openingEpoch')}
basis.update({'factId':unit_view['fact']['id'],'factRevision':unit_view['fact']['revision'],'originProjectEpoch':unit_view['fact']['originProjectEpoch'],'originOpeningEpoch':unit_view['fact']['originOpeningEpoch']})
command({'kind':'switch','projectId':job,'selectionId':selection['id'],'selectionRevision':selection['revision'],'menuVersionId':menu,'definitionVersionId':definition['id'],'scope':'specific','unit':basis,'machineKind':None,'values':{}})
check(contributors()['contributors']['includesLive'],'Actual own confirmed live contributor interval')
other_view=contributors(reviewer)
check(other_view['availability']=='available' and other_view['contributors']['unitKnownMicros']=='0' and not other_view['contributors']['includesLive'],'Other actor receives no guessed current elapsed')
check('open_shift' in other_view['contributors']['completenessReasons'],'Other open shift is explicitly partial')
for role in ('anon','service_role'):
 run('set role '+role+';set request.jwt.claim.sub='+lit(worker)+';select work_unit_contributors_read('+lit(job)+','+lit(unit)+',1);','authenticator',error='42501')
run(auth(worker)+'select _work_unit_contributors_shift('+lit(worker)+','+lit(shift)+',clock_timestamp());','authenticator',error='42501')
run(auth(worker)+'begin isolation level repeatable read;select work_unit_contributors_read('+lit(job)+','+lit(unit)+',1);','authenticator',error='25001')
for label,change,restore in (('retired','retired_at=clock_timestamp()','retired_at=null'),('revoked','access_revoked_at=clock_timestamp()','access_revoked_at=null'),('partner','is_partner=true','is_partner=false')):
 run('update profiles set '+change+' where id='+lit(reviewer)+';')
 run(auth(reviewer)+'select work_unit_contributors_read('+lit(job)+','+lit(unit)+',1);','authenticator',error='42501')
 run('update profiles set '+restore+' where id='+lit(reviewer)+';')
 check(True,'Genuine '+label+' caller cannot receive contributor identities')
for role in ('installer','foreman'):
 run("update profiles set role="+lit(role)+' where id='+lit(reviewer)+';')
 if role=='foreman':rpc('select work_grant_job_capability('+lit(ident(109))+','+lit(job)+','+lit(reviewer)+",'final_qc');")
 run(auth(reviewer)+'select work_unit_contributors_read('+lit(job)+','+lit(unit)+',1);','authenticator',error='42501')
run("update profiles set role='supervisor' where id="+lit(reviewer)+';')
check(contributors(reviewer)['availability']=='available','Real supervisor receives labor without finalQC grant')
run("update profiles set role='owner' where id="+lit(reviewer)+';')
def start(sql,user='authenticator'):
 proc=subprocess.Popen(['psql',uri(user),'-X','-q','-t','-A','-v','ON_ERROR_STOP=1'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,env=env)
 proc.stdin.write("\\set VERBOSITY verbose\nset statement_timeout='20s';set lock_timeout='12s';"+sql+'\n');proc.stdin.flush();return proc

def finish(proc,sql=''):
 if sql:proc.stdin.write(sql+'\n');proc.stdin.flush()
 proc.stdin.close();proc.stdin=None;out,err=proc.communicate(timeout=25);assert proc.returncode==0,err[-2200:];return out

def until(sql,timeout=5):
 end=time.monotonic()+timeout
 while time.monotonic()<end:
  if run(sql)=='t':return True
  time.sleep(.015)
 return False
# A genuine source-change transaction holds G; blocked read must refresh grants.
a=start("set application_name='contributors_permission_holder';begin;select _work_activity_gate();update projects set deleted_at=clock_timestamp() where id="+lit(job)+';','postgres')
try:
 assert until("select exists(select 1 from pg_stat_activity where application_name='contributors_permission_holder' and state='idle in transaction')")
 b=start("set application_name='contributors_permission_waiter';"+auth(worker)+'select work_unit_contributors_read('+lit(job)+','+lit(unit)+');')
 assert until("select exists(select 1 from pg_stat_activity a join pg_stat_activity b on a.datname=b.datname where a.application_name='contributors_permission_holder' and b.application_name='contributors_permission_waiter' and a.pid=any(pg_blocking_pids(b.pid)))")
 finish(a,'commit;');answer=json.loads(finish(b).splitlines()[-1]);check(answer=={'protocolVersion':1,'availability':'unavailable','contributors':None},'Observed G wait refreshes hidden scope before IDs or counts')
finally:
 if a.poll() is None:a.terminate();a.wait(timeout=3)
run('update projects set deleted_at=null where id='+lit(job)+';')
# Fresh actor and name checks after a real profile mutation holding G.
def stop_safely(proc):
 if proc is not None and proc.poll() is None:proc.terminate();proc.wait(timeout=3)
def finish_expected(proc,code):
 proc.stdin.close();proc.stdin=None;out,err=proc.communicate(timeout=25)
 assert proc.returncode and re.search(r'\b'+code+r'\b',err),(out,err[-1800:])
for scenario in ('role_revoke','rename'):
 a=b=None
 try:
  change="role='installer'" if scenario=='role_revoke' else "display_name='After G rename'"
  a=start("set application_name='contributors_profile_holder';begin;update profiles set "+change+' where id='+lit(worker)+';','postgres')
  assert until("select exists(select 1 from pg_stat_activity where application_name='contributors_profile_holder' and state='idle in transaction')")
  b=start("set application_name='contributors_profile_waiter';"+auth(worker)+'select work_unit_contributors_read('+lit(job)+','+lit(unit)+',1);')
  assert until("select exists(select 1 from pg_stat_activity a join pg_stat_activity b on a.datname=b.datname where a.application_name='contributors_profile_holder' and b.application_name='contributors_profile_waiter' and a.pid=any(pg_blocking_pids(b.pid)))")
  finish(a,'commit;')
  if scenario=='role_revoke':finish_expected(b,'42501');check(True,'Observed G wait rechecks real supervisor role before names')
  else:
   answer=json.loads(finish(b).splitlines()[-1]);check(answer['contributors']['people'][0]['displayName']=='After G rename','Observed G wait resolves fresh permitted name at one asOf')
 finally:
  stop_safely(a);stop_safely(b)
 run("update profiles set role='owner',display_name='Contributors PG worker' where id="+lit(worker)+';')
persist('volume_setup')
run('insert into opening_phases(id,opening_id,kind,status,started_at,submitted_at,minutes) values('+lit(ident(80))+','+lit(opening)+",'flashing','submitted',now()-interval '2 hours',now()-interval '1 hour',0);")
run("insert into task_sessions(id,project_id,profile_id,state,started_at,ended_at) values("+lit(ident(90))+','+lit(job)+','+lit(reviewer)+",'on_task',now()-interval '2 hours',now()-interval '1 hour');")
parent=run('select id from personal_activity_transitions where source_shift_id='+lit(shift)+' order by revision_after limit 1')
def seed_insert(table,lo,hi,sql):
 report['pendingSeedBatch']={'table':table,'first':lo,'last':hi};persist('volume_seed')
 started=time.monotonic();inserted=int(run('with inserted as ('+sql+' returning 1) select count(*) from inserted;'))
 report['committedInsertedRows'][table]+=inserted
 report['seedBatches'].append({'table':table,'first':lo,'last':hi,'insertedRows':inserted,'wallMs':(time.monotonic()-started)*1000})
 report.pop('pendingSeedBatch',None);persist()
 assert inserted==hi-lo+1,(table,lo,hi,inserted)
def verify_seed_counts(rows,changes):
 counts=obj("select jsonb_build_object('projectOpenings',(select count(*) from project_openings where project_id="+lit(other)+" and opening_code like 'CONTRIBUTORS-PG-U-%'),'openingPhases',(select count(*) from opening_phases p join project_openings o on o.id=p.opening_id where o.project_id="+lit(other)+" and o.opening_code like 'CONTRIBUTORS-PG-U-%'),'transitionSources',(select count(*) from personal_activity_transition_sources e join opening_phases p on p.id=e.source_id join project_openings o on o.id=p.opening_id where e.transition_id="+lit(parent)+" and e.source_kind='phase' and e.relation='phase_participation' and o.project_id="+lit(other)+" and o.opening_code like 'CONTRIBUTORS-PG-U-%'),'unitTargetChanges',(select count(*) from work_activity_source_history where source_kind='opening_phases' and source_id="+lit(ident(80))+" and before_value<>'{}'::jsonb and after_value<>'{}'::jsonb and before_value->'minutes' is distinct from after_value->'minutes'),'sameJobTaskRetainedChanges',(select count(*) from work_activity_source_history where source_kind='task_sessions' and source_id="+lit(ident(90))+" and before_value<>'{}'::jsonb and after_value<>'{}'::jsonb and before_value->'ended_at' is distinct from after_value->'ended_at'))")
 report['verifiedSeedCounts']=counts;persist()
 check(counts=={'projectOpenings':rows,'openingPhases':rows,'transitionSources':rows,'unitTargetChanges':changes,'sameJobTaskRetainedChanges':changes},'Actual complete seed census for '+str(rows)+' unrelated rows and '+str(changes)+' target changes')
previous_rows=previous_changes=0
for rows,changes in ((0,0),(1000,100),(10000,1000)):
 # Every normal row trigger still fires. Small committed statements bound only
 # seed work; measurement/clock statement and lock limits remain20s/12s.
 for lo in range(previous_rows+1,rows+1,SEED_BATCH_SIZE):
  hi=min(rows,lo+SEED_BATCH_SIZE-1);series=' from generate_series('+str(lo)+','+str(hi)+')g'
  seed_insert('project_openings',lo,hi,"insert into project_openings(id,project_id,opening_code) select md5('contributors-pg-opening-'||g)::uuid,"+lit(other)+",'CONTRIBUTORS-PG-U-'||g"+series)
  seed_insert('opening_phases',lo,hi,"insert into opening_phases(id,opening_id,kind,status,started_at,submitted_at,minutes) select md5('contributors-pg-phase-'||g)::uuid,md5('contributors-pg-opening-'||g)::uuid,'flashing','submitted',now()-interval '2 hours',now()-interval '1 hour',60"+series)
  seed_insert('personal_activity_transition_sources',lo,hi,"insert into personal_activity_transition_sources(transition_id,profile_id,source_kind,source_id,relation,before_evidence,after_evidence) select "+lit(parent)+','+lit(worker)+",'phase',md5('contributors-pg-phase-'||g)::uuid,'phase_participation','{}',jsonb_build_object('opening_id',md5('contributors-pg-opening-'||g)::uuid,'project_id',"+lit(other)+"::uuid)"+series)
 for lo in range(previous_changes+1,changes+1,SEED_BATCH_SIZE):
  hi=min(changes,lo+SEED_BATCH_SIZE-1);report['pendingSeedBatch']={'table':'target_changes','first':lo,'last':hi};persist('volume_seed');started=time.monotonic()
  run('do $$declare changed bigint;begin for n in '+str(lo)+'..'+str(hi)+' loop update opening_phases set minutes=n where id='+lit(ident(80))+";get diagnostics changed=row_count;if changed<>1 then raise exception 'Target phase missing';end if;update task_sessions set ended_at=ended_at+interval '1 microsecond' where id="+lit(ident(90))+";get diagnostics changed=row_count;if changed<>1 then raise exception 'Target task missing';end if;end loop;end$$;")
  report['seedBatches'].append({'table':'target_changes','first':lo,'last':hi,'phaseMutations':hi-lo+1,'taskMutations':hi-lo+1,'wallMs':(time.monotonic()-started)*1000});report.pop('pendingSeedBatch',None);persist()
 verify_seed_counts(rows,changes)
 run('analyze work_activity_source_history;analyze personal_activity_transition_sources;analyze opening_phases;')
 for mode in ('unit',):
  samples=[];report['currentMeasurement']={'mode':mode,'unrelatedLiveRows':rows,'targetChanges':changes,'samplesMs':samples};persist('volume_measurement')
  for _ in range(10):
   measure=rpc("create temp table totals_measure(ms double precision,value jsonb);do $$declare t timestamptz;r jsonb;begin t:=clock_timestamp();r:=work_unit_contributors_read("+lit(job)+','+lit(unit if mode=='unit' else None)+");insert into totals_measure values(extract(epoch from clock_timestamp()-t)*1000,r);end$$;select jsonb_build_object('ms',ms,'value',value) from totals_measure;")
   assert measure['value']['availability']=='available';samples.append(measure['ms']);persist()
  samples.sort();plan=json.loads(run("explain(analyze,buffers,format json) select source_id from work_activity_source_history where source_kind in ('custom_work_sessions','service_time_sessions','time_shifts','task_sessions','project_openings') and before_value->>'project_id'="+lit(job)))
  rpc_plan=json.loads(run(auth(worker)+'explain(analyze,buffers,format json) select work_unit_contributors_read('+lit(job)+','+lit(unit)+',1);','authenticator'))
  tier={'rpcExplain':rpc_plan,'mode':mode,'unrelatedLiveRows':rows,'unrelatedTransitionSources':rows,'unitTargetRetainedChanges':changes,'sameJobTaskRetainedChanges':changes,'samplesMs':samples,'medianMs':statistics.median(samples),'p95Ms':samples[-1],'maxMs':max(samples),'lookupExplain':plan};report['tiers'].append(tier);report.pop('currentMeasurement',None);persist();print('VOLUME',json.dumps(tier),flush=True)
 previous_rows,previous_changes=rows,changes
# One real RPC, not an idle transaction or a synthetic pg_sleep. Observe the
# payroll blocking edge while that exact RPC remains active. Two attempts max.
observed_modes={}
persist('active_read_payroll_waits')
for mode in ('unit',):
 observed=False
 for attempt in range(2):
  a=b=None;report['currentWaitAttempt']={'mode':mode,'attempt':attempt+1};persist()
  try:
   a=start("set application_name='contributors_active_reader';"+auth(worker)+'select work_unit_contributors_read('+lit(job)+','+lit(unit if mode=='unit' else None)+');')
   active=until("select exists(select 1 from pg_stat_activity a join pg_locks l on l.pid=a.pid where a.application_name='contributors_active_reader' and a.state='active' and l.locktype='advisory' and l.classid=7710 and l.granted)",2)
   if not active:finish(a);continue
   before=time.monotonic();b=start("set application_name='contributors_actual_payroll';"+auth(worker)+'select to_jsonb(start_break('+lit(shift)+"::uuid,'rest'::text));")
   observed=until("select exists(select 1 from pg_stat_activity a join pg_stat_activity b on a.datname=b.datname where a.application_name='contributors_active_reader' and a.state='active' and b.application_name='contributors_actual_payroll' and a.pid=any(pg_blocking_pids(b.pid)))",2)
   read_answer=json.loads(finish(a).splitlines()[-1]);pay_answer=json.loads(finish(b).splitlines()[-1]);assert read_answer['availability']=='available' and pay_answer['break_started_at'] is not None
   report['activeReadPayrollWaits'][mode]={'observed':observed,'requestWallMs':(time.monotonic()-before)*1000,'holderWasActive':observed,'controlledIdleHold':False};persist()
   resumed=rpc('select to_jsonb(end_break('+lit(shift)+'::uuid));');assert resumed['break_started_at'] is None
   if observed:break
  finally:
   for proc in (a,b):
    if proc is not None and proc.poll() is None:proc.terminate();proc.wait(timeout=3)
 observed_modes[mode]=observed;report['activeReadWaitGate']=dict(observed_modes);report.pop('currentWaitAttempt',None);persist()
persist('final_payroll_out')
closed=rpc('select to_jsonb(clock_out('+lit(shift)+'::uuid,null::text,false,true,null::integer,null::double precision,null::double precision,null::text));')
check(closed['clock_out_at'] is not None,'Break/end-break/out remain actual successful payroll operations')
report['checks']=checks;report['activeReadWaitGate']=observed_modes
assert all(observed_modes.values()),'Execution gate unresolved: no real active-read payroll blocking edge observed in two bounded attempts; no artificial hold substituted'
final_contribution=contributors()['contributors'];check(not final_contribution['includesLive'] and int(final_contribution['unitKnownMicros'])>0,'Closed positive contribution never continues growing');check(sum(int(p['knownMicros']) for p in final_contribution['people'])==int(final_contribution['unitKnownMicros']),'Genuine exact people sum equals unit denominator');report['status']='passed';persist('complete');print(json.dumps(report),flush=True)
