#!/usr/bin/env python3
"""PG17 real-login catalog acceptance after verify-work-activity-engine-role-parity.py.

The predecessor must have assembled 0841 in its exact disposable role database.
This runner never connects to the operational database or bootstraps roles.
"""
import atexit
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time
from urllib.parse import urlparse, urlunparse

ROOT = Path(__file__).resolve().parent.parent
CATALOG = ROOT/'supabase/migrations/20261108420000_work_activity_catalog.sql'
CUTOVER = ROOT/'supabase/migrations/20261108410000_work_activity_engine_cutover.sql'
assert hashlib.sha256(CATALOG.read_bytes()).hexdigest() == 'a97e733bd06c4ea8632ed330b02ffb14d90cad748395dcbc7a3cfafbf178d002'
assert hashlib.sha256(CUTOVER.read_bytes()).hexdigest() == 'e2c57266fa2f63e345b8ce232d737c7810c7e9509334b9abae56d7c8b77b5d15'
assert sys.argv[1:] in ([], ['--check-plan'])
if sys.argv[1:] == ['--check-plan']:
    print(json.dumps({'result':'PLAN VALIDATED','databaseTests':False,'predecessor':'verify-work-activity-engine-role-parity.py on fresh PG17 role fixture'}))
    sys.exit(0)

url = os.environ.get('WORK_ACTIVITY_ROLE_TEST_DB_URL','')
try:
    parsed = urlparse(url);port = parsed.port
except ValueError:
    raise SystemExit('Refused invalid local fixture URL')
if (parsed.scheme not in ('postgres','postgresql') or parsed.hostname not in ('localhost','127.0.0.1')
    or port not in (None,5432) or parsed.path != '/forge_work_activity_role_test'
    or parsed.username != 'supabase_admin' or parsed.query or parsed.fragment):
    raise SystemExit('Refused: exact localhost role-fixture URL and supabase_admin bootstrap login required')
env={k:v for k,v in os.environ.items() if not k.startswith('PG')};env['PGCONNECT_TIMEOUT']='3'
def uri(user):
    return url if user=='supabase_admin' else urlunparse((parsed.scheme,f'{user}:fixture-only@{parsed.hostname}:{port or 5432}',parsed.path,'','',''))
def ql(s):return "'"+str(s).replace("'","''")+"'"
def call(sql,user='postgres',error=None,timeout=30):
    result=subprocess.run(['psql',uri(user),'-X','-q','-t','-A','-v','ON_ERROR_STOP=1'],
      input="\\set VERBOSITY sqlstate\nset statement_timeout='12s';set lock_timeout='8s';\n"+sql,
      text=True,capture_output=True,timeout=timeout,env=env)
    if error:
        assert result.returncode and re.search(r'\b'+error+r'\b',result.stderr),(error,result.stderr[-500:])
        return None
    assert result.returncode==0,result.stderr[-900:]
    return result.stdout.strip()
def obj(sql,user='postgres'):
    lines=call(sql,user).splitlines();assert len(lines)==1,lines
    return json.loads(lines[0])
def auth(uid):return 'set role authenticated;set request.jwt.claim.sub='+ql(uid)+';'
def read(uid,job,unit=None,readonly=True):
    sql=auth(uid)+('begin isolation level read committed read only;' if readonly else '')
    sql+='select work_activity_catalog('+ql(job)+','+(ql(unit) if unit else 'null')+');'
    if readonly:sql+='commit;'
    return obj(sql,'authenticator')
def unavailable(v):
    assert sorted(v)==sorted(('protocolVersion','asOf','availability','projectId','unit','selection','totals'))
    assert v['availability']=='unavailable' and v['projectId'] is None and v['unit'] is None and v['selection'] is None
    assert v['totals']=={'availability':'unavailable','reasonCode':'not_ready'}

