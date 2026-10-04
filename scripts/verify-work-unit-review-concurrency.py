#!/usr/bin/env python3
"""Actual PG17 logins and observed review waits after the engine role fixture.
Requires its exact fresh disposable localhost database; never provider SQL.
"""
import hashlib,json,os,re,subprocess,sys,time
from pathlib import Path
from urllib.parse import urlparse,urlunparse
ROOT=Path(__file__).resolve().parent.parent
SOURCE=ROOT/'supabase/migrations/20261108440000_work_unit_review.sql'
source=SOURCE.read_text();source_hash=hashlib.sha256(source.encode()).hexdigest()
assert re.search(r'rollback;\s*$',source)
assert sys.argv[1:] in ([],['--check-plan'])
if sys.argv[1:]==['--check-plan']:
 print(json.dumps({'result':'PLAN VALIDATED','databaseTests':False,'sourceSha256':source_hash,'predecessor':'verify-work-activity-engine-role-parity.py','plannedObservedWaits':['fact CAS','original source hidden','grant revoked','actor revoked','duplicate receipt','unit row']}));sys.exit(0)
url=os.environ.get('WORK_ACTIVITY_ROLE_TEST_DB_URL','');p=urlparse(url)
try: port=p.port
except ValueError:raise SystemExit('Invalid local fixture URL')
if p.scheme not in ('postgres','postgresql') or p.hostname not in ('localhost','127.0.0.1') or port not in (None,5432) or p.path!='/forge_work_activity_role_test' or p.username!='supabase_admin' or p.query or p.fragment:
 raise SystemExit('Refused: exact disposable localhost role fixture required')
env={k:v for k,v in os.environ.items() if not k.startswith('PG')};env['PGCONNECT_TIMEOUT']='3'
def uri(user):return urlunparse((p.scheme,f'{user}:fixture-only@{p.hostname}:{port or 5432}',p.path,'','',''))
def ql(v):return "'"+str(v).replace("'","''")+"'"
checks=0

def run(sql,user='postgres',error=None):
 global checks
 r=subprocess.run(['psql',uri(user),'-X','-q','-t','-A','-v','ON_ERROR_STOP=1'],input="\\set VERBOSITY sqlstate\nset statement_timeout='12s';set lock_timeout='8s';\n"+sql,text=True,capture_output=True,timeout=30,env=env)
 if error:
  assert r.returncode and re.search(r'\b'+error+r'\b',r.stderr),(error,r.stderr[-1000:]);checks+=1;return
 assert r.returncode==0,r.stderr[-1600:];return r.stdout.strip()
def obj(sql,user='postgres'):return json.loads(run(sql,user).splitlines()[-1])
def check(v,label):
 global checks
 assert v,label;checks+=1

