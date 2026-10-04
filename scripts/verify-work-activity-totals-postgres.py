#!/usr/bin/env python3
"""Genuine PG17 roles, scope revocation race and active-read payroll wait.
Runs only after the actual engine + 0844 role fixtures in a disposable local DB.
--check-plan validates source/dependencies but is NOT database execution evidence.
"""
import hashlib,json,os,re,subprocess,sys,time,statistics
from pathlib import Path
from urllib.parse import urlparse,urlunparse
ROOT=Path(__file__).resolve().parent.parent
source=(ROOT/'supabase/migrations/20261108450000_work_activity_totals.sql').read_text()
review=(ROOT/'supabase/migrations/20261108440000_work_unit_review.sql').read_text()
sha=hashlib.sha256(source.encode()).hexdigest()
assert re.search(r'rollback;\s*$',source)
assert hashlib.sha256(review.encode()).hexdigest()=='e32122a581bf995857983cc433323bc490381b6eb217c583bf95fd7376b3e53f'
assert sys.argv[1:] in ([],['--check-plan'])
if sys.argv[1:]==['--check-plan']:
 print(json.dumps({'result':'PLAN VALIDATED','databaseTests':False,'sourceSha256':sha,'predecessor':'verify-work-unit-review-concurrency.py','tiers':[[0,0],[1000,100],[10000,1000]],'waits':['G held by actual source permission change then read rechecks','unit and General real active totals RPC holding G/7710 versus actual start_break; two attempts each, no idle holder'], 'timeoutsSeconds':{'statement':20,'lock':12},'requiredEvidence':['actual authenticator/postgres session_user','EXPLAIN ANALYZE BUFFERS','median/p95/max','pg_blocking_pids active holder','payroll break/resume/out success']}));sys.exit()
p=urlparse(os.environ.get('WORK_ACTIVITY_ROLE_TEST_DB_URL',''))
if p.scheme not in ('postgres','postgresql') or p.hostname not in ('localhost','127.0.0.1') or p.port not in (None,5432) or p.path!='/forge_work_activity_role_test' or p.username!='supabase_admin' or p.query or p.fragment:raise SystemExit('Refused: exact disposable localhost role fixture required')
env={k:v for k,v in os.environ.items() if not k.startswith('PG')};env['PGCONNECT_TIMEOUT']='3'
def uri(user):return urlunparse((p.scheme,f'{user}:fixture-only@{p.hostname}:{p.port or 5432}',p.path,'','',''))
def lit(v):return 'null' if v is None else "'"+str(v).replace("'","''")+"'"
def ident(n):return '00000000-0000-4000-8000-'+str(350000+n).zfill(12)
checks=0
def run(sql,user='postgres',error=None):
 global checks
 r=subprocess.run(['psql',uri(user),'-X','-q','-t','-A','-v','ON_ERROR_STOP=1'],input="\\set VERBOSITY sqlstate\nset statement_timeout='20s';set lock_timeout='12s';"+sql,text=True,capture_output=True,timeout=30,env=env)
 if error:assert r.returncode and re.search(r'\b'+error+r'\b',r.stderr),(error,r.stderr[-2000:]);checks+=1;return
 assert r.returncode==0,r.stderr[-2200:];return r.stdout.strip()
def obj(sql,user='postgres'):return json.loads(run(sql,user).splitlines()[-1])
def check(value,label):
 global checks
 assert value,label;checks+=1;print('PASS',checks,label,flush=True)
def auth(actor):return 'set role authenticated;set request.jwt.claim.sub='+lit(actor)+';'
worker,reviewer,job,other,opening,unit,device,generation=[ident(x) for x in (1,2,10,11,20,30,40,41)]
def rpc(sql,actor=worker):return obj(auth(actor)+sql,'authenticator')
def totals(actor=worker,mode='unit'):return rpc('select work_activity_totals_read('+lit(job)+','+lit(unit if mode=='unit' else None)+');',actor)
check(run("select session_user='postgres' and not (select rolsuper from pg_roles where rolname=session_user)")=='t','Actual nonsuperuser owner session')
check(run("select session_user='authenticator' and not (select rolsuper or rolinherit from pg_roles where rolname=session_user)",'authenticator')=='t','Actual noninheriting authenticator session')
check(run("select current_setting('server_version_num')::int/10000")=='17','Actual PostgreSQL17')
check(run('select _work_unit_review_coverage()')=='t','Frozen review dependency coverage')
check(run("select to_regprocedure('public.work_activity_totals_read(uuid,uuid)') is null")=='t','Clean totals installation seam')
run(re.sub(r'rollback;\s*$','commit;',source))
coverage=run('select _work_totals_coverage()')
if coverage!='t':
 diagnostic=(ROOT/'scripts/dry-run-probes/work-activity-totals-coverage-diagnostic.fragment.sql').read_text().strip().removesuffix(';')
 print('TOTALS_COVERAGE_DIAGNOSTIC',json.dumps(obj('select coalesce(jsonb_agg(to_jsonb(d)),\'[]\'::jsonb) from ('+diagnostic+') d')),flush=True)