assert call('select current_database()')=='forge_work_activity_role_test'
assert call("select (to_regprocedure('public.work_activity_command(uuid,integer,jsonb)') is not null and to_regclass('public.work_activity_authority_generation') is not null)::int")=='1', 'Complete predecessor assembly is required'
assert call("select (session_user='postgres' and not (select rolsuper from pg_roles where rolname=session_user))::int",'postgres')=='1'
assert call("select (session_user='authenticator' and not (select rolsuper from pg_roles where rolname=session_user))::int",'authenticator')=='1'
assert call("select to_regprocedure('public.work_activity_catalog(uuid,uuid)') is null")=='t','Fresh catalog-free predecessor required'
call(CATALOG.read_text(),'postgres')
checks=5
base='00000000-0000-4000-8000-000000005'
def ident(n):return base+f'{n:03d}'
owner,crew,supervisor,qa,partner,revoked,foreman=[ident(n) for n in range(1,8)]
job,sandbox,deleted=[ident(n) for n in (10,11,12)]
values=','.join('('+ql(x)+')' for x in (owner,crew,supervisor,qa,partner,revoked,foreman))
call('insert into auth.users(id) values '+values+';','postgres')
profiles=[(owner,'owner','false','false'),(crew,'installer','false','false'),(supervisor,'supervisor','false','false'),(qa,'installer','true','false'),(partner,'supervisor','false','true'),(revoked,'owner','false','false'),(foreman,'foreman','false','false')]
call('insert into profiles(id,display_name,role,is_test,is_partner) values '+','.join('('+ql(p)+','+ql('Catalog fixture')+','+ql(role)+','+test+','+partner_flag+')' for p,role,test,partner_flag in profiles)+';','postgres')
call('update profiles set access_revoked_at=clock_timestamp() where id='+ql(revoked)+';','postgres')
call("insert into projects(id,job_code,name,is_test) values ("+ql(job)+",'CAT-REAL','Catalog real fixture',false),("+ql(sandbox)+",'CAT-QA','Catalog QA fixture',true),("+ql(deleted)+",'CAT-DELETED','Deleted fixture',false);",'postgres')
call('insert into sandbox_projects(project_id) values('+ql(sandbox)+');update projects set deleted_at=clock_timestamp() where id='+ql(deleted)+';','postgres')
names=call("select relname from pg_class where relnamespace='public'::regnamespace and relkind='r' and (relname like 'work_%' or relname like 'personal_activity_%') order by relname").splitlines()
assert len(names)>=15
source_names=['auth.users','public.profiles','public.projects','public.sandbox_projects','public.project_openings','public.custom_work_units']
def counts():
    private=[call('select count(*) from public."'+name+'"') for name in names]
    source=[call('select count(*) from '+name) for name in source_names]
    return private+source
before=counts()
for uid in (owner,crew,supervisor,foreman):
    v=read(uid,job);assert v['availability']=='available' and v['projectId']==job and v['selection'] is None;checks+=1
unavailable(read(crew,sandbox));unavailable(read(crew,deleted));unavailable(read(qa,job));checks+=3
assert read(qa,sandbox)['availability']=='available';checks+=1
assert counts()==before;checks+=1
for uid in (partner,revoked):call(auth(uid)+'select work_activity_catalog('+ql(job)+',null);','authenticator','42501');checks+=1
call('set role anon;select work_activity_catalog('+ql(job)+',null);','authenticator','42501');checks+=1
for isolation in ('repeatable read','serializable'):
    call(auth(crew)+'begin isolation level '+isolation+';select work_activity_catalog('+ql(job)+',null);','authenticator','25001');checks+=1

# Publish through the genuine owner API, then pin two immutable menu versions.
# No direct configuration writes or permissive fixture helpers are used.
def owner_json(expression):return obj(auth(owner)+'select '+expression+';','authenticator')
def json_arg(value):return ql(json.dumps(value,separators=(',',':')))+'::jsonb'
fields=[{'id':'truth','label_en':'True?','label_es':'Verdad?','type':'boolean','required':True}]
general1=owner_json("work_publish_activity_version("+ql(ident(100))+",'catalog_real_general',0,'general','Original general','General original',false,"+json_arg(fields)+")")
specific=owner_json("work_publish_activity_version("+ql(ident(101))+",'catalog_real_specific',0,'specific','Specific unit','Unidad especifica',false,'[]'::jsonb)")
general_id=call("select id from work_activity_definitions where code='catalog_real_general'")
specific_id=call("select id from work_activity_definitions where code='catalog_real_specific'")
items1=[{'definitionId':general_id,'versionId':general1['versionId'],'position':0,'enabled':True},
        {'definitionId':specific_id,'versionId':specific['versionId'],'position':1,'enabled':True}]