def id(n):return '00000000-0000-4000-8000-'+str(12000+n).zfill(12)
owner,reviewer,foreman,worker=[id(n) for n in range(1,5)];job,other=id(10),id(11);opening,unit=id(20),id(30)
def auth(actor):return 'set role authenticated;set request.jwt.claim.sub='+ql(actor)+';'
def read(actor=reviewer):return obj(auth(actor)+'begin read only;select work_unit_review_read('+ql(unit)+');commit;','authenticator')
def payload(action,data,actor=reviewer):return {'action':action,'basis':read(actor)['review']['basis'],'data':data}
def sql_command(cid,pay):return 'select work_unit_review_command('+ql(cid)+',1,'+ql(json.dumps(pay))+'::jsonb);'
def command(cid,pay,actor=reviewer):return obj(auth(actor)+sql_command(cid,pay),'authenticator')
check(run("select (session_user='postgres' and not (select rolsuper from pg_roles where rolname=session_user))::int")=='1','Actual nonsuperuser source owner login')
check(run("select (session_user='authenticator' and not (select rolsuper from pg_roles where rolname=session_user) and not (select rolinherit from pg_roles where rolname=session_user))::int",'authenticator')=='1','Actual noninheriting caller login')
check(run('select current_database()')=='forge_work_activity_role_test','Exact disposable database')
check(run("select current_setting('server_version_num')::int/10000")=='17','Actual PG17')
check(run("select to_regprocedure('public.work_unit_review_read(uuid)') is null")=='t','Review-free predecessor required')
run(re.sub(r'rollback;\s*$','commit;',source))
check(run('select _work_unit_review_coverage()')=='t','Genuine-role installed source contract matches')
run('insert into auth.users(id) values '+','.join('('+ql(x)+')' for x in (owner,reviewer,foreman,worker))+';insert into profiles(id,display_name,role,is_test) values '+','.join('('+ql(x)+",'Synthetic review',"+ql(role)+',false)' for x,role in [(owner,'owner'),(reviewer,'owner'),(foreman,'foreman'),(worker,'installer')])+';')
run("insert into projects(id,job_code,name) values("+ql(job)+",'REVIEW-PG','Review synthetic'),("+ql(other)+",'REVIEW-PG-OTHER','Review synthetic other');insert into project_openings(id,project_id,opening_code) values("+ql(opening)+','+ql(job)+",'ONE');")
unit_data={'id':unit,'revision':0,'project_id':job,'opening_id':opening,'label':'Synthetic unit','type_label':'Window','facts':{},'dimension_observation':{'width':36,'height':48,'unit':'in','source':'estimated'},'expected_fact_revision':0}
run(auth(owner)+'select custom_work_command('+ql(id(100)) +",'unit',"+ql(json.dumps(unit_data))+'::jsonb);','authenticator')
check(read()['review']['capabilities']['verifyDimensions'],'Real reviewer capability')
verification=payload('verify_dimensions',{'widthDecimal':'3','heightDecimal':'4','unit':'ft','source':'plans','sourceReference':None})
receipt=command(id(101),verification)
check(command(id(101),verification)==receipt,'Actual immutable receipt replay')
run(auth(owner)+sql_command(id(101),verification),'authenticator','42501')
for action,n in [('submit',102),('pass',103)]:command(id(n),payload(action,{'note':None}))
check(read()['review']['qc']['qcAccepted'],'Actual authenticated exact-basis pass accepted')
for table in ['work_activity_source_history','work_unit_review_commands','work_unit_dimension_verifications','work_unit_review_events','work_unit_review_current','work_unit_review_defects','work_unit_review_defect_events']:
 run(auth(reviewer)+'select * from '+table,'authenticator','42501')
run(auth(reviewer)+'begin isolation level repeatable read;select work_unit_review_read('+ql(unit)+')','authenticator','25001')
run(auth(reviewer)+'begin isolation level serializable;select work_unit_review_read('+ql(unit)+')','authenticator','25001')
run(auth(owner)+'select work_grant_job_capability('+ql(id(110))+','+ql(job)+','+ql(foreman)+",'dimensions_edit');select work_grant_job_capability("+ql(id(111))+','+ql(job)+','+ql(foreman)+",'final_qc');",'authenticator')
# Same foreman may submit and pass their own work. Independent dimensions remain separate.
command(id(112),payload('submit',{'note':None},foreman),foreman);command(id(113),payload('pass',{'note':None},foreman),foreman)
check(read(foreman)['review']['qc']['qcAccepted'],'Authorized foreman self final QC allowed')
processes=[];edges=0