check(coverage=='t','Exact totals installed source guard')
run('insert into auth.users(id) values('+lit(worker)+'),('+lit(reviewer)+');insert into profiles(id,display_name,role,is_test) values('+lit(worker)+",'Totals PG worker','owner',false),("+lit(reviewer)+",'Totals PG reviewer','owner',false);insert into projects(id,job_code,name) values("+lit(job)+",'TOTALS-PG','Synthetic'),("+lit(other)+",'TOTALS-PG-OTHER','Synthetic');insert into project_openings(id,project_id,opening_code) values("+lit(opening)+','+lit(job)+",'TOTALS-PG-UNIT'),("+lit(ident(21))+','+lit(other)+",'TOTALS-PG-UNRELATED');")
unit_payload={'id':unit,'revision':0,'project_id':job,'opening_id':opening,'label':'Synthetic PG totals','type_label':'Window','facts':{},'dimension_observation':{'width':36,'height':48,'unit':'in','source':'estimated'},'expected_fact_revision':0}
rpc('select custom_work_command('+lit(ident(100))+",'unit',"+lit(json.dumps(unit_payload))+'::jsonb);')
rpc('select work_publish_activity_version('+lit(ident(101))+",'totals_pg_specific',0,'specific','Totals PG','Totals PG',false,'[]');")
definition=obj("select to_jsonb(v) from work_activity_definition_versions v join work_activity_definitions d on d.id=v.definition_id where d.code='totals_pg_specific'")
rpc('select work_publish_menu_version('+lit(ident(102))+",'totals_pg_menu',0,'Totals PG','Totals PG',"+lit(json.dumps([{'definitionId':definition['definition_id'],'versionId':definition['id'],'position':0,'enabled':True}]))+'::jsonb);')
menu=run("select v.id from work_capture_menu_versions v join work_capture_menus m on m.id=v.menu_id where m.code='totals_pg_menu'")
rpc('select work_select_job_menu('+lit(ident(103))+','+lit(job)+','+lit(menu)+',0);')
selection=obj('select to_jsonb(s) from work_job_menu_selections s where project_id='+lit(job))
run("select _work_activity_gate();update work_activity_authority_generation set capture_enabled=true,revision=revision+1;insert into toolbox_completions(profile_id,signed_at,typed_name) values("+lit(worker)+",clock_timestamp(),'Synthetic');")
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
basis=obj('select _work_activity_command_basis(_work_activity_unit_basis('+lit(unit)+','+lit(worker)+'));')
command({'kind':'switch','projectId':job,'selectionId':selection['id'],'selectionRevision':selection['revision'],'menuVersionId':menu,'definitionVersionId':definition['id'],'scope':'specific','unit':basis,'machineKind':None,'values':{}})
check(totals()['totals']['activities'][0]['personal']['includesLive'],'Actual own confirmed live source')
check(totals(reviewer)['totals']['activities']==[],'Another actor gets no fabricated open elapsed')
for role in ('anon','service_role'):
 run('set role '+role+';select work_activity_totals_read('+lit(job)+','+lit(unit)+');','authenticator',error='42501')
run(auth(worker)+'select _work_totals_source(\'custom_work_units\','+lit(unit)+');','authenticator',error='42501')
run(auth(worker)+'begin isolation level repeatable read;select work_activity_totals_read('+lit(job)+','+lit(unit)+');','authenticator',error='25000')