menu1=owner_json("work_publish_menu_version("+ql(ident(102))+",'catalog_real_menu',0,'Menu one','Menu uno',"+json_arg(items1)+")")
selected1=owner_json('work_select_job_menu('+ql(ident(103))+','+ql(job)+','+ql(menu1['versionId'])+',0)')
old=read(foreman,job)
assert old['selection']['selectionId']==selected1['selectionId'] and old['selection']['menuVersionId']==menu1['versionId']
assert old['selection']['eligibleNow'] and len(old['selection']['activities'])==2
assert old['selection']['activities'][0]['labelEn']=='Original general' and old['selection']['activities'][0]['eligibleNow']
assert old['selection']['activities'][1]['ineligibleReason']=='unit_required'
assert old['totals']=={'availability':'unavailable','reasonCode':'not_ready'}
checks+=1
read_counts=counts()
for uid in (owner,crew,foreman):
    assert read(uid,job)['selection']['selectionId']==selected1['selectionId'];checks+=1
assert counts()==read_counts;checks+=1
general2=owner_json("work_publish_activity_version("+ql(ident(104))+",'catalog_real_general',1,'general','New general','General nuevo',false,"+json_arg(fields)+")")
items2=[dict(items1[0],versionId=general2['versionId']),items1[1]]
menu2=owner_json("work_publish_menu_version("+ql(ident(105))+",'catalog_real_menu',1,'Menu two','Menu dos',"+json_arg(items2)+")")
assert read(foreman,job)['selection']['activities'][0]['labelEn']=='Original general';checks+=1