def start(sql,user):
 r=subprocess.Popen(['psql',uri(user),'-X','-q','-t','-A','-v','ON_ERROR_STOP=1'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,env=env)
 processes.append(r);r.stdin.write('\\set VERBOSITY sqlstate\n'+sql+'\n');r.stdin.flush();return r

def finish(r,sql=''):
 if sql:r.stdin.write(sql+'\n');r.stdin.flush()
 r.stdin.close();r.stdin=None;return r.communicate(timeout=12)

def race(name,holder_sql,reader_sql,error=None,holder_user='postgres',g=True):
 global edges
 aa='review_holder_'+name;bb='review_waiter_'+name
 a=start("set application_name="+ql(aa)+";set statement_timeout='10s';begin;"+('select _work_activity_gate();' if g else '')+holder_sql,holder_user)
 deadline=time.monotonic()+4
 while time.monotonic()<deadline:
  if a.poll() is not None:raise AssertionError(a.stderr.read())
  if run("select exists(select 1 from pg_stat_activity where application_name="+ql(aa)+" and state='idle in transaction')::int")=='1':break
  time.sleep(.03)
 else:raise AssertionError('Holder barrier absent')
 b=start('set application_name='+ql(bb)+';'+reader_sql,'authenticator')
 deadline=time.monotonic()+4
 while time.monotonic()<deadline:
  if b.poll() is not None:raise AssertionError('No wait: '+b.stderr.read())
  if run("select exists(select 1 from pg_stat_activity a join pg_stat_activity b on a.datname=b.datname where a.application_name="+ql(aa)+' and b.application_name='+ql(bb)+" and a.pid<>b.pid and a.pid=any(pg_blocking_pids(b.pid)))::int")=='1':edges+=1;break
  time.sleep(.03)
 else:raise AssertionError('No actual blocking edge')
 _,ae=finish(a,'commit;');assert a.returncode==0,ae
 bo,be=finish(b)
 if error:check(b.returncode!=0 and re.search(r'\b'+error+r'\b',be),'Fresh post-wait '+name);check(not bo.strip(),'Refusal discloses no result');return
 check(b.returncode==0,'Successful waiter '+name+': '+be);return json.loads(bo.splitlines()[-1])
try:
 pay=payload('verify_dimensions',verification['data']);new_data={**unit_data,'revision':1,'expected_fact_revision':1,'dimension_observation':{'width':37,'height':48,'unit':'in','source':'estimated'}}
 edit="set request.jwt.claim.sub="+ql(owner)+';select custom_work_command('+ql(id(120))+",'unit',"+ql(json.dumps(new_data))+'::jsonb);'
 race('fact',edit,auth(reviewer)+sql_command(id(121),pay),'40001')
 # Original source closure remains required after a canonical relink.
 moved={**new_data,'revision':2,'project_id':other,'opening_id':None,'reason':'Synthetic relink'};moved.pop('dimension_observation');moved.pop('expected_fact_revision');moved['facts']=obj('select facts from custom_work_units where id='+ql(unit))
 run(auth(owner)+'select custom_work_command('+ql(id(122))+",'link',"+ql(json.dumps(moved))+'::jsonb);','authenticator')
 pay=payload('submit',{'note':None})
 race('original_hidden','update projects set deleted_at=clock_timestamp() where id='+ql(job)+';',auth(reviewer)+sql_command(id(123),pay),'42501')
 run('update projects set deleted_at=null where id='+ql(job)+';')
 run(auth(owner)+'select work_grant_job_capability('+ql(id(124))+','+ql(other)+','+ql(foreman)+",'dimensions_edit');",'authenticator')
 pay=payload('verify_dimensions',{'widthDecimal':'37','heightDecimal':'48','unit':'in','source':'measured','sourceReference':None},foreman)
 grant=run("select id from work_job_management_grants where profile_id="+ql(foreman)+' and project_id='+ql(job)+" and capability='dimensions_edit' and revoked_at is null")
 revoke=auth(owner)+'select work_revoke_job_capability('+ql(id(125))+','+ql(job)+','+ql(foreman)+",'dimensions_edit',"+ql(grant)+');'
 race('grant',revoke,auth(foreman)+sql_command(id(126),pay),'42501',holder_user='authenticator',g=False)
 pay=payload('submit',{'note':None})
 race('actor','update profiles set access_revoked_at=clock_timestamp() where id='+ql(reviewer)+';',auth(reviewer)+sql_command(id(127),pay),'42501')
 run('update profiles set access_revoked_at=null where id='+ql(reviewer)+';')
 pay=payload('submit',{'note':None});cid=id(128)
 duplicate=race('duplicate',auth(reviewer)+sql_command(cid,pay),auth(reviewer)+sql_command(cid,pay),holder_user='authenticator',g=False)
 check(duplicate==command(cid,pay),'Waiting same UUID returns same applied receipt')
 pay=payload('reopen',{'note':None})
 row=race('unit_row','select id from custom_work_units where id='+ql(unit)+' for update;',auth(reviewer)+sql_command(id(129),pay),g=False)
 check(row['outcome']=='applied','Unit row wait completes without parent lock inversion')
 check(edges==6,'Six independent backend waits observed')
finally:
 for proc in processes:
  if proc.poll() is None:
   proc.terminate()
   try:proc.wait(timeout=2)
   except subprocess.TimeoutExpired:proc.kill();proc.wait(timeout=2)
# Independent-review regression: actual phase-only subject, not a session worker.
phase_worker,phase=id(1000),id(1001)
run('insert into auth.users(id) values('+ql(phase_worker)+');insert into profiles(id,display_name,role,is_test) values('+ql(phase_worker)+",'Phase-only synthetic','installer',false);")
run('insert into opening_phases(id,opening_id,kind,status,started_by,started_at,submitted_at) values('+ql(phase)+','+ql(opening)+",'flashing','submitted',"+ql(phase_worker)+",now()-interval '2 minutes',now()-interval '1 minute');")
for action,n in [('submit',1010),('pass',1011)]:command(id(n),payload(action,{'note':None}))
check(read()['review']['qc']['qcAccepted'],'Genuine clean phase-only source accepts')
run("update personal_activity_state set integrity_state='review' where profile_id="+ql(phase_worker)+';')
phase_view=read()['review'];check(phase_view['qc']['lifecycle']=='unproven' and not phase_view['qc']['qcAccepted'],'Genuine phase-only dirty state fails closed')
run("update personal_activity_state set integrity_state='clean',revision=9007199254740991 where profile_id="+ql(phase_worker)+";update opening_phases set submitted_at=submitted_at+interval '1 second' where id="+ql(phase)+';')
check(run("select count(*) from work_activity_safety_events where source_kind='phase' and source_id="+ql(phase)+" and profile_id="+ql(phase_worker))=='1','Genuine engine emits exact phase safety')
run("update personal_activity_state set integrity_state='clean',revision=1 where profile_id="+ql(phase_worker)+';')
check(read()['review']['qc']['lifecycle']=='unproven','Genuine retained safety survives clean current state')
for action,n in [('submit',1012),('pass',1013)]:command(id(n),payload(action,{'note':None}))
phase_view=read()['review'];check(phase_view['qc']['acceptance']=='recorded_only' and not phase_view['qc']['qcAccepted'],'Genuine phase safety pass is recorded only')
# A separate clean unit isolates capture-hole checks from the safety fixture.
hole_unit,hole_opening,hole_session=id(1020),id(1021),id(1022)
run('insert into project_openings(id,project_id,opening_code) values('+ql(hole_opening)+','+ql(job)+",'CAPTURE-HOLE');")
hole_data={**unit_data,'id':hole_unit,'opening_id':hole_opening}
run(auth(owner)+'select custom_work_command('+ql(id(1023))+",'unit',"+ql(json.dumps(hole_data))+'::jsonb);','authenticator')
def hole_read():return obj(auth(reviewer)+'select work_unit_review_read('+ql(hole_unit)+');','authenticator')['review']
check(hole_read()['qc']['lifecycle']=='proven','Genuine clean hole fixture begins proven')
run('alter table unit_sessions disable trigger zz_work_activity_row;insert into unit_sessions(id,opening_id,profile_id,started_at,ended_at) values('+ql(hole_session)+','+ql(hole_opening)+','+ql(worker)+",now()-interval '2 hours',now()-interval '1 hour');alter table unit_sessions enable trigger zz_work_activity_row;")
check(run('select _work_unit_review_coverage()')=='t','Genuine restored trigger catalog matches')
check(hole_read()['qc']['lifecycle']=='unproven','Genuine uncaptured live interval fails closed')
run('delete from unit_sessions where id='+ql(hole_session)+';')
check(run("select bool_and(legacy_baseline) from work_activity_source_history where source_kind='unit_sessions' and source_id="+ql(hole_session))=='t','Genuine later deletion retains unknown origin')
check(hole_read()['qc']['lifecycle']=='unproven','Genuine deleted hole cannot regain proof')
# Causal source order: an earlier XID can perform its write after a newer XID.
latest_unit,latest_opening,latest_phase=id(1100),id(1101),id(1102)
run('insert into project_openings(id,project_id,opening_code) values('+ql(latest_opening)+','+ql(job)+",'LATEST');")
latest_data={**unit_data,'id':latest_unit,'opening_id':latest_opening}
run(auth(owner)+'select custom_work_command('+ql(id(1103))+",'unit',"+ql(json.dumps(latest_data))+'::jsonb);','authenticator')
run('insert into opening_phases(id,opening_id,kind,status,started_at,submitted_at,minutes) values('+ql(latest_phase)+','+ql(latest_opening)+",'flashing','submitted',now()-interval '2 minutes',now()-interval '1 minute',701);")
def latest_read():return obj(auth(reviewer)+'select work_unit_review_read('+ql(latest_unit)+');','authenticator')['review']
a=start("set application_name='review_older_xid';begin;select pg_current_xact_id();",'postgres')
deadline=time.monotonic()+4
while time.monotonic()<deadline:
 if run("select exists(select 1 from pg_stat_activity where application_name='review_older_xid' and state='idle in transaction')::int")=='1':break
 time.sleep(.03)
else:raise AssertionError('Older XID barrier absent')
run('update opening_phases set minutes=702 where id='+ql(latest_phase)+';')
ao,ae=finish(a,'update opening_phases set minutes=701 where id='+ql(latest_phase)+';commit;');check(a.returncode==0,'Older XID later write succeeds: '+ae)
check(run("select (h.transaction_id<p.transaction_id)::int from work_activity_source_history h join work_activity_source_history p on p.id=h.predecessor_id where h.source_kind='opening_phases' and h.source_id="+ql(latest_phase)+" and not exists(select 1 from work_activity_source_history n where n.predecessor_id=h.id)")=='1','Actual XID order reverses causal append order')
check(latest_read()['qc']['lifecycle']=='proven','Legitimate captured reversal with older XID stays proven')
run('update opening_phases set minutes=702 where id='+ql(latest_phase)+';alter table opening_phases disable trigger zz_work_activity_row;update opening_phases set minutes=701 where id='+ql(latest_phase)+';alter table opening_phases enable trigger zz_work_activity_row;')
check(latest_read()['qc']['lifecycle']=='unproven','Genuine bypassed prior-value reversal fails latest proof')
run('update opening_phases set minutes=703 where id='+ql(latest_phase)+';')
check(run("select legacy_baseline::int from work_activity_source_history where source_kind='opening_phases' and source_id="+ql(latest_phase)+" and after_value->>'minutes'='703'")=='1','Genuine next captured write preserves predecessor mismatch')
check(latest_read()['qc']['lifecycle']=='unproven','Genuine next captured write cannot heal bypass')
print(json.dumps({'result':'PASS','checks':checks,'observedBlockingEdges':edges,'reviewSha256':source_hash,'scope':'Actual PG17 source-owner/authenticator logins; provider/JWT transport excluded'}))