# Genuine-role privacy: a separate worker's actual closed setup/payroll ledger
# plus guarded source safety remains private to an installer reading General.
run("insert into toolbox_completions(profile_id,signed_at,typed_name) values("+lit(reviewer)+",clock_timestamp(),'Synthetic privacy');")
coworker_shift=rpc('select to_jsonb(clock_in('+lit(job)+'::uuid,null::uuid,null::text,null::double precision,null::double precision,null::text,null::text,'+lit(ident(105))+"::uuid,clock_timestamp()-interval '1 minute',clock_timestamp(),0,1));",reviewer)['id']
rpc('select to_jsonb(clock_out('+lit(coworker_shift)+'::uuid,null::text,false,true,null::integer,null::double precision,null::double precision,null::text));',reviewer)
run('insert into opening_phases(id,opening_id,kind,status,started_by,started_at,submitted_at,minutes) values('+lit(ident(91))+','+lit(ident(21))+",'flashing','submitted',"+lit(reviewer)+",now()-interval '2 hours',now()-interval '1 hour',60);")
privacy_revision=run('select revision from personal_activity_state where profile_id='+lit(reviewer))
run('update personal_activity_state set revision=9007199254740991 where profile_id='+lit(reviewer)+";update opening_phases set submitted_at=submitted_at+interval '1 second' where id="+lit(ident(91))+';')
check(run('select count(*) from work_activity_safety_events where profile_id='+lit(reviewer)+' and source_id='+lit(ident(91)))=='1','Actual guarded coworker safety event for privacy proof')
run('update personal_activity_state set revision='+privacy_revision+",integrity_state='clean' where profile_id="+lit(reviewer)+";update profiles set role='foreman' where id="+lit(reviewer)+';')
rpc('select work_grant_job_capability('+lit(ident(106))+','+lit(job)+','+lit(reviewer)+",'final_qc');")
run("update profiles set role='installer' where id="+lit(worker)+';')
installer_reconciliation=totals(mode='general')['totals']['reconciliation']
check(installer_reconciliation['scope']=='personal' and installer_reconciliation['ledgerCount']==1 and 'source_safety' not in installer_reconciliation['issues'],'Actual installer login cannot read coworker payroll or safety reconciliation')
foreman_reconciliation=totals(actor=reviewer,mode='general')['totals']['reconciliation']
check(foreman_reconciliation['scope']=='authorized_scope' and foreman_reconciliation['ledgerCount']==2 and 'source_safety' in foreman_reconciliation['issues'],'Actual currently granted foreman gets permitted aggregate reconciliation')