# Genuine independent backends: holder commits a changed source while the
# authenticated reader waits on G. An observed pg_blocking_pids edge is required.
processes=[]
def start(sql,user):
    p=subprocess.Popen(['psql',uri(user),'-X','-q','-t','-A','-v','ON_ERROR_STOP=1'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,env=env)
    processes.append(p);p.stdin.write("\\set VERBOSITY sqlstate\nset statement_timeout='12s';set lock_timeout='8s';\n"+sql+'\n');p.stdin.flush();return p
def finish(p,more=''):
    if more:p.stdin.write(more+'\n');p.stdin.flush()
    p.stdin.close();p.stdin=None
    out,err=p.communicate(timeout=15)
    return p.returncode,out.strip(),err
def cleanup():
    for p in processes:
        if p.poll() is None:
            p.terminate()
            try:p.wait(timeout=2)
            except subprocess.TimeoutExpired:p.kill();p.wait(timeout=2)
atexit.register(cleanup)
wait_edges=0
def ready(proc,app):
    deadline=time.monotonic()+5
    while time.monotonic()<deadline:
        assert proc.poll() is None,app+' exited before its transaction barrier'
        if call('select count(*) from pg_stat_activity where application_name='+ql(app)+" and state='idle in transaction'")=='1':return
        time.sleep(.03)
    raise AssertionError(app+' did not reach its transaction barrier')
def observe(holder,reader,holder_app,reader_app,lock_class,gate_owner=None):
    global wait_edges
    deadline=time.monotonic()+5
    while time.monotonic()<deadline:
        assert all(p.poll() is None for p in (holder,reader)),'Race process exited before wait'
        n=call("select count(*) from pg_stat_activity h join pg_stat_activity r on r.datname=h.datname "
          "join pg_locks held on held.pid=h.pid and held.locktype='advisory' and held.granted "
          "join pg_locks wanted on wanted.pid=r.pid and wanted.locktype='advisory' and not wanted.granted "
          "where h.application_name="+ql(holder_app)+" and r.application_name="+ql(reader_app)+
          " and h.pid=any(pg_blocking_pids(r.pid)) and held.classid="+str(lock_class)+"::oid "
          "and wanted.classid=held.classid and held.objid=0::oid and wanted.objid=held.objid"+
          (" and exists(select 1 from pg_locks gate where gate.pid="+
           ("r.pid" if gate_owner=='waiter' else "h.pid")+
           " and gate.locktype='advisory' and gate.granted and gate.classid=7712::oid and gate.objid=0::oid)"
           if gate_owner else ''),'postgres',timeout=4)
        if n=='1':wait_edges+=1;return
        time.sleep(.03)
    raise AssertionError('No observed advisory blocking PID edge: '+holder_app+' / '+reader_app)
holder=start("set application_name='catalog_holder';begin;select _work_activity_gate();update profiles set access_revoked_at=clock_timestamp() where id="+ql(crew)+';','postgres')
ready(holder,'catalog_holder')
reader=start("set application_name='catalog_reader';"+auth(crew)+'select work_activity_catalog('+ql(job)+',null);','authenticator')
observe(holder,reader,'catalog_holder','catalog_reader',7712)
code,out,err=finish(holder,'commit;');assert code==0,err[-500:]
code,out,err=finish(reader);assert code and re.search(r'\b42501\b',err) and not out,(code,out,err[-500:]);checks+=1

# Forward configuration order: owner commits selection while the reader has G
# and waits on 7710. After release, the read sees the newly selected version.
select2='select work_select_job_menu('+ql(ident(106))+','+ql(job)+','+ql(menu2['versionId'])+',1);'
holder=start("set application_name='catalog_select_holder';"+auth(owner)+'begin;'+select2,'authenticator')
ready(holder,'catalog_select_holder')
reader=start("set application_name='catalog_select_reader';"+auth(foreman)+'begin isolation level read committed read only;select work_activity_catalog('+ql(job)+',null);commit;','authenticator')
observe(holder,reader,'catalog_select_holder','catalog_select_reader',7710,'waiter')
code,out,err=finish(holder,'commit;');assert code==0,err[-500:]
selected2=json.loads(out)
code,out,err=finish(reader);assert code==0,err[-500:]
after_select=json.loads(out)
assert after_select['selection']['selectionId']==selected2['selectionId']
assert after_select['selection']['menuVersionId']==menu2['versionId']
assert after_select['selection']['activities'][0]['labelEn']=='New general'
checks+=1

# Reverse order: the reader finishes its SELECT while holding the read-only
# transaction. The owner then waits on that reader's 7710 lock. The delivered
# response is a coherent old selection; the next read sees the committed new one.
reader=start("set application_name='catalog_reverse_reader';"+auth(foreman)+'begin isolation level read committed read only;select work_activity_catalog('+ql(job)+',null);','authenticator')
ready(reader,'catalog_reverse_reader')
select3='select work_select_job_menu('+ql(ident(107))+','+ql(job)+','+ql(menu1['versionId'])+',2);'
holder=start("set application_name='catalog_reverse_holder';"+auth(owner)+'begin;'+select3+'commit;','authenticator')
observe(reader,holder,'catalog_reverse_reader','catalog_reverse_holder',7710,'holder')
code,out,err=finish(reader,'commit;');assert code==0,err[-500:]
reverse_old=json.loads(out)
assert reverse_old['selection']['selectionId']==selected2['selectionId'] and reverse_old['selection']['activities'][0]['labelEn']=='New general';checks+=1
code,out,err=finish(holder);assert code==0,err[-500:]
selected3=json.loads(out)
reverse_new=read(foreman,job)
assert reverse_new['selection']['selectionId']==selected3['selectionId'] and reverse_new['selection']['activities'][0]['labelEn']=='Original general';checks+=1

# Enabled-child retirement is a second actual configuration writer. Every
# enabled item in the frozen menu becomes ineligible after its 7710 wait.
retire='select work_retire_activity('+ql(ident(108))+",'catalog_real_specific',1);"
holder=start("set application_name='catalog_retire_holder';"+auth(owner)+'begin;'+retire,'authenticator')
ready(holder,'catalog_retire_holder')
reader=start("set application_name='catalog_retire_reader';"+auth(foreman)+'begin isolation level read committed read only;select work_activity_catalog('+ql(job)+',null);commit;','authenticator')
observe(holder,reader,'catalog_retire_holder','catalog_retire_reader',7710,'waiter')
code,out,err=finish(holder,'commit;');assert code==0,err[-500:]
code,out,err=finish(reader);assert code==0,err[-500:]
retired=json.loads(out)
assert not retired['selection']['eligibleNow'] and all(not item['eligibleNow'] for item in retired['selection']['activities']);checks+=1
post_counts=counts()
for uid in (owner,foreman):
    assert read(uid,job)['selection']['selectionId']==selected3['selectionId'];checks+=1
assert counts()==post_counts;checks+=1
assert wait_edges==4;checks+=1
print(json.dumps({'result':'PASS','checks':checks,'privateTables':len(names),'sourceTables':len(source_names),'observedBlockingEdges':wait_edges,'scope':'PG17 local genuine authenticator and postgres logins, selected immutable General/Specific, read-only and observed G/config waits; no production or provider JWT verification'}))