def start(sql,user='authenticator'):
 proc=subprocess.Popen(['psql',uri(user),'-X','-q','-t','-A','-v','ON_ERROR_STOP=1'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,env=env)
 proc.stdin.write("set statement_timeout='20s';set lock_timeout='12s';"+sql+'\n');proc.stdin.flush();return proc

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
a=start("set application_name='totals_permission_holder';begin;select _work_activity_gate();update projects set deleted_at=clock_timestamp() where id="+lit(job)+';','postgres')
try:
 assert until("select exists(select 1 from pg_stat_activity where application_name='totals_permission_holder' and state='idle in transaction')")
 b=start("set application_name='totals_permission_waiter';"+auth(worker)+'select work_activity_totals_read('+lit(job)+','+lit(unit)+');')
 assert until("select exists(select 1 from pg_stat_activity a join pg_stat_activity b on a.datname=b.datname where a.application_name='totals_permission_holder' and b.application_name='totals_permission_waiter' and a.pid=any(pg_blocking_pids(b.pid)))")
 finish(a,'commit;');answer=json.loads(finish(b).splitlines()[-1]);check(answer=={'protocolVersion':1,'availability':'unavailable','totals':None},'Observed G wait refreshes hidden scope before IDs or counts')
finally:
 if a.poll() is None:a.terminate();a.wait(timeout=3)
run('update projects set deleted_at=null where id='+lit(job)+';')
report={'sourceSha256':sha,'scope':'Actual PG17 disposable localhost roles; no provider operations','timeoutsSeconds':{'statement':20,'lock':12},'tiers':[]}
run('insert into opening_phases(id,opening_id,kind,status,started_at,submitted_at,minutes) values('+lit(ident(80))+','+lit(opening)+",'flashing','submitted',now()-interval '2 hours',now()-interval '1 hour',0);")
run("insert into task_sessions(id,project_id,profile_id,state,started_at,ended_at) values("+lit(ident(90))+','+lit(job)+','+lit(reviewer)+",'on_task',now()-interval '2 hours',now()-interval '1 hour');")
parent=run('select id from personal_activity_transitions where source_shift_id='+lit(shift)+' order by revision_after limit 1')
previous_rows=previous_changes=0
for rows,changes in ((0,0),(1000,100),(10000,1000)):
 if rows>previous_rows:
  run("insert into project_openings(id,project_id,opening_code) select md5('totals-pg-opening-'||g)::uuid,"+lit(other)+",'TOTALS-PG-U-'||g from generate_series("+str(previous_rows+1)+','+str(rows)+')g;')
  run("insert into opening_phases(id,opening_id,kind,status,started_at,submitted_at,minutes) select md5('totals-pg-phase-'||g)::uuid,md5('totals-pg-opening-'||g)::uuid,'flashing','submitted',now()-interval '2 hours',now()-interval '1 hour',60 from generate_series("+str(previous_rows+1)+','+str(rows)+")g;")
  run("insert into personal_activity_transition_sources(transition_id,profile_id,source_kind,source_id,relation,before_evidence,after_evidence) select "+lit(parent)+','+lit(worker)+",'phase',md5('totals-pg-phase-'||g)::uuid,'phase_participation','{}',jsonb_build_object('opening_id',md5('totals-pg-opening-'||g)::uuid,'project_id',"+lit(other)+"::uuid) from generate_series("+str(previous_rows+1)+','+str(rows)+')g;')
 if changes>previous_changes:run('do $$begin for n in '+str(previous_changes+1)+'..'+str(changes)+' loop update opening_phases set minutes=n where id='+lit(ident(80))+";update task_sessions set ended_at=ended_at+interval '1 microsecond' where id="+lit(ident(90))+';end loop;end$$;')
 run('analyze work_activity_source_history;analyze personal_activity_transition_sources;analyze opening_phases;')
 for mode in ('unit','general'):
  samples=[]
  for _ in range(10):
   measure=rpc("create temp table totals_measure(ms double precision,value jsonb);do $$declare t timestamptz;r jsonb;begin t:=clock_timestamp();r:=work_activity_totals_read("+lit(job)+','+lit(unit if mode=='unit' else None)+");insert into totals_measure values(extract(epoch from clock_timestamp()-t)*1000,r);end$$;select jsonb_build_object('ms',ms,'value',value) from totals_measure;")
   assert measure['value']['availability']=='available';samples.append(measure['ms'])
  samples.sort();plan=json.loads(run("explain(analyze,buffers,format json) select source_id from work_activity_source_history where source_kind in ('custom_work_sessions','service_time_sessions','time_shifts','task_sessions','project_openings') and before_value->>'project_id'="+lit(job)))
  tier={'mode':mode,'unrelatedLiveRows':rows,'unrelatedTransitionSources':rows,'unitTargetRetainedChanges':changes,'generalTargetRetainedChanges':changes,'samplesMs':samples,'medianMs':statistics.median(samples),'p95Ms':samples[-1],'maxMs':max(samples),'lookupExplain':plan};report['tiers'].append(tier);print('VOLUME',json.dumps(tier),flush=True)
 previous_rows,previous_changes=rows,changes
# One real RPC, not an idle transaction or a synthetic pg_sleep. Observe the
# payroll blocking edge while that exact RPC remains active. Two attempts max.
observed_modes={}
report['activeReadPayrollWaits']={}
for mode in ('unit','general'):
 observed=False
 for attempt in range(2):
  a=b=None
  try:
   a=start("set application_name='totals_active_reader';"+auth(worker)+'select work_activity_totals_read('+lit(job)+','+lit(unit if mode=='unit' else None)+');')
   active=until("select exists(select 1 from pg_stat_activity a join pg_locks l on l.pid=a.pid where a.application_name='totals_active_reader' and a.state='active' and l.locktype='advisory' and l.classid=7710 and l.granted)",2)
   if not active:finish(a);continue
   before=time.monotonic();b=start("set application_name='totals_actual_payroll';"+auth(worker)+'select to_jsonb(start_break('+lit(shift)+"::uuid,'rest'::text));")
   observed=until("select exists(select 1 from pg_stat_activity a join pg_stat_activity b on a.datname=b.datname where a.application_name='totals_active_reader' and a.state='active' and b.application_name='totals_actual_payroll' and a.pid=any(pg_blocking_pids(b.pid)))",2)
   read_answer=json.loads(finish(a).splitlines()[-1]);pay_answer=json.loads(finish(b).splitlines()[-1]);assert read_answer['availability']=='available' and pay_answer['break_started_at'] is not None
   report['activeReadPayrollWaits'][mode]={'observed':observed,'requestWallMs':(time.monotonic()-before)*1000,'holderWasActive':observed,'controlledIdleHold':False}
   resumed=rpc('select to_jsonb(end_break('+lit(shift)+'::uuid));');assert resumed['break_started_at'] is None
   if observed:break
  finally:
   for proc in (a,b):
    if proc is not None and proc.poll() is None:proc.terminate();proc.wait(timeout=3)
 observed_modes[mode]=observed
closed=rpc('select to_jsonb(clock_out('+lit(shift)+'::uuid,null::text,false,true,null::integer,null::double precision,null::double precision,null::text));')
check(closed['clock_out_at'] is not None,'Break/end-break/out remain actual successful payroll operations')
report['checks']=checks;report['activeReadWaitGate']=observed_modes
if os.environ.get('WORK_ACTIVITY_TOTALS_VOLUME_OUT'):Path(os.environ['WORK_ACTIVITY_TOTALS_VOLUME_OUT']).write_text(json.dumps(report,indent=2)+'\n')
print(json.dumps(report),flush=True)
assert all(observed_modes.values()),'Execution gate unresolved: no real active-read payroll blocking edge observed in two bounded attempts; no artificial hold substituted'
